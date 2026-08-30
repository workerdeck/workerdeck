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
import { SessionStatusBar, SubagentStatusItem, UnreadStatusItem, badgeEnabled, currentModel, modelLabel } from './status-bar.ts'
import { createWatermarks } from './watermarks.ts'

/** Section view ids — each its OWN view, so VS Code owns collapse/placement. */
const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
}

/**
 * Whether a session is on screen in the agent panel, as a `when`-clause key. The
 * four section views are gated on it; Sessions and Gateways stay ungated, which is
 * what keeps both containers' shape stable.
 */
const HAS_SESSION_KEY = 'workerdeck.hasSession'

/**
 * The watcher key the unread status-bar item holds on the sessions poll. Every other
 * watcher is a view reporting its own visibility, so with nothing open the poll
 * stops — and the window bar's only always-visible signal would freeze. While the
 * item is enabled it therefore watches unconditionally.
 */
const UNREAD_WATCHER = 'workerdeck.statusBar.unread'

/**
 * Which session the panel was showing, so a window reload lands back on it.
 * **Workspace** state, not global: which session you are reading is a fact about
 * this window's folder, and two windows on two projects must not fight over one slot.
 */
const ACTIVE_SESSION_KEY = 'workerdeck.activeSession'

export function activate(context: vscode.ExtensionContext): void {
  const store = new HostStore(context)
  const model = new SessionsModel(store)
  const fs = new WorkerdeckFileSystem(store)

  // Vitals for the SELECTED session, relayed panel → here → section views. Cleared on
  // selection change so a new session never wears the old one's readings.
  let vitals: SessionVitals | undefined
  const statusBar = new SessionStatusBar()
  const unread = new UnreadStatusItem()
  const subagents = new SubagentStatusItem()
  const watermarks = createWatermarks(context)
  // The item and the poll behind it are one switch. **Either** badge keeps it alive:
  // they are computed in the same pass, so gating on `unread` alone leaves someone
  // who turned unread off and sub-agents on watching a count that never moves.
  const syncUnreadWatcher = () => model.setWatching(UNREAD_WATCHER, badgeEnabled('unread') || badgeEnabled('subagents'))
  syncUnreadWatcher()

  /**
   * Record what is on screen as read — but only while it really is on screen. The
   * panel being visible AND showing this session is the whole test; a dock behind the
   * Terminal tab is not being read.
   */
  const markSeen = (force = false) => {
    const active = panel.active
    if (!active || (!panel.visible && !force)) {
      return
    }
    const info = model.sessionsOf(active.host.id).find((s) => s.id === active.sessionId)
    const moved = watermarks.mark(active.host.id, active.sessionId, {
      itemCount: vitals?.itemCount,
      activity: info?.activityCount,
      turns: info?.numTurns,
    })
    // Reading rows is the *other* way the unread count changes, and it is silent — no
    // poll, no model event. Guarded because a poll can land before `sidebar` is assigned.
    if (moved) {
      sidebar?.refreshUnread()
    }
  }

  const feed = {
    state: () => model.sidebarState(),
    vitals: () => vitals,
  }
  const sections = Object.fromEntries(
    (Object.keys(SECTION_VIEWS) as SectionKind[]).map((kind) => [kind, new SectionViewProvider(context.extensionUri, store, kind, feed)]),
  ) as Record<SectionKind, SectionViewProvider>
  const pushSections = () => {
    for (const provider of Object.values(sections)) {
      provider.push()
    }
  }
  // Gateways are their own view in the same container. It reads the same state the list
  // does, and a save there refreshes the model, which re-pushes every view.
  const gateways = new GatewaysViewProvider(context.extensionUri, store, {
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    setWatching: (watching) => model.setWatching(GatewaysViewProvider.viewId, watching),
  })
  model.onDidChange(() => gateways.push())

  model.onDidChange(() => pushSections())
  // Unread: transcript rows the rollup counted minus the rows this window had seen.
  // **Rows, not turns** — a turn that runs five tools is one turn and eight rows.
  // Turns stay the fallback for a gateway too old to report `activityCount`.
  model.setUnseenProvider((sessions) => {
    const unseen: Record<string, number> = {}
    for (const [hostId, list] of Object.entries(sessions)) {
      for (const info of list) {
        const mark = watermarks.get(hostId, info.id)
        if (!mark) {
          continue
        }
        const fresh = info.activityCount !== undefined ? info.activityCount - mark.activity : (info.numTurns ?? 0) - mark.turns
        if (fresh > 0) {
          unseen[`${hostId}:${info.id}`] = fresh
        }
      }
    }
    return unseen
  })
  // A poll landing while the panel is visible is also a chance to catch the count up.
  model.onDidChange(() => markSeen())

  // Panel and sidebar reference each other only through these delegates; construction
  // order breaks the cycle, and no delegate fires before activate() returns.
  let sidebar: SidebarProvider
  const panel = new SessionPanelProvider(context.extensionUri, store, {
    openPanel: async (p) => {
      const viewId = p === 'files' || p === 'skills' ? undefined : SECTION_VIEWS[p]
      if (!viewId) {
        return
      }
      await vscode.commands.executeCommand(`${viewId}.focus`)
    },
    vitals: (v) => {
      // The panel's socket is the first place this window learns a turn started or
      // stopped. A status change is the cheap signal — the rest of `vitals` moves on
      // every stream delta — so only it nudges the model.
      const moved = v.status !== vitals?.status
      vitals = v
      if (moved) {
        model.nudge()
      }
      markSeen()
      pushSections()
      pushStatusBar()
    },
    // What the panel now has framed: a statement, not a decision this file gets to make.
    subagent: (toolUseId) => model.setSelectedSubagent(toolUseId),
    unseen: (hostId, sessionId) => {
      const mark = watermarks.get(hostId, sessionId)
      return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
    },
    visibilityChanged: () => {
      markSeen()
      // The mark is written from the last *poll*, so anything produced since would count
      // as unread despite having been on screen. Refresh and mark once more, with
      // `force`, the panel being already hidden and the rule being about what was visible.
      void model.refresh().then(() => markSeen(true))
    },
  })
  // Title and cost come from the REST rollup, the live readings from vitals — different clocks.
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
  // Show a session in the agent panel. Both the list and the new-session QuickPick end here.
  const selectSession = async (hostId: string, sessionId: string, subagentToolUseId?: string, revealToolUseId?: string) => {
    const host = store.get(hostId)
    if (!host) {
      return
    }
    const info = model.sessionsOf(hostId).find((s) => s.id === sessionId)
    // Only a REAL change drops the readings: re-clicking the session already on screen
    // does not remount the panel, so nothing would re-send them.
    if (!panel.isShowing(hostId, sessionId)) {
      vitals = undefined
    }
    // Seeded with the pick so the card answers the click in the same frame; the panel
    // reports the same value back a beat later and `setSelectedSubagent` no-ops on it.
    model.setSelected({ hostId, sessionId, subagentToolUseId })
    // `cwd` resolves Cmd-clicked relative paths, and the model has no snapshot of it at activation.
    void context.workspaceState.update(ACTIVE_SESSION_KEY, { hostId, sessionId, cwd: info?.cwd })
    // Choosing a session is a request to talk to it, so the caret goes to the composer.
    // Choosing a sub-agent or a task under it is a request to *read*, so it does not.
    await panel.show({ host, sessionId, cwd: info?.cwd }, { focus: !subagentToolUseId && !revealToolUseId })
    if (subagentToolUseId) {
      panel.openSubagent(subagentToolUseId)
    }
    // A **task** has no agent to hand the body over to — travel to its row instead.
    else if (revealToolUseId) {
      panel.reveal(revealToolUseId)
    }
  }
  sidebar = new SidebarProvider(context, context.extensionUri, store, model, {
    selectSession,
    clearPanelIfActive: async (sessionId) => {
      if (panel.active?.sessionId === sessionId) {
        vitals = undefined
        model.setSelected(undefined)
        void context.workspaceState.update(ACTIVE_SESSION_KEY, undefined)
        await panel.show(undefined)
      }
    },
    activeSessionId: () => panel.active?.sessionId,
    revealGateways: (options) => gateways.reveal(options),
    unread: (rows, waiting) => unread.update(rows, waiting),
    subagents: (running, sessions) => subagents.update(running, sessions),
  })

  // What the new-session / resume QuickPicks need.
  const sessionFlow: NewSessionDeps = {
    store,
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    reveal: selectSession,
  }

  // The window status bar IS the agent's status bar — the panel renders none of its own
  // (`statusSurface='external'`).
  panel.onDidChangeActive(() => pushStatusBar())
  model.onDidChange(() => pushStatusBar())
  pushStatusBar()

  // The four section views exist only while there is a session for them to be about.
  const syncHasSession = (has: boolean) => void vscode.commands.executeCommand('setContext', HAS_SESSION_KEY, has)
  panel.onDidChangeActive((active) => syncHasSession(active !== undefined))
  syncHasSession(panel.active !== undefined)

  // Come back to the session this window was reading. **After** the `onDidChangeActive`
  // subscribers above, so restoring feeds the status bar and the `when` key the way
  // selecting would. The refresh below is unconditional and one-shot: the poll only runs
  // while something is watching, which after a reload may be nothing at all.
  const remembered = context.workspaceState.get<{
    hostId: string
    sessionId: string
    cwd?: string
  }>(ACTIVE_SESSION_KEY)
  if (remembered) {
    const host = store.get(remembered.hostId)
    // A gateway removed since the reload leaves nothing to restore — drop the record.
    if (host) {
      // No `subagentToolUseId`: a frame belongs to the panel and dies with it.
      model.setSelected({ hostId: remembered.hostId, sessionId: remembered.sessionId })
      panel.restoreActive({ host, sessionId: remembered.sessionId, cwd: remembered.cwd })
    } else {
      void context.workspaceState.update(ACTIVE_SESSION_KEY, undefined)
    }
  }
  void model.refresh()

  context.subscriptions.push(
    startDevReload(context, [panel, sidebar, gateways, ...Object.values(sections)]),
    // These settings are baked into the panel's HTML for the first paint, so changing
    // one means re-rendering it — the same re-render the dev reloader does.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('workerdeck.fontSize') ||
        e.affectsConfiguration('workerdeck.fontFamily') ||
        e.affectsConfiguration('workerdeck.transcriptDensity') ||
        e.affectsConfiguration('workerdeck.transcriptVariant') ||
        e.affectsConfiguration('workerdeck.terminal') ||
        // The cell follows the editor's own size unless overridden, so an editor change is ours.
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.lineHeight')
      ) {
        panel.reloadWebview()
      }
      // Which badges the bar carries is a per-render read, so a change is only a re-render.
      if (e.affectsConfiguration('workerdeck.statusBar')) {
        statusBar.refresh()
        unread.render()
        subagents.render()
        // The unread item is the one badge that also owns a poll.
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
    subagents,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Retained: the add/edit form is the one place typing can be lost to a view being torn
    // down, and its auth key can only be re-fetched by asking to edit the gateway again.
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
    // Creating a session is a native multi-step QuickPick — see `new-session.ts`.
    vscode.commands.registerCommand('workerdeck.newSession', () => createSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.resumeSession', () => resumeSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

    // One toggle, two commands: a `view/title` button has a fixed icon, so open and closed
    // are a pair of commands with opposite `when` clauses.
    vscode.commands.registerCommand('workerdeck.showFilter', () => sidebar.setFilterOpen(true)),
    vscode.commands.registerCommand('workerdeck.hideFilter', () => sidebar.setFilterOpen(false)),
    vscode.commands.registerCommand('workerdeck.toggleFilter', () => sidebar.toggleFilter()),

    // The status bar's two pickers. A StatusBarItem carries one command and no dropdown,
    // so command → QuickPick is the native shape. The options come from the panel's vitals.
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
      if (picked) {
        panel.setModel(picked.value)
      }
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
          // A mode the session can never be granted stays visible and unpickable.
          alwaysShow: true,
          picked: m.value === current,
          disabled: m.disabled,
        })),
        { title: 'WorkerDeck: permission mode' },
      )
      if (picked && !picked.disabled) {
        panel.setPermissionMode(picked.mode)
      }
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
        uri.scheme === WorkerdeckFileSystem.scheme ? `${active.host.name}: ${active.cwd.split('/').pop() ?? active.cwd}` : undefined
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
        uri,
        name,
      })
    }),
  )
}

export function deactivate(): void {}
