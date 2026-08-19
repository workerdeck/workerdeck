import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { SessionsModel } from './sessions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSidebar, SidebarToHost } from './bridge-protocol.ts'
import {
  DEFAULT_VIEW_CONFIG,
  buildRows,
  filterRows,
  runningSubagents,
  type ViewConfig,
} from './view-config.ts'
import { webviewHtml } from './webview-html.ts'

/** The webview's own filter, mirrored here for the badge (see `wd-view-config`). */
const VIEW_CONFIG_KEY = 'workerdeck.viewConfig.v1'

/**
 * Whether the search-and-filter bar is showing, as a `when`-clause key.
 *
 * A view-title toggle whose icon has to differ open vs. closed is really two
 * commands with opposite `when` clauses — VS Code has no stateful title button
 * — so the state has to be a context key, which means the host owns it and the
 * webview is told. Persisted per window: a filter you opened should still be
 * open when you come back to it.
 */
export const FILTER_CONTEXT_KEY = 'workerdeck.sessionsFilterOpen'
const FILTER_OPEN_KEY = 'workerdeck.filterOpen.v1'

export type SidebarDelegate = {
  /** A session was chosen — show it in the agent panel. */
  /** `revealToolUse` set = the click landed on a sub-agent under the session:
   * select it, then take the panel to that `Task`'s row. */
  selectSession: (hostId: string, sessionId: string, revealToolUse?: string) => Promise<void>
  /** The active session was deleted out from under the panel. */
  clearPanelIfActive: (sessionId: string) => Promise<void>
  activeSessionId: () => string | undefined
  /** Reveal the Gateways view — its own view now, so the list can only ask. */
  revealGateways: (options: { add?: boolean }) => Promise<void>
  /**
   * The unread count, recomputed. It leaves through the delegate because it no
   * longer belongs to this view: it used to be `view.badge`, which VS Code
   * aggregates onto the *container's* icon, and the container these views live
   * in is now Explorer. It renders in the window status bar instead. What stays
   * here is the counting, because what it counts is this webview's own filter.
   */
  unread: (rows: number, waiting: number) => void
  /** Sub-agents in flight across the rows the list is showing, and how many
   * sessions they are spread over. */
  subagents: (running: number, sessions: number) => void
}

/**
 * The Sessions webview: the session list, and the one form it needs (new
 * session). Gateways and the scoped Info/Context/Usage/MCP surfaces are their
 * own views, so VS Code owns their headers, collapse and placement.
 *
 * **The view has no screens.** Creating a session is a native QuickPick and
 * gateways are their own view, so this webview is a list and nothing else —
 * there is no title to retitle, no back chevron to contribute, and nowhere to be
 * stranded. What this provider does own is the one piece of chrome VS Code will
 * only accept from the extension host: the filter toggle, whose two icons are
 * two commands gated on `FILTER_CONTEXT_KEY`.
 *
 * Data flows one way (the host pushes `wd-sidebar-state` on every model change)
 * while actions flow back as intents. The sidebar runs its own bridged
 * `WorkerDeckClient` for form REST (profiles, create) but NEVER attaches: the
 * agent panel owns the one live attach per session.
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
   * The list's filter, as last reported by the webview — a *copy*, for counting
   * the badge only. The webview owns it and renders from its own state; this
   * side never sends it back, so the two cannot fight over it. Restored from
   * globalState so a window badges correctly before the sidebar is ever opened.
   */
  #viewConfig: ViewConfig

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
    this.#viewConfig = {
      ...DEFAULT_VIEW_CONFIG,
      ...context.globalState.get<ViewConfig>(VIEW_CONFIG_KEY),
    }
    // Seeds the context key too, so the title bar shows the right one of the
    // two toggle icons before the view is ever opened.
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
    view.onDidChangeVisibility(() =>
      this.#model.setWatching(SidebarProvider.viewId, view.visible),
    )
    this.#model.setWatching(SidebarProvider.viewId, view.visible)
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
      this.#model.setWatching(SidebarProvider.viewId, false)
    })
  }

  /**
   * Show or hide the search-and-filter bar — the view title's toggle.
   *
   * Closing it does NOT clear the filters. That is deliberate and is why the
   * subset line under the bar is unconditional: hiding the controls must not
   * silently change what the list shows, and the list must keep saying that it
   * is showing a subset once the thing doing it is off screen.
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
      this.#post({ kind: 'wd-sidebar-state', state: this.#model.sidebarState() })
    }
    this.refreshUnread()
  }

  /**
   * Recompute the unread count alone, and hand it to whoever renders it.
   *
   * Separate from the state push, and public, because the two have different
   * triggers and different preconditions. The webview can only be told things
   * once it has said `wd-ready`; the count is worth maintaining precisely while
   * nobody is looking at the list — it is what tells you to look. And the event
   * that most often makes it wrong is not a poll at all: reading a session in
   * the panel moves its watermark, which no model change announces. Gating this
   * on `#ready` is how the badge came to sit at a stale count until the sidebar
   * was next opened.
   *
   * There is deliberately **no `#view` guard** either. As `view.badge` there had
   * to be one — a badge with no view to hang on is nothing — and it meant a
   * window that had never resolved this webview had no count at all. In the
   * status bar the number stands on its own, so it is computed whether or not
   * anyone has opened the list. `#viewConfig` is restored from globalState for
   * exactly this case.
   */
  refreshUnread(): void {
    const state = this.#model.sidebarState()
    // The count is in **rows** — the same unit the cards and the panel's recap
    // use, so the numbers add up across surfaces — and only over the rows the
    // list is actually showing: a number announcing work in a session the
    // filter (or the workspace scope, which is on by default) is hiding sends
    // you looking for something that isn't there.
    const visible = filterRows(buildRows(state), this.#viewConfig, state.scope)
    const rows = visible.reduce(
      (total, row) => total + (state.unseen?.[`${row.hostId}:${row.info.id}`] ?? 0),
      0,
    )
    this.#delegate.unread(rows, this.#model.attentionCount())
    // Counted over the same `visible` rows and in the same pass, for the same
    // reason: a bar announcing six agents in a session the filter is hiding
    // sends you looking for something that isn't there.
    let running = 0
    let sessions = 0
    for (const row of visible) {
      const live = runningSubagents(row.info).length
      if (live === 0) continue
      running += live
      sessions += 1
    }
    this.#delegate.subagents(running, sessions)
  }

  async #onMessage(msg: SidebarToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) return
    switch (msg.kind) {
      case 'wd-ready':
        this.#ready = true
        this.#pushState()
        // The webview boots with the bar closed and learns otherwise from here
        // — it cannot read a context key.
        this.#post({ kind: 'wd-filter-open', open: this.#filterOpen })
        return
      case 'wd-reveal-gateways':
        await this.#delegate.revealGateways({ add: msg.add })
        return
      case 'wd-view-config':
        // The badge counts what the list shows. Persisted so a fresh window
        // badges correctly before the sidebar has been opened even once.
        this.#viewConfig = msg.config
        void this.#context.globalState.update(VIEW_CONFIG_KEY, msg.config)
        this.#pushState()
        return
      case 'wd-select-session':
        await this.#delegate.selectSession(msg.hostId, msg.sessionId, msg.revealToolUse)
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
   * The card's overflow, as a native QuickPick — the same shape the create and
   * resume flows use, and the only kind of menu this extension has.
   *
   * The items are decided **here**, off the polled model, not by the card: a
   * card renders the last snapshot it was pushed, so a session that finished
   * between the poll and the press would still be offering Stop. Rename is not
   * among them — it is a double-click on the name, because a rename is a thing
   * you do to the word you are looking at.
   */
  async #sessionMenu(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    if (!info) return
    const running = info.status === 'running' || info.status === 'starting'
    const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = []
    if (running) {
      items.push({
        label: '$(debug-stop) Stop',
        detail: 'Interrupt the turn in flight',
        run: () => this.#stopSession(hostId, sessionId),
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
   * Interrupt over a transient attach: connect, send the frame, detach. The
   * agent panel stays the *first* attached client, so the tool bridge (which
   * asks the first) is undisturbed; the window where this transient socket
   * could catch a bridged tool call is accepted for an explicit user action.
   */
  async #stopSession(hostId: string, sessionId: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) return
    await new Promise<void>((resolve) => {
      const handle = client.attach(sessionId, { reconnect: false })
      const timer = setTimeout(() => {
        handle.detach()
        resolve()
      }, 4000)
      handle.on('attached', () => {
        handle.interrupt()
        // Give the frame a beat to flush before tearing the socket down.
        setTimeout(() => {
          clearTimeout(timer)
          handle.detach()
          resolve()
        }, 150)
      })
    })
    await this.#model.refresh()
  }

  /** Rename on the gateway (PATCH), not in this window: the name belongs to the
   * session, so the dashboard and the phone see it too. An empty name clears the
   * override and the derived title comes back. */
  async #renameSession(hostId: string, sessionId: string, title: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) return
    try {
      await client.updateSession(sessionId, { title: title.trim() || null })
    } catch (err) {
      void vscode.window.showErrorMessage(
        `WorkerDeck: rename failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await this.#model.refresh()
  }

  async #deleteSession(hostId: string, sessionId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) return
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(
      `Delete session "${info?.title ?? sessionId.slice(0, 8)}"?`,
      { modal: true },
      'Delete',
    )
    if (confirmed !== 'Delete') return
    const client = await clientFor(this.#store, host)
    if (!client) return
    try {
      await client.deleteSession(sessionId)
    } catch (err) {
      void vscode.window.showErrorMessage(
        `WorkerDeck: delete failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await this.#delegate.clearPanelIfActive(sessionId)
    await this.#model.refresh()
  }

  /** Re-render this webview from disk — the dev reloader after a rebuild, and
   * a font-setting change (the typeface is baked into the HTML). The webview
   * re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'sidebar.js', {}, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
