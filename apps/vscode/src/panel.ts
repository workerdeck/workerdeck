import * as vscode from 'vscode'
import type { PermissionMode } from '@workerdeck/protocol'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import { panelFontSize, terminalAffordances, terminalMetrics, transcriptDensity, transcriptVariant, webviewHtml } from './webview-html.ts'
import type { HostToPanel, PanelToHost } from './bridge-protocol.ts'

export type ActiveSession = {
  host: GatewayHost
  sessionId: string
  cwd: string | undefined
}

export type PanelDelegate = {
  openPanel: (panel: SessionSurfacePanel) => Promise<void>
  vitals: (vitals: SessionVitals) => void
  subagent: (toolUseId: string | undefined) => void
  unseen: (hostId: string, sessionId: string) => { itemCount: number; since: number } | undefined
  visibilityChanged: () => void
}

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
  #focusPending = false
  #subagentPending: string | undefined
  #subagentNonce = 0
  #revealPending: string | undefined
  #revealNonce = 0
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

  get visible(): boolean {
    return this.#view?.visible ?? false
  }

  isShowing(hostId: string, sessionId: string): boolean {
    return this.#active?.sessionId === sessionId && this.#active.host.id === hostId
  }

  #rootAttrs(): Record<string, string> {
    const cell = terminalMetrics()
    return {
      'data-density': transcriptDensity(),
      'data-variant': transcriptVariant(),
      'data-panel-font-size': String(panelFontSize()),
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
      // A disposed panel is not showing anything: nothing counts as read from here on.
      this.#delegate.visibilityChanged()
    })
  }

  async show(active: ActiveSession | undefined, options: { focus?: boolean } = {}): Promise<void> {
    const existed = !!this.#view
    this.#active = active
    this.#onDidChangeActive.fire(active)
    // Focussing also materializes the view, which is why a first show does it unasked.
    if (active && (options.focus || !existed)) {
      await vscode.commands.executeCommand(`${SessionPanelProvider.viewId}.focus`)
    }
    // Queued rather than posted: a panel opening for the first time has not said `wd-ready` yet.
    if (active && options.focus) {
      this.#focusPending = true
    }
    this.#pushActive()
  }

  // Deliberately not `show()`, which materializes the view — on activation that would force the dock open on every window start.
  restoreActive(active: ActiveSession): void {
    if (this.#active) {
      return
    }
    this.#active = active
    this.#onDidChangeActive.fire(active)
    this.#pushActive()
  }

  #pushActive(): void {
    if (!this.#view || !this.#ready) {
      return
    }
    const active = this.#active
    if (!active) {
      this.#post({ kind: 'wd-show-session', session: undefined })
      return
    }
    // After the session, never before: a composer about to be replaced must not take the caret.
    const focus = this.#focusPending
    this.#focusPending = false
    const base = apiUrl(active.host)
    if (!base) {
      return
    }
    this.#post({
      kind: 'wd-show-session',
      session: {
        baseUrl: base,
        sessionId: active.sessionId,
        hostName: active.host.name,
        unseen: this.#delegate.unseen(active.host.id, active.sessionId),
      },
    })
    if (focus) {
      this.#post({ kind: 'wd-focus-composer' })
    }
    this.#flushSubagent()
    this.#flushReveal()
  }

  openSubagent(toolUseId: string): void {
    this.#subagentPending = toolUseId
    this.#revealPending = undefined
    this.#flushSubagent()
  }

  reveal(toolUseId: string): void {
    this.#revealPending = toolUseId
    this.#subagentPending = undefined
    this.#flushReveal()
  }

  #flushReveal(): void {
    if (!this.#view || !this.#ready) {
      return
    }
    const toolUseId = this.#revealPending
    if (!toolUseId) {
      return
    }
    this.#revealPending = undefined
    this.#post({ kind: 'wd-reveal-tool-use', toolUseId, nonce: ++this.#revealNonce })
  }

  #flushSubagent(): void {
    if (!this.#view || !this.#ready) {
      return
    }
    const toolUseId = this.#subagentPending
    if (!toolUseId) {
      return
    }
    this.#subagentPending = undefined
    // The nonce is what makes asking twice mean twice: `openSubagent` is a prop.
    this.#post({ kind: 'wd-open-subagent', toolUseId, nonce: ++this.#subagentNonce })
  }

  #post(msg: HostToPanel): void {
    void this.#view?.webview.postMessage(msg)
  }

  async #onMessage(msg: PanelToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) {
      return
    }
    switch (msg.kind) {
      case 'wd-ready': {
        this.#ready = true
        // Safe ahead of the flushes below: a queued frame is re-posted straight after.
        this.#delegate.subagent(undefined)
        this.#pushActive()
        return
      }
      case 'wd-open-path': {
        return openTranscriptPath(this.#active, msg.path, msg.line)
      }
      case 'wd-open-url': {
        return void vscode.env.openExternal(vscode.Uri.parse(msg.url))
      }
      case 'wd-vitals': {
        this.#delegate.vitals(msg.vitals)
        return
      }
      case 'wd-open-panel': {
        await this.#delegate.openPanel(msg.panel)
        return
      }
      case 'wd-subagent-open': {
        this.#delegate.subagent(msg.toolUseId)
        return
      }
    }
  }

  #tapFrame(text: string): void {
    const active = this.#active
    if (!active) {
      return
    }
    if (this.#view?.visible) {
      return
    }
    let frame: {
      type?: string
      event?: { type?: string; request?: { id?: string; toolName?: string; title?: string } }
    }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type !== 'event' || frame.event?.type !== 'permission_requested') {
      return
    }
    const request = frame.event.request
    const requestId = request?.id
    if (!requestId) {
      return
    }
    const title = `WorkerDeck (${active.host.name}): ${request?.title ?? `wants to run ${request?.toolName ?? 'a tool'}`}`
    void vscode.window.showWarningMessage(title, 'Approve', 'Deny', 'Open').then(async (choice) => {
      if (!choice) {
        return
      }
      if (choice === 'Open') {
        await vscode.commands.executeCommand(`${SessionPanelProvider.viewId}.focus`)
        return
      }
      const client = await clientFor(this.#store, active.host)
      if (!client) {
        return
      }
      try {
        await client.resolvePermission(active.sessionId, requestId, {
          behavior: choice === 'Approve' ? 'allow' : 'deny',
        })
      } catch {
        // Already resolved from the panel (or elsewhere) — nothing to report.
      }
    })
  }

  // Inert until the panel has been opened at least once: with no webview there is no attach to command.
  setModel(model?: string): void {
    this.#post({ kind: 'wd-set-model', model })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#post({ kind: 'wd-set-permission-mode', mode })
  }

  reloadWebview(): void {
    const view = this.#view
    if (!view) {
      return
    }
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'main.js', this.#rootAttrs(), ++this.#htmlVersion, { font: true })
  }

  dispose(): void {
    this.#transports?.dispose()
    this.#onDidChangeActive.dispose()
  }
}

// In a Remote SSH window "this machine" is the remote box, which is exactly where a loopback gateway's files are.
const openTranscriptPath = async (active: ActiveSession | undefined, clicked: string, line: number | undefined): Promise<void> => {
  if (!active) {
    return
  }
  const path = resolveAgainstCwd(clicked, active.cwd)
  if (!path) {
    return
  }
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

const resolveAgainstCwd = (clicked: string, cwd: string | undefined): string | undefined => {
  if (clicked.startsWith('/')) {
    return normalizePosix(clicked)
  }
  if (!cwd) {
    return undefined
  }
  return normalizePosix(`${cwd.replace(/\/+$/, '')}/${clicked}`)
}

const normalizePosix = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      out.pop()
    } else {
      out.push(part)
    }
  }
  return `/${out.join('/')}`
}
