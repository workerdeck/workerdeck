import type { SessionVitals } from '@workerdeck/ui'
import * as vscode from 'vscode'
import { startDevReload } from './dev-reload.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { GatewaysViewProvider } from './gateways-view.ts'
import { HostStore, isLoopbackHost } from './hosts.ts'
import { createSession, resumeSession, type NewSessionDeps } from './new-session.ts'
import { SessionPanelProvider } from './panel.ts'
import { SectionViewProvider, type SectionKind } from './section-view.ts'
import { SessionsModel } from './sessions-model.ts'
import { SidebarProvider } from './sidebar.ts'
import { SessionStatusBar, UnreadStatusItem, badgeEnabled, currentModel, modelLabel } from './status-bar.ts'
import { createWatermarks } from './watermarks.ts'

/** Section view ids — each its OWN view, so VS Code owns collapse/placement. */
const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
}

/**
 * Whether a session is on screen in the agent panel, as a `when`-clause key.
 *
 * The four section views are gated on it. That reverses an earlier decision —
 * they used to be contributed unconditionally, because a sidebar whose views
 * appear and disappear changes shape under the pointer — and it is the move to
 * Explorer that reverses it: in a container of our own, four rows reading "no
 * session" were the container's content; in Explorer they are four uninvited
 * rows under someone's file tree. The rule the earlier decision protected still
 * holds where it applies, since Sessions and Gateways are ungated and are what
 * gives the extension a stable shape there.
 */
const HAS_SESSION_KEY = 'workerdeck.hasSession'

/**
 * The watcher key the unread status-bar item holds on the sessions poll.
 *
 * Every other watcher is a view reporting its own visibility, so with nothing
 * open the poll stops. That was fine while the count was a container badge you
 * had to open the container to see; as the window bar's only always-visible
 * WorkerDeck signal it would freeze at whatever it last computed. So while the
 * item is enabled it watches unconditionally — one request per gateway per 5s
 * idle, which is the price of the signal being live. Turning the setting off
 * releases the watcher and restores the old behaviour exactly.
 */
const UNREAD_WATCHER = 'workerdeck.statusBar.unread'

export function activate(context: vscode.ExtensionContext): void {
  const store = new HostStore(context)
  const model = new SessionsModel(store)
  const fs = new WorkerdeckFileSystem(store)

  // Vitals for the SELECTED session, relayed panel → here → section views.
  // Cleared on selection change so a new session never wears the old one's
  // readings while its first snapshot is still in flight.
  let vitals: SessionVitals | undefined
  const statusBar = new SessionStatusBar()
  const unread = new UnreadStatusItem()
  const watermarks = createWatermarks(context)
  // Follows the setting, both now and on every change: the item and the poll
  // behind it are one switch, since a frozen count is worse than no count.
  const syncUnreadWatcher = () => model.setWatching(UNREAD_WATCHER, badgeEnabled('unread'))
  syncUnreadWatcher()

  /**
   * Record what is on screen as read — but only while it really is on screen.
   * The panel being visible AND showing this session is the whole test; a dock
   * behind the Terminal tab is not being read, and marking it read is exactly
   * how an unread badge quietly stops working.
   */
  const markSeen = (force = false) => {
    const active = panel.active
    if (!active || (!panel.visible && !force)) return
    const info = model.sessionsOf(active.host.id).find((s) => s.id === active.sessionId)
    const moved = watermarks.mark(active.host.id, active.sessionId, {
      itemCount: vitals?.itemCount,
      activity: info?.activityCount,
      turns: info?.numTurns,
    })
    // Reading rows is the *other* way the unread count changes, and it is silent
    // — no poll, no model event. Without this the badge holds whatever it last
    // computed: you answer the prompts, read the session, and the activity bar
    // still says (2) until something unrelated happens to refresh it. (Guarded
    // because a poll can land before `sidebar` is assigned; that path fires
    // `#pushState` for itself a moment later.)
    if (moved) sidebar?.refreshUnread()
  }

  const feed = {
    state: () => model.sidebarState(),
    vitals: () => vitals,
  }
  const sections = Object.fromEntries(
    (Object.keys(SECTION_VIEWS) as SectionKind[]).map((kind) => [
      kind,
      new SectionViewProvider(context.extensionUri, store, kind, feed),
    ]),
  ) as Record<SectionKind, SectionViewProvider>
  const pushSections = () => {
    for (const provider of Object.values(sections)) provider.push()
  }
  // Gateways are their own view in the same container — configuration beside the
  // list, not a screen the list pushes over itself. It reads the same state the
  // list does (hosts and their probes), and a save there refreshes the model,
  // which is what re-pushes every view including this one.
  const gateways = new GatewaysViewProvider(context.extensionUri, store, {
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    setWatching: (watching) => model.setWatching(GatewaysViewProvider.viewId, watching),
  })
  model.onDidChange(() => gateways.push())

  // The section views are always contributed (no `when` clauses): a sidebar
  // whose views appear and disappear as sessions are selected changes shape
  // under the pointer. Each one says for itself when it has nothing to show —
  // header description from the provider, empty state in its body.
  model.onDidChange(() => pushSections())
  // Unread counts for the sessions list: transcript rows the rollup has counted
  // minus the rows this window had seen. Rows, not turns — a turn that runs five
  // tools is one turn and eight rows, and the badge that says "1" for it is the
  // one nobody believes. Turns remain the fallback for a gateway too old to
  // report `activityCount`. Sessions with nothing new are absent, not zero.
  model.setUnseenProvider((sessions) => {
    const unseen: Record<string, number> = {}
    for (const [hostId, list] of Object.entries(sessions)) {
      for (const info of list) {
        const mark = watermarks.get(hostId, info.id)
        if (!mark) continue
        const fresh =
          info.activityCount !== undefined
            ? info.activityCount - mark.activity
            : (info.numTurns ?? 0) - mark.turns
        if (fresh > 0) unseen[`${hostId}:${info.id}`] = fresh
      }
    }
    return unseen
  })
  // A poll that lands while the panel is visible is also a chance to catch the
  // turn count up — vitals move on their own clock.
  model.onDidChange(() => markSeen())

  // Panel and sidebar reference each other only through these delegates —
  // construction order breaks the cycle (panel's delegate closes over `sidebar`
  // lazily, and no delegate fires before activate() returns).
  let sidebar: SidebarProvider
  const panel = new SessionPanelProvider(context.extensionUri, store, {
    openPanel: async (p) => {
      const viewId = p === 'files' || p === 'skills' ? undefined : SECTION_VIEWS[p]
      if (!viewId) return
      await vscode.commands.executeCommand(`${viewId}.focus`)
    },
    vitals: (v) => {
      // The panel's socket is the FIRST place this window learns a turn started
      // or stopped — the rollups behind the cards and the badges only find out on
      // the next poll. A status change is the cheap, meaningful signal (the rest
      // of `vitals` moves on every stream delta), so it is what nudges the model
      // rather than every reading.
      const moved = v.status !== vitals?.status
      vitals = v
      if (moved) model.nudge()
      markSeen()
      pushSections()
      pushStatusBar()
    },
    unseen: (hostId, sessionId) => {
      const mark = watermarks.get(hostId, sessionId)
      return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
    },
    visibilityChanged: () => {
      markSeen()
      // Hiding the panel freezes the mark where it is, which is what makes the
      // next visit have something to catch up on. One catch: the mark is written
      // from the last *poll*, so anything produced since it landed would count
      // as unread even though it was on screen. Refresh and mark once more —
      // `force`, because the panel is already hidden by then and the rule is
      // about what was visible, not what is.
      void model.refresh().then(() => markSeen(true))
    },
  })
  // Title and cost come from the REST rollup, the live readings from vitals —
  // the two arrive on different clocks, so the bar is rendered from both each
  // time either moves.
  const pushStatusBar = () => {
    const active = panel.active
    if (!active) {
      statusBar.update(undefined, undefined)
      return
    }
    const info = model.sessionsOf(active.host.id).find((s) => s.id === active.sessionId)
    statusBar.update(
      {
        title: info?.title ?? active.sessionId.slice(0, 8),
        hostName: active.host.name,
        cost: info?.totalCostUsd,
      },
      vitals,
    )
  }
  // Show a session in the agent panel. Named, because both the list and the
  // new-session QuickPick end here — a session you just created should be the
  // one on screen.
  const selectSession = async (hostId: string, sessionId: string) => {
    const host = store.get(hostId)
    if (!host) return
    const info = model.sessionsOf(hostId).find((s) => s.id === sessionId)
    // Only a REAL change drops the readings. Re-clicking the session already
    // on screen doesn't remount the panel, so nothing would ever re-send them
    // — Context and Usage would sit empty until the next event moved one.
    if (!panel.isShowing(hostId, sessionId)) vitals = undefined
    model.setSelected({ hostId, sessionId })
    // Choosing a session is a request to talk to it: reveal the panel and put the
    // caret in the composer, even when that session was already on screen.
    await panel.show({ host, sessionId, cwd: info?.cwd }, { focus: true })
  }
  sidebar = new SidebarProvider(context, context.extensionUri, store, model, {
    selectSession,
    clearPanelIfActive: async (sessionId) => {
      if (panel.active?.sessionId === sessionId) {
        vitals = undefined
        model.setSelected(undefined)
        await panel.show(undefined)
      }
    },
    activeSessionId: () => panel.active?.sessionId,
    revealGateways: (options) => gateways.reveal(options),
    unread: (rows, waiting) => unread.update(rows, waiting),
  })

  // What the new-session / resume QuickPicks need: the gateways and their
  // sessions to offer, and somewhere to put the session once it exists.
  const sessionFlow: NewSessionDeps = {
    store,
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    reveal: selectSession,
  }

  // The window status bar IS the agent's status bar — the panel renders none of
  // its own (`statusSurface='external'` in the webview). Fed from both sides:
  // vitals for the live readings, the sessions poll for the title and cost.
  panel.onDidChangeActive(() => pushStatusBar())
  model.onDidChange(() => pushStatusBar())
  pushStatusBar()

  // The four section views exist only while there is a session for them to be
  // about. Seeded false, because a `when` clause reads an unset key as false
  // anyway and being explicit is what makes the sequence obvious.
  const syncHasSession = (has: boolean) =>
    void vscode.commands.executeCommand('setContext', HAS_SESSION_KEY, has)
  panel.onDidChangeActive((active) => syncHasSession(active !== undefined))
  syncHasSession(panel.active !== undefined)

  context.subscriptions.push(
    startDevReload(context, [panel, sidebar, gateways, ...Object.values(sections)]),
    // The typeface is baked into the panel's HTML (it must be right on the first
    // paint), so changing it means re-rendering it — the same re-render the dev
    // reloader does, after which the webview re-announces itself. The panel
    // alone: the sidebar and section views follow VS Code's UI font.
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Both are baked into the panel's HTML for the first paint, so changing
      // either means re-rendering it — the same re-render the dev reloader does.
      if (
        e.affectsConfiguration('workerdeck.fontFamily') ||
        e.affectsConfiguration('workerdeck.transcriptDensity') ||
        e.affectsConfiguration('workerdeck.transcriptVariant') ||
        e.affectsConfiguration('workerdeck.terminal') ||
        // The terminal cell FOLLOWS the editor's own size unless overridden, so
        // an editor-font change is a panel change: without these two the panel
        // would keep drawing at the size the editor used to be.
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.lineHeight')
      ) {
        panel.reloadWebview()
      }
      // Which badges the window bar carries is a per-render read, so showing
      // and hiding one is just a re-render against the readings we already hold.
      if (e.affectsConfiguration('workerdeck.statusBar')) {
        statusBar.refresh()
        unread.render()
        // The unread item is the one badge that also owns a poll, so its
        // setting has to move more than a render.
        syncUnreadWatcher()
      }
    }),
    model,
    panel,
    sidebar,
    gateways,
    fs,
    statusBar,
    unread,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Retained too: the add/edit form is the one place in this extension where
    // typing can be lost to a view being torn down, and the auth key in it can
    // only be re-fetched by asking to edit the gateway again.
    vscode.window.registerWebviewViewProvider(GatewaysViewProvider.viewId, gateways, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...Object.entries(sections).map(([kind, provider]) =>
      vscode.window.registerWebviewViewProvider(SECTION_VIEWS[kind as SectionKind], provider),
    ),
    ...Object.values(sections),
    vscode.window.registerWebviewViewProvider(SessionPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerFileSystemProvider(WorkerdeckFileSystem.scheme, fs, {
      isCaseSensitive: true,
    }),

    vscode.commands.registerCommand('workerdeck.addGateway', () => gateways.reveal({ add: true })),
    vscode.commands.registerCommand('workerdeck.showGateways', () => gateways.reveal()),
    vscode.commands.registerCommand('workerdeck.gatewaysBack', () => gateways.back()),
    // Creating a session is a native multi-step QuickPick: adapter, folder,
    // optional first prompt. It replaced a form the sidebar pushed over itself,
    // which is what let that view become a list with no navigation at all.
    vscode.commands.registerCommand('workerdeck.newSession', () => createSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.resumeSession', () => resumeSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

    // One toggle, two commands: a `view/title` button has a fixed icon, so the
    // only way to show a different one for open and closed is a pair of them
    // with opposite `when` clauses. Both land here.
    vscode.commands.registerCommand('workerdeck.showFilter', () => sidebar.setFilterOpen(true)),
    vscode.commands.registerCommand('workerdeck.hideFilter', () => sidebar.setFilterOpen(false)),
    vscode.commands.registerCommand('workerdeck.toggleFilter', () => sidebar.toggleFilter()),

    // The status bar's two pickers. A StatusBarItem carries one command and no
    // dropdown, so the native shape for this is command → QuickPick — the same
    // one the language-mode and encoding items use. The options come from the
    // panel's own vitals, so the list is exactly what its composer would offer.
    vscode.commands.registerCommand('workerdeck.selectModel', async () => {
      const models = vitals?.models ?? []
      if (models.length === 0) {
        void vscode.window.showInformationMessage('WorkerDeck: no models to switch to yet.')
        return
      }
      const current = currentModel(vitals)
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({
          label: m.displayName,
          description: m.value === current?.value ? 'current' : undefined,
          detail: m.description ?? m.resolvedModel ?? m.value,
          value: m.value,
        })),
        { title: 'WorkerDeck: model', placeHolder: modelLabel(vitals) },
      )
      if (picked) panel.setModel(picked.value)
    }),
    vscode.commands.registerCommand('workerdeck.selectPermissionMode', async () => {
      const modes = vitals?.permissionModes ?? []
      if (modes.length === 0) {
        void vscode.window.showInformationMessage('WorkerDeck: this session has no mode switch.')
        return
      }
      const current = vitals?.permissionMode
      const picked = await vscode.window.showQuickPick(
        modes.map((m) => ({
          label: m.dangerous ? `$(warning) ${m.label}` : m.label,
          description: m.value === current ? 'current' : undefined,
          detail: m.description,
          mode: m.value,
          // A mode the session can never be granted stays visible and unpickable
          // — the reason is in its detail line.
          alwaysShow: true,
          picked: m.value === current,
          disabled: m.disabled,
        })),
        { title: 'WorkerDeck: permission mode' },
      )
      if (picked && !picked.disabled) panel.setPermissionMode(picked.mode)
    }),

    vscode.commands.registerCommand('workerdeck.openProjectFolder', async () => {
      const active = panel.active
      if (!active?.cwd) {
        void vscode.window.showInformationMessage('WorkerDeck: open a session first.')
        return
      }
      const uri = isLoopbackHost(active.host)
        ? vscode.Uri.file(active.cwd)
        : vscode.Uri.from({
            scheme: WorkerdeckFileSystem.scheme,
            authority: active.host.id.toLowerCase(),
            path: active.cwd,
          })
      const name =
        uri.scheme === WorkerdeckFileSystem.scheme
          ? `${active.host.name}: ${active.cwd.split('/').pop() ?? active.cwd}`
          : undefined
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
        uri,
        name,
      })
    }),
  )
}

export function deactivate(): void {}
