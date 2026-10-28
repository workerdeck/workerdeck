import * as vscode from 'vscode'
import type { CatchUpFrom, PermissionMode, SessionRow } from '@workerdeck/protocol'
import { resolvePosix } from '@workerdeck/protocol'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl } from './hosts.ts'
import { isLocalHost } from './machine.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import {
  catchUpMode,
  showThinking,
  panelFontSize,
  terminalActionLabels,
  terminalAffordances,
  terminalMetrics,
  transcriptVariant,
} from './webview-html.ts'
import { WebviewHost, type WebviewSurface } from './webview-host.ts'
import type { HostToPanel, PanelToHost } from './bridge-protocol.ts'

export type SessionRef = {
  host: GatewayHost
  sessionId: string
  cwd: string | undefined
  // A past conversation of the session, shown read-only; absent is the current one.
  conversation?: number
}

export type SurfaceKind = 'panel' | 'editor'

export type AnySurface = SessionSurface<WebviewSurface>

export type SurfaceDelegate = {
  openPanel: (surface: AnySurface, panel: SessionSurfacePanel) => Promise<void>
  vitals: (surface: AnySurface) => void
  subagent: (surface: AnySurface) => void
  shell: (surface: AnySurface) => void
  unseen: (hostId: string, sessionId: string) => CatchUpFrom | undefined
  visibilityChanged: (surface: AnySurface) => void
  focused: (surface: AnySurface) => void
  peerRows: (hostId: string) => Record<string, SessionRow>
  goToCurrent: (surface: AnySurface, sessionId: string) => void
}


export function sameSession(a: SessionRef | undefined, hostId: string, sessionId: string, conversation?: number): boolean {
  return a?.sessionId === sessionId && a.host.id === hostId && a.conversation === conversation
}

// One session's webview, wherever VS Code draws it: the bottom Agent panel (a `WebviewView`) or an
// editor tab (a `WebviewPanel`). Everything the session needs from its host lives here; the two
// subclasses only differ in how they materialize, focus and persist.
export abstract class SessionSurface<V extends WebviewSurface> extends WebviewHost<PanelToHost, HostToPanel, V> {
  abstract readonly kind: SurfaceKind

  readonly #store: HostStore
  protected readonly delegate: SurfaceDelegate

  #focusPending = false
  // The single read-request slot: `openSubagent`, `reveal` and `openShell` go to different panel
  // APIs but at most one can ever be pending - asking for any withdraws the others. One slot
  // makes that mutual exclusion structural. The shared nonce is strictly increasing, so a
  // repeated ask of the same kind still reads as new on the webview side ("asking twice
  // means twice": `openSubagent`/`reveal`/`openShell` land in props).
  #pending: { kind: 'wd-open-subagent' | 'wd-reveal-tool-use' | 'wd-open-shell'; id: string } | undefined
  #pendingNonce = 0
  #session: SessionRef | undefined
  // The catch-up boundary, frozen when the session was taken on.
  //
  // It answers "where were you when you opened this?", so it cannot be re-read at push time: making the view
  // visible marks the session seen, and `show()` awaits the focus command in between. Re-reading afterwards
  // returned the mark that opening had just moved, which cost the recap seam, the dimming and the jump target.
  #unseen: CatchUpFrom | undefined
  #transports: WebviewTransportHost | undefined
  #peerRowsSent: string | undefined

  vitals: SessionVitals | undefined
  subagentToolUseId: string | undefined
  shellId: string | undefined

  protected readonly bundle = 'main.js'

  constructor(extensionUri: vscode.Uri, store: HostStore, delegate: SurfaceDelegate) {
    super(extensionUri)
    this.#store = store
    this.delegate = delegate
  }

  get session(): SessionRef | undefined {
    return this.#session
  }

  get visible(): boolean {
    return this.view?.visible ?? false
  }

  holds(hostId: string, sessionId: string, conversation?: number): boolean {
    return sameSession(this.#session, hostId, sessionId, conversation)
  }

  showsSession(hostId: string, sessionId: string): boolean {
    return this.#session?.sessionId === sessionId && this.#session.host.id === hostId
  }

  // Bring the surface on screen and give it keyboard focus.
  abstract focus(): Promise<void>

  protected override rootAttrs(): Record<string, string> {
    const cell = terminalMetrics()
    return {
      'data-variant': transcriptVariant(),
      'data-panel-font-size': String(panelFontSize()),
      'data-font-size': String(cell.fontSize),
      'data-line-height': String(cell.lineHeight),
      'data-affordances': terminalAffordances() ? 'on' : 'off',
      'data-action-labels': terminalActionLabels() ? 'on' : 'off',
      'data-catch-up': catchUpMode() ? 'on' : 'off',
      'data-thinking': showThinking() ? 'show' : 'hide',
    }
  }

  protected override htmlOptions(): { font?: boolean } {
    return { font: true }
  }

  protected override wire(_view: V): void {
    this.resetForReload()
  }

  protected override resetForReload(): void {
    this.#transports?.dispose()
    this.#transports = new WebviewTransportHost(
      this.#store,
      (msg) => this.post(msg),
      (text) => this.#tapFrame(text),
    )
  }

  protected override intercept(msg: PanelToHost): Promise<boolean> | boolean {
    return this.#transports?.handle(msg) ?? false
  }

  protected override onViewDisposed(): void {
    this.#transports?.dispose()
    // A disposed surface is not showing anything: nothing counts as read from here on.
    this.delegate.visibilityChanged(this)
  }

  // Take a session on (or drop it). Readings belong to the session, so a different one resets them; re-taking the
  // one already on screen does not remount the panel, and nothing would re-send the vitals if they were cleared.
  protected setSession(session: SessionRef | undefined, options: { focus?: boolean } = {}): void {
    if (!session || !this.#session || !sameSession(this.#session, session.host.id, session.sessionId, session.conversation)) {
      this.vitals = undefined
      this.subagentToolUseId = undefined
      this.shellId = undefined
    }
    this.#session = session
    this.#unseen = session && session.conversation === undefined ? this.delegate.unseen(session.host.id, session.sessionId) : undefined
    // Queued rather than posted: a surface opening for the first time has not said `wd-ready` yet.
    if (session && options.focus) {
      this.#focusPending = true
    }
    this.pushSession()
  }

  pushThinking(): void {
    if (this.view && this.ready) {
      this.post({ kind: 'wd-thinking', hide: !showThinking() })
    }
  }

  protected held(): { title: string } | undefined {
    return undefined
  }

  protected pushSession(): void {
    if (!this.view || !this.ready) {
      return
    }
    const session = this.#session
    if (!session) {
      this.post({ kind: 'wd-show-session', session: undefined, held: this.held() })
      return
    }
    // After the session, never before: a composer about to be replaced must not take the caret.
    const focus = this.#focusPending
    this.#focusPending = false
    const base = apiUrl(session.host)
    if (!base) {
      return
    }
    this.post({
      kind: 'wd-show-session',
      session: {
        baseUrl: base,
        hostId: session.host.id,
        sessionId: session.sessionId,
        hostName: session.host.name,
        cwd: session.cwd,
        unseen: this.#unseen,
        ...(session.conversation === undefined ? {} : { conversation: session.conversation }),
      },
    })
    if (focus) {
      this.post({ kind: 'wd-focus-composer' })
    }
    this.#flushPending()
    this.pushPeerRows()
  }

  // The model polls every 1.2 s; only a changed map is posted.
  pushPeerRows(): void {
    const session = this.#session
    if (!session || !this.view || !this.ready) {
      return
    }
    const rows = this.delegate.peerRows(session.host.id)
    const sent = JSON.stringify(rows)
    if (this.#peerRowsSent === sent) {
      return
    }
    this.#peerRowsSent = sent
    this.post({ kind: 'wd-peer-rows', rows })
  }

  focusComposer(): void {
    this.#focusPending = true
    this.pushSession()
  }

  openSubagent(toolUseId: string): void {
    this.#pending = { kind: 'wd-open-subagent', id: toolUseId }
    this.#flushPending()
  }

  reveal(toolUseId: string): void {
    this.#pending = { kind: 'wd-reveal-tool-use', id: toolUseId }
    this.#flushPending()
  }

  openShell(shellId: string): void {
    this.#pending = { kind: 'wd-open-shell', id: shellId }
    this.#flushPending()
  }

  #flushPending(): void {
    if (!this.view || !this.ready) {
      return
    }
    const pending = this.#pending
    if (!pending) {
      return
    }
    this.#pending = undefined
    const nonce = ++this.#pendingNonce
    this.post(
      pending.kind === 'wd-open-shell'
        ? { kind: pending.kind, shellId: pending.id, nonce }
        : { kind: pending.kind, toolUseId: pending.id, nonce },
    )
  }

  protected override onReady(): void {
    this.#peerRowsSent = undefined
    // Safe ahead of the flushes below: a queued frame is re-posted straight after.
    this.subagentToolUseId = undefined
    this.shellId = undefined
    this.delegate.subagent(this)
    this.delegate.shell(this)
    this.pushSession()
  }

  protected override async onMessage(msg: PanelToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-open-path': {
        return openTranscriptPath(this.#store, this.#session, msg.path, msg.line)
      }
      case 'wd-open-url': {
        return void vscode.env.openExternal(vscode.Uri.parse(msg.url))
      }
      case 'wd-vitals': {
        this.vitals = msg.vitals
        this.delegate.vitals(this)
        return
      }
      case 'wd-open-panel': {
        await this.delegate.openPanel(this, msg.panel)
        return
      }
      case 'wd-subagent-open': {
        this.subagentToolUseId = msg.toolUseId
        this.delegate.subagent(this)
        return
      }
      case 'wd-shell-open': {
        this.shellId = msg.shellId
        this.delegate.shell(this)
        return
      }
      case 'wd-focus': {
        if (this.#session) {
          this.delegate.focused(this)
        }
        return
      }
      case 'wd-focus-held': {
        return
      }
      case 'wd-go-to-current': {
        this.delegate.goToCurrent(this, msg.sessionId)
        return
      }
    }
  }

  #tapFrame(text: string): void {
    const session = this.#session
    if (!session) {
      return
    }
    if (this.view?.visible) {
      return
    }
    let frame: {
      type?: string
      event?: { type?: string; byPolicy?: boolean; request?: { id?: string; toolName?: string; title?: string } }
    }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type !== 'event' || frame.event?.type !== 'permission_requested' || frame.event.byPolicy) {
      return
    }
    const request = frame.event.request
    const requestId = request?.id
    if (!requestId) {
      return
    }
    const title = `WorkerDeck (${session.host.name}): ${request?.title ?? `wants to run ${request?.toolName ?? 'a tool'}`}`
    void vscode.window.showWarningMessage(title, 'Approve', 'Deny', 'Open').then(async (choice) => {
      if (!choice) {
        return
      }
      if (choice === 'Open') {
        await this.focus()
        return
      }
      const client = await clientFor(this.#store, session.host)
      if (!client) {
        return
      }
      try {
        await client.resolvePermission(session.sessionId, requestId, {
          behavior: choice === 'Approve' ? 'allow' : 'deny',
        })
      } catch {
        // Already resolved from the panel (or elsewhere) - nothing to report.
      }
    })
  }

  // Inert until the surface has been opened at least once: with no webview there is no attach to command.
  setModel(model?: string): void {
    this.post({ kind: 'wd-set-model', model })
  }

  setEffort(effort?: string): void {
    this.post({ kind: 'wd-set-effort', effort })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.post({ kind: 'wd-set-permission-mode', mode })
  }

  insertComposerText(text: string): void {
    this.post({ kind: 'wd-insert-composer-text', text })
  }

  protected disposeTransports(): void {
    this.#transports?.dispose()
  }
}

// A gateway on this very machine - loopback, or reached by a LAN/tailnet name that resolves back here -
// owns the same files this window does, so its paths open as plain `file:` URIs: one editor per file,
// shared with the explorer, and every native affordance (Reveal in Finder, the git gutter) intact. Only
// a genuinely remote gateway goes through the `workerdeck:` provider.
async function openTranscriptPath(
  store: HostStore,
  session: SessionRef | undefined,
  clicked: string,
  line: number | undefined,
): Promise<void> {
  if (!session) {
    return
  }
  await openHostPath(store, session.host, clicked, session.cwd, line)
}

export async function openHostPath(store: HostStore, host: GatewayHost, clicked: string, cwd: string | undefined, line?: number): Promise<void> {
  const path = resolvePosix(clicked, cwd)
  if (!path) {
    return
  }
  const uri = (await isLocalHost(store, host)) ? vscode.Uri.file(path) : vscode.Uri.from({ scheme: 'workerdeck', authority: host.id.toLowerCase(), path })
  try {
    if (line) {
      const doc = await vscode.workspace.openTextDocument(uri)
      const selection = new vscode.Range(line - 1, 0, line - 1, 0)
      await vscode.window.showTextDocument(doc, { preview: true, selection })
    } else {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true })
    }
  } catch {
    void vscode.window.showWarningMessage(`WorkerDeck: could not open ${path}`)
  }
}
