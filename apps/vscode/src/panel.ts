import * as vscode from 'vscode'
import type { PermissionMode } from '@workerdeck/protocol'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import {
  terminalAffordances,
  terminalMetrics,
  transcriptDensity,
  transcriptVariant,
  webviewHtml,
} from './webview-html.ts'
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
  /** What had been seen of this session last time it was on screen, for the
   * panel's catch-up. The store lives in `activate`; the panel only carries it
   * across the bridge. */
  unseen: (hostId: string, sessionId: string) => { itemCount: number; since: number } | undefined
  /** The panel became visible or hidden. Visibility is what makes a session
   * "read", so the watermark writer needs to hear about it. */
  visibilityChanged: () => void
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
  /** A focus asked for before the webview could take it (see `show`). */
  #focusPending = false
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

  /** Is the panel actually on screen? A hidden dock is not being read. */
  get visible(): boolean {
    return this.#view?.visible ?? false
  }

  /** Is this exactly what the panel is already showing? Load-bearing for
   * re-selection: the panel does not remount, so anything a caller tears down
   * "because the session changed" will not be rebuilt. */
  isShowing(hostId: string, sessionId: string): boolean {
    return this.#active?.sessionId === sessionId && this.#active.host.id === hostId
  }

  /**
   * Settings the panel needs on its **first paint**, stamped onto `#root` for the
   * webview to read synchronously — the same trick the section views use for
   * which section they are. A postMessage cannot do this job: the density decides
   * every row's height, so learning it one tick late reflows the whole transcript
   * in front of the reader.
   */
  #rootAttrs(): Record<string, string> {
    const cell = terminalMetrics()
    return {
      'data-density': transcriptDensity(),
      'data-variant': transcriptVariant(),
      // The cell for the same reason as the density: it decides every row's
      // height, and learning it one tick late reflows the whole transcript.
      'data-font-size': String(cell.fontSize),
      'data-line-height': String(cell.lineHeight),
      'data-affordances': terminalAffordances() ? 'on' : 'off',
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.#transports?.dispose()
    const post = (msg: HostToPanel) => void view.webview.postMessage(msg)
    this.#transports = new WebviewTransportHost(this.#store, post, (text) => this.#tapFrame(text))
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'main.js', this.#rootAttrs(), 0, {
      font: true,
    })
    view.webview.onDidReceiveMessage((msg: PanelToHost) => void this.#onMessage(msg))
    view.onDidChangeVisibility(() => this.#delegate.visibilityChanged())
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
      // A disposed panel is not showing anything: whatever was on screen stops
      // counting as read from here on.
      this.#delegate.visibilityChanged()
    })
  }

  /**
   * Show a session, or clear it with undefined.
   *
   * `focus` reveals the panel AND puts the caret in the composer — what clicking
   * a session in the sidebar means: you picked it in order to talk to it. This
   * used to be suppressed when the session was already on screen, on the theory
   * that a second click on a card is not a request to leave the list. That was
   * wrong in practice: re-clicking the active session is exactly how you go back
   * to typing at it, and having to click the card and then the field is one click
   * too many for the common case.
   */
  async show(active: ActiveSession | undefined, options: { focus?: boolean } = {}): Promise<void> {
    const existed = !!this.#view
    this.#active = active
    this.#onDidChangeActive.fire(active)
    // Focussing also materializes the view if the panel has never been opened,
    // which is why it happens even unasked for a first show.
    if (active && (options.focus || !existed)) {
      await vscode.commands.executeCommand(`${SessionPanelProvider.viewId}.focus`)
    }
    // Queued rather than posted: a panel opening for the first time has not said
    // `wd-ready` yet, and a focus request that arrives before the composer exists
    // is one that silently does nothing.
    if (active && options.focus) this.#focusPending = true
    this.#pushActive()
  }

  #pushActive(): void {
    if (!this.#view || !this.#ready) return
    const active = this.#active
    if (!active) {
      this.#post({ kind: 'wd-show-session', session: undefined })
      return
    }
    // After the session, never before: focusing a composer that is about to be
    // replaced by another session's would put the caret in a field on its way out.
    const focus = this.#focusPending
    this.#focusPending = false
    const base = apiUrl(active.host)
    if (!base) return
    this.#post({
      kind: 'wd-show-session',
      session: {
        baseUrl: base,
        sessionId: active.sessionId,
        hostName: active.host.name,
        unseen: this.#delegate.unseen(active.host.id, active.sessionId),
      },
    })
    if (focus) this.#post({ kind: 'wd-focus-composer' })
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


  /** Switch the live session's model / permission mode. Inert when the panel
   * has never been opened: with no webview there is no attach to command. */
  setModel(model?: string): void {
    this.#post({ kind: 'wd-set-model', model })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#post({ kind: 'wd-set-permission-mode', mode })
  }

  /** Re-render this webview from disk — the dev reloader after a rebuild, and
   * a font-setting change (the typeface is baked into the HTML). The webview
   * re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(
      view.webview,
      dist,
      'main.js',
      this.#rootAttrs(),
      ++this.#htmlVersion,
      { font: true },
    )
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
 *
 * A **relative** path is resolved here and only here: the webview matched the
 * text, but the session's cwd is host-side state. With no cwd there is nothing
 * to resolve against, so the click is a no-op rather than a guess at the root.
 */
async function openTranscriptPath(
  active: ActiveSession | undefined,
  clicked: string,
  line: number | undefined,
): Promise<void> {
  if (!active) return
  const path = resolveAgainstCwd(clicked, active.cwd)
  if (!path) return
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

/**
 * Turn a clicked path into an absolute one. Deliberately POSIX arithmetic and
 * not `node:path`: the cwd is the *gateway's*, so its separators are the
 * gateway's too, and a Windows extension host joining a remote session's cwd
 * with `\` would produce a path neither side has ever seen.
 */
function resolveAgainstCwd(clicked: string, cwd: string | undefined): string | undefined {
  if (clicked.startsWith('/')) return normalizePosix(clicked)
  if (!cwd) return undefined
  return normalizePosix(`${cwd.replace(/\/+$/, '')}/${clicked}`)
}

function normalizePosix(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}
