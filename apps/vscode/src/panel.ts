import * as vscode from 'vscode'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import { webviewHtml } from './webview-html.ts'
import type { HostToPanel, PanelToHost } from './bridge-protocol.ts'

export type ActiveSession = {
  host: GatewayHost
  sessionId: string
  cwd: string | undefined
}

export type PanelDelegate = {
  /** SessionPanel's onOpenPanel — the sidebar hosts those surfaces. */
  openPanel: (panel: SessionSurfacePanel) => Promise<void>
  /** Live vitals for the shown session — relayed to the sidebar's sections. */
  vitals: (vitals: SessionVitals) => void
}

/**
 * The bottom-panel agent surface — purely the conversation. `SessionPanel`
 * runs with `panelSurface: 'external'`: no dialogs, no `⋯` menu; every
 * would-be dialog intent and the live vitals flow OUT to the sidebar through
 * the delegate. The webview's client rides bridged transports executed here
 * (Node fetch / `ws` with the gateway's `Authorization` header — keys stay in
 * SecretStorage on this side of the boundary).
 *
 * One live attach per session, and this webview owns it. The notification tap
 * reads frames already crossing the bridge — never a second attach.
 */
export class SessionPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'workerdeck.sessionPanel'

  readonly #extensionUri: vscode.Uri
  readonly #store: HostStore
  readonly #delegate: PanelDelegate
  readonly #onDidChangeActive = new vscode.EventEmitter<ActiveSession | undefined>()
  readonly onDidChangeActive = this.#onDidChangeActive.event

  #view: vscode.WebviewView | undefined
  #ready = false
  #htmlVersion = 0
  #active: ActiveSession | undefined
  #transports: WebviewTransportHost | undefined

  constructor(extensionUri: vscode.Uri, store: HostStore, delegate: PanelDelegate) {
    this.#extensionUri = extensionUri
    this.#store = store
    this.#delegate = delegate
  }

  get active(): ActiveSession | undefined {
    return this.#active
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.#transports?.dispose()
    const post = (msg: HostToPanel) => void view.webview.postMessage(msg)
    this.#transports = new WebviewTransportHost(this.#store, post, (text) => this.#tapFrame(text))
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'main.js')
    view.webview.onDidReceiveMessage((msg: PanelToHost) => void this.#onMessage(msg))
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
    })
  }

  /** Show a session (revealing the panel), or clear it with undefined. */
  async show(active: ActiveSession | undefined): Promise<void> {
    this.#active = active
    this.#onDidChangeActive.fire(active)
    if (active) {
      // Focussing materializes the view if the panel has never been opened.
      await vscode.commands.executeCommand(`${SessionPanelProvider.viewId}.focus`)
    }
    this.#pushActive()
  }

  #pushActive(): void {
    if (!this.#view || !this.#ready) return
    const active = this.#active
    if (!active) {
      this.#post({ kind: 'wd-show-session', session: undefined })
      return
    }
    const base = apiUrl(active.host)
    if (!base) return
    this.#post({
      kind: 'wd-show-session',
      session: { baseUrl: base, sessionId: active.sessionId, hostName: active.host.name },
    })
  }

  #post(msg: HostToPanel): void {
    void this.#view?.webview.postMessage(msg)
  }

  async #onMessage(msg: PanelToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) return
    switch (msg.kind) {
      case 'wd-ready':
        this.#ready = true
        this.#pushActive()
        return
      case 'wd-open-path':
        return openTranscriptPath(this.#active, msg.path, msg.line)
      case 'wd-vitals':
        this.#delegate.vitals(msg.vitals)
        return
      case 'wd-open-panel':
        await this.#delegate.openPanel(msg.panel)
        return
    }
  }

  /**
   * Human-attention moments, sniffed from the frames already flowing to the
   * panel — no second attach. Approve/Deny act over REST (`resolvePermission`),
   * which is attach-independent by design.
   */
  #tapFrame(text: string): void {
    const active = this.#active
    if (!active) return
    // The visible panel already renders the prompt — a notification on top
    // would be noise. This exists for the user who is elsewhere.
    if (this.#view?.visible) return
    let frame: {
      type?: string
      event?: { type?: string; request?: { id?: string; toolName?: string; title?: string } }
    }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type !== 'event' || frame.event?.type !== 'permission_requested') return
    const request = frame.event.request
    const requestId = request?.id
    if (!requestId) return
    const title = `WorkerDeck (${active.host.name}): ${request?.title ?? `wants to run ${request?.toolName ?? 'a tool'}`}`
    void vscode.window.showWarningMessage(title, 'Approve', 'Deny', 'Open').then(async (choice) => {
      if (!choice) return
      if (choice === 'Open') {
        await vscode.commands.executeCommand(`${SessionPanelProvider.viewId}.focus`)
        return
      }
      const client = await clientFor(this.#store, active.host)
      if (!client) return
      try {
        await client.resolvePermission(active.sessionId, requestId, {
          behavior: choice === 'Approve' ? 'allow' : 'deny',
        })
      } catch {
        // Already resolved from the panel (or elsewhere) — nothing to report.
      }
    })
  }


  /** Dev hot-reload: re-render this webview from the freshly built bundle. The
   * webview re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'main.js', {}, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
    this.#onDidChangeActive.dispose()
  }
}

/**
 * A path clicked in the transcript. Loopback gateway → the file is on this
 * machine (in a Remote SSH window, "this machine" is the remote box — which is
 * exactly where a loopback gateway's files are): open it directly. Remote
 * gateway → a `workerdeck://` URI served by the FileSystemProvider.
 */
async function openTranscriptPath(
  active: ActiveSession | undefined,
  path: string,
  line: number | undefined,
): Promise<void> {
  if (!active || !path.startsWith('/')) return
  const uri = isLoopbackHost(active.host)
    ? vscode.Uri.file(path)
    : vscode.Uri.from({ scheme: 'workerdeck', authority: active.host.id.toLowerCase(), path })
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    const selection = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined
    await vscode.window.showTextDocument(doc, { preview: true, selection })
  } catch {
    void vscode.window.showWarningMessage(`WorkerDeck: could not open ${path}`)
  }
}
