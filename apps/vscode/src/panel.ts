import * as vscode from 'vscode'
import type { PermissionMode, SkillInfo } from '@workerdeck/protocol'
import type { SessionVitals, SessionSurfacePanel } from '@workerdeck/ui'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import { panelFontSize, terminalAffordances, terminalMetrics, transcriptDensity, transcriptVariant } from './webview-html.ts'
import { WebviewHost } from './webview-host.ts'
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

export class SessionPanelProvider extends WebviewHost<PanelToHost, HostToPanel> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.sessionPanel'

  readonly #store: HostStore
  readonly #delegate: PanelDelegate
  readonly #onDidChangeActive = new vscode.EventEmitter<ActiveSession | undefined>()
  readonly onDidChangeActive = this.#onDidChangeActive.event

  #focusPending = false
  // The single read-request slot: `openSubagent` and `reveal` go to different panel APIs
  // but at most one can ever be pending — asking for either withdraws the other. One slot
  // makes that mutual exclusion structural. The shared nonce is strictly increasing, so a
  // repeated ask of the same kind still reads as new on the webview side ("asking twice
  // means twice": `openSubagent`/`reveal` land in props).
  #pending: { kind: 'wd-open-subagent' | 'wd-reveal-tool-use'; toolUseId: string } | undefined
  #pendingNonce = 0
  #active: ActiveSession | undefined
  /**
   * The catch-up boundary, frozen when the session became active.
   *
   * It answers "where were you when you opened this?", so it cannot be re-read at push time: making the view
   * visible marks the session seen, and `show()` awaits the focus command in between. Re-reading afterwards
   * returned the mark that opening had just moved, which cost the recap seam, the dimming and the jump target.
   */
  #activeUnseen: { itemCount: number; since: number } | undefined
  #transports: WebviewTransportHost | undefined

  protected readonly bundle = 'main.js'

  constructor(extensionUri: vscode.Uri, store: HostStore, delegate: PanelDelegate) {
    super(extensionUri)
    this.#store = store
    this.#delegate = delegate
  }

  get active(): ActiveSession | undefined {
    return this.#active
  }

  get visible(): boolean {
    return this.view?.visible ?? false
  }

  isShowing(hostId: string, sessionId: string): boolean {
    return this.#active?.sessionId === sessionId && this.#active.host.id === hostId
  }

  protected override rootAttrs(): Record<string, string> {
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

  protected override htmlOptions(): { font?: boolean } {
    return { font: true }
  }

  protected override wire(view: vscode.WebviewView): void {
    this.resetForReload()
    view.onDidChangeVisibility(() => this.#delegate.visibilityChanged())
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
    // A disposed panel is not showing anything: nothing counts as read from here on.
    this.#delegate.visibilityChanged()
  }

  async show(active: ActiveSession | undefined, options: { focus?: boolean } = {}): Promise<void> {
    const existed = !!this.view
    this.#active = active
    this.#activeUnseen = active ? this.#delegate.unseen(active.host.id, active.sessionId) : undefined
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
    this.#activeUnseen = this.#delegate.unseen(active.host.id, active.sessionId)
    this.#onDidChangeActive.fire(active)
    this.#pushActive()
  }

  #pushActive(): void {
    if (!this.view || !this.ready) {
      return
    }
    const active = this.#active
    if (!active) {
      this.post({ kind: 'wd-show-session', session: undefined })
      return
    }
    // After the session, never before: a composer about to be replaced must not take the caret.
    const focus = this.#focusPending
    this.#focusPending = false
    const base = apiUrl(active.host)
    if (!base) {
      return
    }
    this.post({
      kind: 'wd-show-session',
      session: {
        baseUrl: base,
        sessionId: active.sessionId,
        hostName: active.host.name,
        unseen: this.#activeUnseen,
      },
    })
    if (focus) {
      this.post({ kind: 'wd-focus-composer' })
    }
    this.#flushPending()
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
    this.#delegate.subagent(undefined)
    this.#pushActive()
  }

  protected override async onMessage(msg: PanelToHost): Promise<void> {
    switch (msg.kind) {
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
    this.post({ kind: 'wd-set-model', model })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.post({ kind: 'wd-set-permission-mode', mode })
  }

  useSkill(skill: SkillInfo): void {
    this.post({ kind: 'wd-use-skill', skill })
  }

  dispose(): void {
    this.#transports?.dispose()
    this.#onDidChangeActive.dispose()
  }
}

// In a Remote SSH window "this machine" is the remote box, which is exactly where a loopback gateway's files are.
async function openTranscriptPath(active: ActiveSession | undefined, clicked: string, line: number | undefined): Promise<void> {
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
