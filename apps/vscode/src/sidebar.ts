import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import type { SessionHandle } from '@workerdeck/client'
import { clientFor } from './gateway.ts'
import type { SessionsModel } from './sessions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSidebar, SidebarToHost } from './bridge-protocol.ts'
import { DEFAULT_VIEW_CONFIG, buildRows, filterRows, runningSubagents, type ViewConfig } from './view-config.ts'
import { WebviewHost } from './webview-host.ts'
import { ProjectIconCache } from './project-icons.ts'

const VIEW_CONFIG_KEY = 'workerdeck.viewConfig.v1'

export const FILTER_CONTEXT_KEY = 'workerdeck.sessionsFilterOpen'
const FILTER_OPEN_KEY = 'workerdeck.filterOpen.v1'

export type SidebarDelegate = {
  selectSession: (hostId: string, sessionId: string, subagentToolUseId?: string, revealToolUseId?: string) => Promise<void>
  clearPanelIfActive: (sessionId: string) => Promise<void>
  activeSessionId: () => string | undefined
  revealGateways: (options: { add?: boolean }) => Promise<void>
  unread: (rows: number, waiting: number) => void
  subagents: (running: number, sessions: number) => void
}

export class SidebarProvider extends WebviewHost<SidebarToHost, HostToSidebar> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.sessions'

  readonly #store: HostStore
  readonly #model: SessionsModel
  readonly #delegate: SidebarDelegate
  #transports: WebviewTransportHost | undefined
  #filterOpen = false
  readonly #context: vscode.ExtensionContext
  #viewConfig: ViewConfig
  readonly #icons: ProjectIconCache

  protected readonly bundle = 'sidebar.js'

  constructor(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    store: HostStore,
    model: SessionsModel,
    delegate: SidebarDelegate,
  ) {
    super(extensionUri)
    this.#context = context
    this.#store = store
    this.#model = model
    this.#delegate = delegate
    this.#icons = new ProjectIconCache(store, () => this.post({ kind: 'wd-project-icons', icons: this.#icons.entries() }))
    this.#viewConfig = {
      ...DEFAULT_VIEW_CONFIG,
      ...context.globalState.get<ViewConfig>(VIEW_CONFIG_KEY),
    }
    // Seeds the context key, so the title bar shows the right toggle icon before the view opens.
    this.setFilterOpen(context.globalState.get<boolean>(FILTER_OPEN_KEY) ?? false)
    model.onDidChange(() => this.#pushState())
  }

  protected override wire(view: vscode.WebviewView): void {
    this.resetForReload()
    view.onDidChangeVisibility(() => this.#model.setWatching(SidebarProvider.viewId, view.visible))
    this.#model.setWatching(SidebarProvider.viewId, view.visible)
  }

  protected override resetForReload(): void {
    this.#transports?.dispose()
    this.#transports = new WebviewTransportHost(this.#store, (msg) => this.post(msg))
  }

  protected override intercept(msg: SidebarToHost): Promise<boolean> | boolean {
    return this.#transports?.handle(msg) ?? false
  }

  protected override onViewDisposed(): void {
    this.#transports?.dispose()
    this.#model.setWatching(SidebarProvider.viewId, false)
  }

  setFilterOpen(open: boolean): void {
    this.#filterOpen = open
    void this.#context.globalState.update(FILTER_OPEN_KEY, open)
    void vscode.commands.executeCommand('setContext', FILTER_CONTEXT_KEY, open)
    this.post({ kind: 'wd-filter-open', open })
  }

  toggleFilter(): void {
    this.setFilterOpen(!this.#filterOpen)
  }

  #pushState(): void {
    if (this.view && this.ready) {
      const state = this.#model.sidebarState()
      this.post({ kind: 'wd-sidebar-state', state })
      this.#icons.ensure(state.sessions)
    }
    this.refreshUnread()
  }

  refreshUnread(): void {
    const state = this.#model.sidebarState()
    const visible = filterRows(buildRows(state), this.#viewConfig, state.scope)
    const rows = visible.reduce((total, row) => total + (state.unseen?.[`${row.hostId}:${row.info.id}`] ?? 0), 0)
    this.#delegate.unread(rows, this.#model.attentionCount())
    let running = 0
    let sessions = 0
    for (const row of visible) {
      const live = runningSubagents(row.info).length
      if (live === 0) {
        continue
      }
      running += live
      sessions += 1
    }
    this.#delegate.subagents(running, sessions)
  }

  protected override onReady(): void {
    // Whole, not incremental: a webview VS Code rebuilt has no map to merge into.
    this.post({ kind: 'wd-project-icons', icons: this.#icons.entries() })
    this.#pushState()
    // The webview boots with the bar closed and learns otherwise here: it cannot read a context key.
    this.post({ kind: 'wd-filter-open', open: this.#filterOpen })
  }

  protected override async onMessage(msg: SidebarToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-reveal-gateways': {
        await this.#delegate.revealGateways({ add: msg.add })
        return
      }
      case 'wd-view-config': {
        this.#viewConfig = msg.config
        void this.#context.globalState.update(VIEW_CONFIG_KEY, msg.config)
        this.#pushState()
        return
      }
      case 'wd-select-session': {
        await this.#delegate.selectSession(msg.hostId, msg.sessionId, msg.subagentToolUseId, msg.revealToolUseId)
        return
      }
      case 'wd-stop-session': {
        return this.#stopSession(msg.hostId, msg.sessionId)
      }
      case 'wd-rename-session': {
        return this.#renameSession(msg.hostId, msg.sessionId, msg.title)
      }
      case 'wd-delete-session': {
        return this.#deleteSession(msg.hostId, msg.sessionId)
      }
      case 'wd-session-menu': {
        return this.#sessionMenu(msg.hostId, msg.sessionId)
      }
    }
  }

  async #sessionMenu(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    if (!info) {
      return
    }
    const running = info.status === 'running' || info.status === 'starting'
    const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = []
    if (running) {
      items.push({
        label: '$(debug-stop) Stop',
        detail: 'Interrupt the turn in flight',
        run: () => this.#stopSession(hostId, sessionId),
      })
    }
    if (info.capabilities?.clearContext) {
      items.push({
        label: '$(clear-all) Clear context',
        detail: 'Start a fresh conversation — the old one stays resumable',
        run: () => this.#clearSession(hostId, sessionId),
      })
    }
    items.push({
      label: '$(trash) Delete',
      detail: 'Remove the session from the gateway',
      run: () => this.#deleteSession(hostId, sessionId),
    })
    const picked = await vscode.window.showQuickPick(items, {
      title: info.title ?? sessionId.slice(0, 8),
      placeHolder: 'Session actions',
    })
    await picked?.run()
  }

  async #stopSession(hostId: string, sessionId: string): Promise<void> {
    await this.#command(hostId, sessionId, (handle) => handle.interrupt())
  }

  // The frame gets a beat to flush before the socket goes; a command that never reached the gateway would look like one that did.
  async #command(hostId: string, sessionId: string, send: (handle: SessionHandle) => void): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    await new Promise<void>((resolve) => {
      const handle = client.attach(sessionId, { reconnect: false })
      const timer = setTimeout(() => {
        handle.detach()
        resolve()
      }, 4000)
      handle.on('attached', () => {
        send(handle)
        setTimeout(() => {
          clearTimeout(timer)
          handle.detach()
          resolve()
        }, 150)
      })
    })
    await this.#model.refresh()
  }

  async #clearSession(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(
      `Clear the conversation in "${info?.title ?? sessionId.slice(0, 8)}"?`,
      {
        modal: true,
        detail:
          'The session keeps running and starts a fresh conversation. The old one is not ' +
          'deleted — it stays resumable from "Resume a previous session".',
      },
      'Clear context',
    )
    if (confirmed !== 'Clear context') {
      return
    }
    await this.#command(hostId, sessionId, (handle) => handle.clearContext())
  }

  async #renameSession(hostId: string, sessionId: string, title: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.updateSession(sessionId, { title: title.trim() || null })
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: rename failed — ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.#model.refresh()
  }

  async #deleteSession(hostId: string, sessionId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) {
      return
    }
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(
      `Delete session "${info?.title ?? sessionId.slice(0, 8)}"?`,
      { modal: true },
      'Delete',
    )
    if (confirmed !== 'Delete') {
      return
    }
    const client = await clientFor(this.#store, host)
    if (!client) {
      return
    }
    try {
      await client.deleteSession(sessionId)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: delete failed — ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.#delegate.clearPanelIfActive(sessionId)
    await this.#model.refresh()
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
