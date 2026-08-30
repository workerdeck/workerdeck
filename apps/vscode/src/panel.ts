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
  /** SessionPanel's onOpenPanel — the sidebar hosts those surfaces. */
  openPanel: (panel: SessionSurfacePanel) => Promise<void>
  /** Live vitals for the shown session — relayed to the sidebar's sections. */
  vitals: (vitals: SessionVitals) => void
  /**
   * Which sub-agent the panel now has framed, or `undefined` for the session's own
   * conversation. Reported rather than inferred: `openSubagent` is not the only way
   * into a frame, nor the only way out, so a host tracking only its own requests
   * would be wrong within one click.
   */
  subagent: (toolUseId: string | undefined) => void
  /** What had been seen of this session last time it was on screen, for the panel's
   * catch-up. The store lives in `activate`. */
  unseen: (hostId: string, sessionId: string) => { itemCount: number; since: number } | undefined
  /** The panel became visible or hidden. Visibility is what makes a session
   * "read", so the watermark writer needs to hear about it. */
  visibilityChanged: () => void
}

/**
 * The bottom-panel agent surface — purely the conversation. `SessionPanel` runs with
 * `panelSurface: 'external'`, so every would-be dialog intent and the live vitals
 * flow out to the sidebar through the delegate. The webview's client rides bridged
 * transports executed here; keys stay in SecretStorage on this side of the boundary.
 *
 * **One live attach per session, and this webview owns it.** The notification tap
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
  /** A takeover asked for before the webview could take it — see `openSubagent`. */
  #subagentPending: string | undefined
  #subagentNonce = 0
  /** A row asked for before the webview could take it — see `reveal`. */
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

  /** Is the panel actually on screen? A hidden dock is not being read. */
  get visible(): boolean {
    return this.#view?.visible ?? false
  }

  /** Is this exactly what the panel is already showing? Load-bearing for
   * re-selection: the panel does not remount, so anything a caller tears down
   * "because the session changed" is not rebuilt. */
  isShowing(hostId: string, sessionId: string): boolean {
    return this.#active?.sessionId === sessionId && this.#active.host.id === hostId
  }

  /**
   * Settings the panel needs on its **first paint**, stamped onto `#root` for the
   * webview to read synchronously. A postMessage cannot do this job: these decide
   * every row's height, so learning them one tick late reflows the whole transcript
   * in front of the reader.
   */
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

  /**
   * Show a session, or clear it with undefined. `focus` reveals the panel *and* puts
   * the caret in the composer — including when the session is already on screen,
   * re-clicking the active card being exactly how you go back to typing at it.
   */
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

  /**
   * Adopt a session on activation without revealing anything. Deliberately not
   * `show()`, which materializes the view — always true on activation, so it would
   * force the dock open on every window start. This only seeds `#active`; the push
   * happens if and when VS Code re-resolves the view itself.
   */
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
    // After the session: an id only means something once the panel is on the transcript that
    // contains it. Order between these two is a non-question — each queue clears the other.
    this.#flushSubagent()
    this.#flushReveal()
  }

  /**
   * Hand the panel over to a sub-agent — the one picked in the sessions list. Queued
   * like the composer focus: a panel opening for the first time has not said
   * `wd-ready` yet. The queue holds one, because two clicks before the panel exists
   * are one destination.
   */
  openSubagent(toolUseId: string): void {
    this.#subagentPending = toolUseId
    // The mirror of the rule in `reveal` — see there.
    this.#revealPending = undefined
    this.#flushSubagent()
  }

  /**
   * Travel to a tool call in the conversation — the **task** picked in the sessions
   * list. Not `openSubagent` under another name: a task has no agent behind it, so
   * framing its tool-use id selects no items and draws an empty agent view.
   */
  reveal(toolUseId: string): void {
    this.#revealPending = toolUseId
    // One click picks ONE destination: a takeover still queued here would land after this
    // one and undo it.
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
        // A fresh webview has no frame open by construction, and the panel reports frame
        // *changes* only (it deliberately stays silent on mount) — so without this a panel
        // disposed while framed and reloaded would never contradict the value we still hold.
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

  /**
   * Human-attention moments, sniffed from the frames already flowing to the panel —
   * no second attach. Approve/Deny act over REST (`resolvePermission`), which is
   * attach-independent by design.
   */
  #tapFrame(text: string): void {
    const active = this.#active
    if (!active) {
      return
    }
    // The visible panel already renders the prompt; this exists for the user who is elsewhere.
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

  /** Switch the live session's model / permission mode. Inert when the panel has
   * never been opened: with no webview there is no attach to command. */
  setModel(model?: string): void {
    this.#post({ kind: 'wd-set-model', model })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#post({ kind: 'wd-set-permission-mode', mode })
  }

  /** Re-render this webview from disk — the dev reloader after a rebuild, and a
   * font-setting change (the typeface is baked into the HTML). The webview
   * re-announces `wd-ready`, which is what re-pushes its state. */
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

/**
 * A path clicked in the transcript. Loopback gateway → the file is on this machine
 * (in a Remote SSH window "this machine" is the remote box, which is exactly where a
 * loopback gateway's files are): open it directly. Remote gateway → a `workerdeck://`
 * URI. A relative path is resolved here and only here, the cwd being host-side state;
 * with no cwd the click is a no-op rather than a guess at the root.
 */
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

/**
 * Turn a clicked path into an absolute one. Deliberately POSIX arithmetic and not
 * `node:path`: the cwd is the *gateway's*, so a Windows extension host joining it
 * with `\` would produce a path neither side has ever seen.
 */
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
