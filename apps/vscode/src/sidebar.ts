import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import type { SessionHandle } from '@workerdeck/client'
import { clientFor } from './gateway.ts'
import { SessionsModel } from './sessions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSidebar, SidebarToHost } from './bridge-protocol.ts'
import { DEFAULT_VIEW_CONFIG, buildRows, filterRows, runningSubagents, type ViewConfig } from './view-config.ts'
import { webviewHtml } from './webview-html.ts'
import { ProjectIconCache } from './project-icons.ts'

/** The webview's own filter, mirrored here for the badge (see `wd-view-config`). */
const VIEW_CONFIG_KEY = 'workerdeck.viewConfig.v1'

/**
 * Whether the search-and-filter bar is showing, as a `when`-clause key. VS Code has
 * no stateful title button, so a toggle whose icon differs open vs. closed is two
 * commands with opposite `when` clauses — which makes the state a context key, owned
 * by the host and pushed to the webview.
 */
export const FILTER_CONTEXT_KEY = 'workerdeck.sessionsFilterOpen'
const FILTER_OPEN_KEY = 'workerdeck.filterOpen.v1'

export type SidebarDelegate = {
  /** A session was chosen — show it in the agent panel. `subagentToolUseId` frames
   * one agent's work; `revealToolUseId` stays on the conversation and travels to a
   * row. At most one is ever set — see `wd-select-session`. */
  selectSession: (hostId: string, sessionId: string, subagentToolUseId?: string, revealToolUseId?: string) => Promise<void>
  /** The active session was deleted out from under the panel. */
  clearPanelIfActive: (sessionId: string) => Promise<void>
  activeSessionId: () => string | undefined
  /** Reveal the Gateways view — its own view now, so the list can only ask. */
  revealGateways: (options: { add?: boolean }) => Promise<void>
  /** The unread count, recomputed. It leaves through the delegate — a `view.badge`
   * aggregates onto its *container's* icon, which here is Explorer's — but the
   * counting stays, because what it counts is this webview's own filter. */
  unread: (rows: number, waiting: number) => void
  /** Sub-agents in flight across the rows the list is showing, and how many
   * sessions they are spread over. */
  subagents: (running: number, sessions: number) => void
}

/**
 * The Sessions webview. **The view has no screens**: creating a session is a native
 * QuickPick and gateways are their own view, so this webview is a list and nothing
 * else. The one piece of chrome it owns is the filter toggle, whose two icons are
 * two commands gated on `FILTER_CONTEXT_KEY`.
 *
 * Data flows one way (the host pushes `wd-sidebar-state` on every model change)
 * while actions flow back as intents. The sidebar runs its own bridged
 * `WorkerDeckClient` for form REST but **never attaches**: the agent panel owns the
 * one live attach per session.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'workerdeck.sessions'

  readonly #extensionUri: vscode.Uri
  readonly #store: HostStore
  readonly #model: SessionsModel
  readonly #delegate: SidebarDelegate
  #view: vscode.WebviewView | undefined
  #ready = false
  #htmlVersion = 0
  #transports: WebviewTransportHost | undefined
  /** Whether the filter bar is showing — this side's, because the toggle is a
   * native title action. Persisted; pushed to the webview on every change. */
  #filterOpen = false
  readonly #context: vscode.ExtensionContext
  /**
   * The list's filter, as last reported by the webview — a *copy*, for counting only.
   * The webview owns it and this side never sends it back, so the two cannot fight
   * over it. Restored from globalState so a window counts correctly before the
   * sidebar is ever opened.
   */
  #viewConfig: ViewConfig
  /** Project icon bytes by hash — see `ProjectIconCache`. */
  readonly #icons: ProjectIconCache

  constructor(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    store: HostStore,
    model: SessionsModel,
    delegate: SidebarDelegate,
  ) {
    this.#context = context
    this.#extensionUri = extensionUri
    this.#store = store
    this.#model = model
    this.#delegate = delegate
    this.#icons = new ProjectIconCache(store, () => this.#post({ kind: 'wd-project-icons', icons: this.#icons.entries() }))
    this.#viewConfig = {
      ...DEFAULT_VIEW_CONFIG,
      ...context.globalState.get<ViewConfig>(VIEW_CONFIG_KEY),
    }
    // Seeds the context key, so the title bar shows the right toggle icon before the view opens.
    this.setFilterOpen(context.globalState.get<boolean>(FILTER_OPEN_KEY) ?? false)
    model.onDidChange(() => this.#pushState())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.#transports?.dispose()
    const post = (msg: HostToSidebar) => void view.webview.postMessage(msg)
    this.#transports = new WebviewTransportHost(this.#store, post)
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'sidebar.js')
    view.webview.onDidReceiveMessage((msg: SidebarToHost) => void this.#onMessage(msg))
    view.onDidChangeVisibility(() => this.#model.setWatching(SidebarProvider.viewId, view.visible))
    this.#model.setWatching(SidebarProvider.viewId, view.visible)
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
      this.#model.setWatching(SidebarProvider.viewId, false)
    })
  }

  /**
   * Show or hide the search-and-filter bar. Closing it does **not** clear the
   * filters, which is why the subset line under the bar is unconditional: hiding the
   * controls must not silently change what the list shows.
   */
  setFilterOpen(open: boolean): void {
    this.#filterOpen = open
    void this.#context.globalState.update(FILTER_OPEN_KEY, open)
    void vscode.commands.executeCommand('setContext', FILTER_CONTEXT_KEY, open)
    this.#post({ kind: 'wd-filter-open', open })
  }

  toggleFilter(): void {
    this.setFilterOpen(!this.#filterOpen)
  }

  #post(msg: HostToSidebar): void {
    void this.#view?.webview.postMessage(msg)
  }

  #pushState(): void {
    if (this.#view && this.#ready) {
      const state = this.#model.sidebarState()
      this.#post({ kind: 'wd-sidebar-state', state })
      // Fire-and-forget: anything new arrives as its own message; the list draws before its pictures.
      this.#icons.ensure(state.sessions)
    }
    this.refreshUnread()
  }

  /**
   * Recompute the unread count alone. Separate from the state push, and gated on
   * **neither** `#ready` nor `#view`: the count is worth maintaining precisely while
   * nobody is looking at the list, and reading a session in the panel moves its
   * watermark without any model change announcing it. `#viewConfig` is restored from
   * globalState for exactly this case.
   */
  refreshUnread(): void {
    const state = this.#model.sidebarState()
    // In **rows**, the unit the cards and the panel's recap use, and only over the rows the
    // list is showing: a count for a session the filter hides sends you looking for nothing.
    const visible = filterRows(buildRows(state), this.#viewConfig, state.scope)
    const rows = visible.reduce((total, row) => total + (state.unseen?.[`${row.hostId}:${row.info.id}`] ?? 0), 0)
    this.#delegate.unread(rows, this.#model.attentionCount())
    // Over the same `visible` rows and in the same pass, for the same reason.
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

  async #onMessage(msg: SidebarToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) {
      return
    }
    switch (msg.kind) {
      case 'wd-ready':
        this.#ready = true
        // Whole, not incremental: a webview VS Code rebuilt has no map to merge into.
        this.#post({ kind: 'wd-project-icons', icons: this.#icons.entries() })
        this.#pushState()
        // The webview boots with the bar closed and learns otherwise here: it cannot read a context key.
        this.#post({ kind: 'wd-filter-open', open: this.#filterOpen })
        return
      case 'wd-reveal-gateways':
        await this.#delegate.revealGateways({ add: msg.add })
        return
      case 'wd-view-config':
        // Persisted so a fresh window counts correctly before the sidebar has been opened once.
        this.#viewConfig = msg.config
        void this.#context.globalState.update(VIEW_CONFIG_KEY, msg.config)
        this.#pushState()
        return
      case 'wd-select-session':
        await this.#delegate.selectSession(msg.hostId, msg.sessionId, msg.subagentToolUseId, msg.revealToolUseId)
        return
      case 'wd-stop-session':
        return this.#stopSession(msg.hostId, msg.sessionId)
      case 'wd-rename-session':
        return this.#renameSession(msg.hostId, msg.sessionId, msg.title)
      case 'wd-delete-session':
        return this.#deleteSession(msg.hostId, msg.sessionId)
      case 'wd-session-menu':
        return this.#sessionMenu(msg.hostId, msg.sessionId)
    }
  }

  /**
   * The card's overflow, as a native QuickPick. The items are decided **here**, off
   * the polled model, not by the card: a card renders the last snapshot it was
   * pushed, so a session that finished between the poll and the press would still be
   * offering Stop. Rename is not among them — it is a double-click on the name.
   */
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
    // On the capability record, never on the engine name. Absent means false, so a gateway
    // too old to know the command simply does not offer the entry.
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

  /**
   * Interrupt over a transient attach. The agent panel stays the *first* attached
   * client, so the tool bridge (which asks the first) is undisturbed; the window in
   * which this socket could catch a bridged tool call is accepted for an explicit
   * user action.
   */
  async #stopSession(hostId: string, sessionId: string): Promise<void> {
    await this.#command(hostId, sessionId, (handle) => handle.interrupt())
  }

  /** Connect, send one session command, detach. The frame gets a beat to flush
   * before the socket goes; a command that never reached the gateway would
   * otherwise be indistinguishable from one that did. */
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

  /**
   * Clear the conversation, over the same transient attach `#stopSession` uses — the
   * clear is a session command on the socket, not a `POST`. Confirmed first, because
   * "clear" reads as "gone" while the old conversation is not deleted and stays
   * resumable. The reset comes back as a `conversation_reset` event to every attached
   * client, which is why this does not refresh the transcript itself.
   */
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

  /** Rename on the gateway (PATCH), not in this window: the name belongs to the
   * session, so every other client sees it too. An empty name clears the override. */
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
    view.webview.html = webviewHtml(view.webview, dist, 'sidebar.js', {}, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
