import * as vscode from 'vscode'
import type { PermissionMode } from '@workerdeck/protocol'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import { catchUpMode, panelFontSize, terminalAffordances, terminalMetrics, transcriptDensity, transcriptVariant } from './webview-html.ts'
import { WebviewHost, type WebviewSurface } from './webview-host.ts'
import type { HostToPanel, PanelToHost } from './bridge-protocol.ts'

export type SessionRef = {
  host: GatewayHost
  sessionId: string
  cwd: string | undefined
}

export type SurfaceKind = 'panel' | 'editor'

export type AnySurface = SessionSurface<WebviewSurface>

export type SurfaceDelegate = {
  openPanel: (surface: AnySurface, panel: SessionSurfacePanel) => Promise<void>
  vitals: (surface: AnySurface) => void
  subagent: (surface: AnySurface) => void
  unseen: (hostId: string, sessionId: string) => { itemCount: number; since: number } | undefined
  visibilityChanged: (surface: AnySurface) => void
  focused: (surface: AnySurface) => void
}

export function sameSession(a: SessionRef | undefined, hostId: string, sessionId: string): boolean {
  return a?.sessionId === sessionId && a.host.id === hostId
}

// One session's webview, wherever VS Code draws it: the bottom Agent panel (a `WebviewView`) or an
// editor tab (a `WebviewPanel`). Everything the session needs from its host lives here; the two
// subclasses only differ in how they materialize, focus and persist.
export abstract class SessionSurface<V extends WebviewSurface> extends WebviewHost<PanelToHost, HostToPanel, V> {
  abstract readonly kind: SurfaceKind

  readonly #store: HostStore
  protected readonly delegate: SurfaceDelegate

  #focusPending = false
  // The single read-request slot: `openSubagent` and `reveal` go to different panel APIs
  // but at most one can ever be pending - asking for either withdraws the other. One slot
  // makes that mutual exclusion structural. The shared nonce is strictly increasing, so a
  // repeated ask of the same kind still reads as new on the webview side ("asking twice
  // means twice": `openSubagent`/`reveal` land in props).
  #pending: { kind: 'wd-open-subagent' | 'wd-reveal-tool-use'; toolUseId: string } | undefined
  #pendingNonce = 0
  #session: SessionRef | undefined
  // The catch-up boundary, frozen when the session was taken on.
  //
  // It answers "where were you when you opened this?", so it cannot be re-read at push time: making the view
  // visible marks the session seen, and `show()` awaits the focus command in between. Re-reading afterwards
  // returned the mark that opening had just moved, which cost the recap seam, the dimming and the jump target.
  #unseen: { itemCount: number; since: number } | undefined
  #transports: WebviewTransportHost | undefined

  vitals: SessionVitals | undefined
  subagentToolUseId: string | undefined

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

  holds(hostId: string, sessionId: string): boolean {
    return sameSession(this.#session, hostId, sessionId)
  }

  // Bring the surface on screen and give it keyboard focus.
  abstract focus(): Promise<void>

  protected override rootAttrs(): Record<string, string> {
    const cell = terminalMetrics()
    return {
      'data-density': transcriptDensity(),
      'data-variant': transcriptVariant(),
      'data-panel-font-size': String(panelFontSize()),
      'data-font-size': String(cell.fontSize),
      'data-line-height': String(cell.lineHeight),
      'data-affordances': terminalAffordances() ? 'on' : 'off',
      'data-catch-up': catchUpMode() ? 'on' : 'off',
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
    if (!session || !this.#session || !sameSession(this.#session, session.host.id, session.sessionId)) {
      this.vitals = undefined
      this.subagentToolUseId = undefined
    }
    this.#session = session
    this.#unseen = session ? this.delegate.unseen(session.host.id, session.sessionId) : undefined
    // Queued rather than posted: a surface opening for the first time has not said `wd-ready` yet.
    if (session && options.focus) {
      this.#focusPending = true
    }
    this.pushSession()
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
      },
    })
    if (focus) {
      this.post({ kind: 'wd-focus-composer' })
    }
    this.#flushPending()
  }

  focusComposer(): void {
    this.#focusPending = true
    this.pushSession()
  }

  openSubagent(toolUseId: string): void {
    this.#pending = { kind: 'wd-open-subagent', toolUseId }
    this.#flushPending()
  }

  reveal(toolUseId: string): void {
    this.#pending = { kind: 'wd-reveal-tool-use', toolUseId }
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
    this.post({ kind: pending.kind, toolUseId: pending.toolUseId, nonce: ++this.#pendingNonce })
  }

  protected override onReady(): void {
    // Safe ahead of the flushes below: a queued frame is re-posted straight after.
    this.subagentToolUseId = undefined
    this.delegate.subagent(this)
    this.pushSession()
  }

  protected override async onMessage(msg: PanelToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-open-path': {
        return openTranscriptPath(this.#session, msg.path, msg.line)
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
      case 'wd-focus': {
        if (this.#session) {
          this.delegate.focused(this)
        }
        return
      }
      case 'wd-focus-held': {
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

// In a Remote SSH window "this machine" is the remote box, which is exactly where a loopback gateway's files are.
async function openTranscriptPath(session: SessionRef | undefined, clicked: string, line: number | undefined): Promise<void> {
  if (!session) {
    return
  }
  const path = resolveAgainstCwd(clicked, session.cwd)
  if (!path) {
    return
  }
  const uri = isLoopbackHost(session.host)
    ? vscode.Uri.file(path)
    : vscode.Uri.from({ scheme: 'workerdeck', authority: session.host.id.toLowerCase(), path })
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

function resolveAgainstCwd(clicked: string, cwd: string | undefined): string | undefined {
  if (clicked.startsWith('/')) {
    return normalizePosix(clicked)
  }
  if (!cwd) {
    return undefined
  }
  return normalizePosix(`${cwd.replace(/\/+$/, '')}/${clicked}`)
}

function normalizePosix(path: string): string {
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
