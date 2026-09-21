import { sessionState } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { startDevReload } from './dev-reload.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { GatewaysViewProvider } from './gateways-view.ts'
import { addGateway, editGateway, type GatewayFlowDeps } from './new-gateway.ts'
import { HostStore, isLoopbackHost } from './hosts.ts'
import { createSession, resumeSession, type NewSessionDeps } from './new-session.ts'
import { SessionPanelView } from './panel.ts'
import { SessionEditorTab } from './session-tab.ts'
import { SurfaceRegistry } from './surfaces.ts'
import type { AnySurface, SessionRef, SurfaceDelegate } from './session-surface.ts'
import type { SelectOptions } from './sidebar.ts'
import type { SurfaceState } from './bridge-protocol.ts'
import { addProfile, editProfile, manageProfiles, removeProfile, type ProfileFlowDeps } from './profiles.ts'
import { ProfilesModel } from './profiles-model.ts'
import { ProfilesViewProvider } from './profiles-view.ts'
import { SectionViewProvider, type SectionKind } from './section-view.ts'
import { hostActions, HostStatusItem } from './host/status-item.ts'
import { HostSupervisor } from './host/supervisor.ts'
import { HOST_SECTION } from './host/settings.ts'
import { SessionsModel } from './sessions-model.ts'
import { SidebarProvider } from './sidebar.ts'
import { SessionStatusBar, SubagentStatusItem, UnreadStatusItem, badgeEnabled, currentModel, modelLabel } from './status-bar.ts'
import { createWatermarks, unseenCount } from './watermarks.ts'

const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
  tasks: 'workerdeck.tasks',
}

const HAS_SESSION_KEY = 'workerdeck.hasSession'
const PANEL_HAS_SESSION_KEY = 'workerdeck.panelHasSession'
const TASKS_SHOW_COMPLETED_KEY = 'workerdeck.tasksShowCompleted.v1'
const TASKS_SHOW_COMPLETED_CONTEXT_KEY = 'workerdeck.tasksShowCompleted'

const UNREAD_WATCHER = 'workerdeck.statusBar.unread'

const ACTIVE_SESSION_KEY = 'workerdeck.activeSession'

export function activate(context: vscode.ExtensionContext): void {
  const store = new HostStore(context)
  const model = new SessionsModel(store)
  const fs = new WorkerdeckFileSystem(store)

  const statusBar = new SessionStatusBar()
  const unread = new UnreadStatusItem()
  const subagents = new SubagentStatusItem()
  const watermarks = createWatermarks(context)
  const syncUnreadWatcher = () => model.setWatching(UNREAD_WATCHER, badgeEnabled('unread') || badgeEnabled('subagents'))
  syncUnreadWatcher()

  const infoOf = (hostId: string, sessionId: string) => model.sessionsOf(hostId).find((s) => s.id === sessionId)
  const titleOf = (hostId: string, sessionId: string) => infoOf(hostId, sessionId)?.title ?? sessionId.slice(0, 8)
  const sessionRef = (hostId: string, sessionId: string, cwd?: string): SessionRef | undefined => {
    const host = store.get(hostId)
    return host ? { host, sessionId, cwd: cwd ?? infoOf(hostId, sessionId)?.cwd } : undefined
  }

  const markSeen = (surface: AnySurface, force = false) => {
    const session = surface.session
    if (!session || (!surface.visible && !force)) {
      return
    }
    const info = infoOf(session.host.id, session.sessionId)
    const moved = watermarks.mark(session.host.id, session.sessionId, {
      itemCount: surface.vitals?.itemCount,
      activity: info?.activityCount,
      prose: info?.proseCount,
      turns: info?.numTurns,
    })
    if (moved) {
      sidebar.refreshUnread()
    }
  }
  const markAllSeen = () => {
    for (const surface of registry.all()) {
      markSeen(surface)
    }
  }

  let tasksShowCompleted = context.globalState.get<boolean>(TASKS_SHOW_COMPLETED_KEY) ?? false
  const feed = {
    state: () => model.sidebarState(),
    vitals: () => registry.focused.vitals,
    tasksShowCompleted: () => tasksShowCompleted,
  }
  const sections = Object.fromEntries(
    (Object.keys(SECTION_VIEWS) as SectionKind[]).map((kind) => [kind, new SectionViewProvider(context.extensionUri, store, kind, feed)]),
  ) as Record<SectionKind, SectionViewProvider>
  const pushSections = () => {
    for (const provider of Object.values(sections)) {
      provider.push()
    }
  }
  const gatewayFlow: GatewayFlowDeps = { store, refresh: () => model.refresh() }
  const profilesModel = new ProfilesModel(store)
  const profileFlow: ProfileFlowDeps = {
    store,
    hosts: () => store.all(),
    refresh: async () => {
      await Promise.all([model.refresh(), profilesModel.refresh()])
    },
  }
  const profiles = new ProfilesViewProvider(context.extensionUri, profilesModel, {
    refresh: () => profilesModel.refresh(),
    add: (hostId) => addProfile(profileFlow, hostId),
    edit: (hostId, name) => editProfile(profileFlow, hostId, name),
    remove: (hostId, name) => removeProfile(profileFlow, hostId, name),
  })
  profilesModel.onDidChange(() => profiles.push())
  const gateways = new GatewaysViewProvider(context.extensionUri, store, {
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    setWatching: (watching) => model.setWatching(GatewaysViewProvider.viewId, watching),
    edit: (hostId) => editGateway(gatewayFlow, hostId),
  })
  model.onDidChange(() => gateways.push())

  model.onDidChange(() => pushSections())
  model.setUnseenProvider((sessions) => {
    const unseen: Record<string, number> = {}
    for (const [hostId, list] of Object.entries(sessions)) {
      for (const info of list) {
        // `unseenCount` owns the prose → rows → turns ladder; a second copy of it here is
        // how this badge and the dashboard's came to disagree.
        const fresh = unseenCount(watermarks.get(hostId, info.id), info)
        if (fresh > 0) {
          unseen[`${hostId}:${info.id}`] = fresh
        }
      }
    }
    return unseen
  })
  model.onDidChange(() => markAllSeen())

  // Surfaces, the registry and the sidebar reference each other only through these delegates; construction order breaks the cycle.
  let sidebar: SidebarProvider
  let registry: SurfaceRegistry
  const lastStatus = new WeakMap<AnySurface, string | undefined>()
  const surfaceDelegate: SurfaceDelegate = {
    openPanel: async (surface, p) => {
      registry.setFocused(surface)
      if (p === 'skills') {
        await pickCommand(surface)
        return
      }
      if (p === 'files') {
        await vscode.commands.executeCommand('workerdeck.openProjectFolder')
        return
      }
      await vscode.commands.executeCommand(`${SECTION_VIEWS[p]}.focus`)
    },
    vitals: (surface) => {
      // Only a status change nudges the model: the rest of `vitals` moves on every stream delta.
      const status = surface.vitals?.status
      if (status !== lastStatus.get(surface)) {
        lastStatus.set(surface, status)
        model.nudge()
      }
      markSeen(surface)
      if (surface === registry.focused) {
        pushSections()
        pushStatusBar()
      }
    },
    subagent: (surface) => {
      if (surface === registry.focused) {
        model.setSelectedSubagent(surface.subagentToolUseId)
      }
    },
    unseen: (hostId, sessionId) => {
      const mark = watermarks.get(hostId, sessionId)
      return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
    },
    visibilityChanged: (surface) => {
      markSeen(surface)
      // The mark is written from the last poll, so refresh and mark once more - with `force`, the surface being already hidden.
      void model.refresh().then(() => markSeen(surface, true))
    },
    focused: (surface) => registry.setFocused(surface),
  }
  const panel = new SessionPanelView(context.extensionUri, store, {
    ...surfaceDelegate,
    focusHeld: async (held) => {
      const tab = registry.tabFor(held.host.id, held.sessionId)
      if (tab) {
        await tab.focus()
        registry.setFocused(tab)
      }
    },
    sessionChanged: (session) => {
      void context.workspaceState.update(
        ACTIVE_SESSION_KEY,
        session ? { hostId: session.host.id, sessionId: session.sessionId, cwd: session.cwd } : undefined,
      )
      registry.changed()
    },
  })
  registry = new SurfaceRegistry(panel)
  const tabDelegate = {
    ...surfaceDelegate,
    closed: (tab: SessionEditorTab) => {
      registry.remove(tab)
      const session = tab.session
      // Closing the tab hands the session back to a panel still waiting on it; a panel that moved on keeps its own.
      if (session && panel.heldSession && sameRef(panel.heldSession, session)) {
        void panel.show(session, { quiet: true })
      }
    },
  }
  const closeTab = (tab: SessionEditorTab) => {
    tab.dispose()
    registry.remove(tab)
  }
  const openTab = (ref: SessionRef, column: vscode.ViewColumn, focus: boolean): SessionEditorTab => {
    const title = titleOf(ref.host.id, ref.sessionId)
    if (panel.holds(ref.host.id, ref.sessionId)) {
      panel.hold(ref, title)
    }
    const tab = SessionEditorTab.create(context.extensionUri, store, tabDelegate, ref, title, column, focus)
    const info = infoOf(ref.host.id, ref.sessionId)
    if (info) {
      tab.setState(sessionState(info))
    }
    registry.add(tab)
    return tab
  }
  const moveToPanel = async (tab: SessionEditorTab) => {
    const session = tab.session
    closeTab(tab)
    if (session) {
      await panel.show(session, { focus: true })
      registry.setFocused(panel)
    }
  }

  const pushStatusBar = () => {
    const surface = registry.focused
    const session = surface.session
    if (!session) {
      statusBar.update(undefined, undefined)
      return
    }
    const info = infoOf(session.host.id, session.sessionId)
    statusBar.update(
      {
        title: info?.title ?? session.sessionId.slice(0, 8),
        hostName: session.host.name,
        cost: info?.costUsd ?? info?.totalCostUsd,
      },
      surface.vitals,
    )
  }
  const syncSelected = () => {
    const surface = registry.focused
    const session = surface.session
    model.setSelected(
      session ? { hostId: session.host.id, sessionId: session.sessionId, subagentToolUseId: surface.subagentToolUseId } : undefined,
    )
  }
  const selectSession = async (hostId: string, sessionId: string, options: SelectOptions = {}) => {
    const ref = sessionRef(hostId, sessionId)
    if (!ref) {
      return
    }
    const composerFocus = !options.subagentToolUseId && !options.revealToolUseId
    let surface: AnySurface
    const tab = registry.tabFor(hostId, sessionId)
    if (tab) {
      if (options.target === 'editor-beside') {
        tab.show(vscode.ViewColumn.Beside)
      } else {
        tab.show()
      }
      if (composerFocus) {
        tab.focusComposer()
      }
      surface = tab
    } else if (options.target) {
      surface = openTab(ref, options.target === 'editor-beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, composerFocus)
    } else {
      await panel.show(ref, { focus: composerFocus })
      surface = panel
    }
    registry.setFocused(surface)
    if (options.subagentToolUseId) {
      surface.openSubagent(options.subagentToolUseId)
    } else if (options.revealToolUseId) {
      surface.reveal(options.revealToolUseId)
    }
  }
  sidebar = new SidebarProvider(context, context.extensionUri, store, model, {
    selectSession,
    sessionDeleted: async (hostId, sessionId) => {
      const tab = registry.tabFor(hostId, sessionId)
      if (tab) {
        closeTab(tab)
      }
      if (panel.holdsOrHeld(hostId, sessionId)) {
        await panel.show(undefined)
      }
    },
    surfaceOf: (hostId, sessionId) =>
      registry.tabFor(hostId, sessionId) ? 'editor' : panel.holds(hostId, sessionId) ? 'panel' : undefined,
    moveToPanel: async (hostId, sessionId) => {
      const tab = registry.tabFor(hostId, sessionId)
      if (tab) {
        await moveToPanel(tab)
      }
    },
    revealGateways: (options) => (options.add ? addGateway(gatewayFlow) : gateways.reveal()),
    unread: (rows, waiting) => unread.update(rows, waiting),
    subagents: (running, sessions) => subagents.update(running, sessions),
  })

  const sessionFlow: NewSessionDeps = {
    store,
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    reveal: (hostId, sessionId) => selectSession(hostId, sessionId),
  }

  const syncContextKeys = () => {
    void vscode.commands.executeCommand('setContext', HAS_SESSION_KEY, registry.hasSession())
    void vscode.commands.executeCommand('setContext', PANEL_HAS_SESSION_KEY, panel.session !== undefined)
  }
  const syncSurfaces = () => {
    syncSelected()
    syncContextKeys()
    model.setOpen(registry.openMap())
    pushStatusBar()
    pushSections()
  }
  registry.onDidChange(() => syncSurfaces())
  registry.onDidChangeFocus(() => syncSurfaces())
  model.onDidChange(() => {
    for (const tab of registry.tabs()) {
      const session = tab.session
      const info = session && infoOf(session.host.id, session.sessionId)
      if (info) {
        tab.setTitle(info.title ?? session.sessionId.slice(0, 8))
        tab.setState(sessionState(info))
      }
    }
    const held = panel.heldSession
    if (held) {
      panel.retitleHeld(titleOf(held.host.id, held.sessionId))
    }
    pushStatusBar()
  })
  syncSurfaces()

  const setTasksShowCompleted = (showCompleted: boolean) => {
    tasksShowCompleted = showCompleted
    void context.globalState.update(TASKS_SHOW_COMPLETED_KEY, showCompleted)
    void vscode.commands.executeCommand('setContext', TASKS_SHOW_COMPLETED_CONTEXT_KEY, showCompleted)
    pushSections()
  }
  setTasksShowCompleted(tasksShowCompleted)

  // Must stay after the registry subscribers above, so restoring feeds the status bar and the `when` keys the way selecting would.
  const remembered = context.workspaceState.get<SurfaceState>(ACTIVE_SESSION_KEY)
  if (remembered) {
    const ref = sessionRef(remembered.hostId, remembered.sessionId, remembered.cwd)
    if (ref) {
      panel.restore(ref)
    } else {
      void context.workspaceState.update(ACTIVE_SESSION_KEY, undefined)
    }
  }
  const hostStatus = new HostStatusItem(() => model.gatewayRows())
  // Host Mode runs the server where the workspace is. `extensionKind` alone cannot express that:
  // a local window has no remote extension host to be `Workspace` relative to, so it reports `UI`
  // and gating on `Workspace` refuses every ordinary window. The one host that must not start a
  // server is a UI-side copy while a remote is attached - there the workspace is the other machine.
  const uiSideOfRemote = vscode.env.remoteName !== undefined && context.extension.extensionKind === vscode.ExtensionKind.UI
  const hostSupervisor = uiSideOfRemote
    ? undefined
    : new HostSupervisor(context, store, { sessionsOf: (id) => model.sessionsOf(id), refresh: () => model.refresh() })
  if (hostSupervisor) {
    hostSupervisor.onDidChangeState((state) => hostStatus.update(state))
    hostStatus.update(hostSupervisor.state)
    void hostSupervisor.sync()
  }
  // The badge counts gateways, so it follows the model as well as the supervisor - and it renders
  // once here because a window with no supervisor (the UI side of a remote) still has gateways.
  model.onDidChange(() => hostStatus.render())
  hostStatus.render()
  const requireHost = (): HostSupervisor | undefined => {
    if (!hostSupervisor) {
      void vscode.window.showInformationMessage(
        `WorkerDeck: Host Mode runs where the workspace is - on ${vscode.env.remoteName ?? 'the remote'}, not in this local window.`,
      )
    }
    return hostSupervisor
  }

  void model.refresh()

  context.subscriptions.push(
    startDevReload(context, [{ reloadWebview: () => registry.reloadAll() }, sidebar, gateways, profiles, ...Object.values(sections)]),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('workerdeck.fontSize') ||
        e.affectsConfiguration('workerdeck.fontFamily') ||
        e.affectsConfiguration('workerdeck.transcriptDensity') ||
        e.affectsConfiguration('workerdeck.transcriptVariant') ||
        e.affectsConfiguration('workerdeck.catchUpMode') ||
        e.affectsConfiguration('workerdeck.terminal') ||
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.lineHeight')
      ) {
        registry.reloadAll()
      }
      if (e.affectsConfiguration(HOST_SECTION)) {
        hostStatus.render()
        void hostSupervisor?.sync()
      }
      if (e.affectsConfiguration('workerdeck.statusBar')) {
        statusBar.refresh()
        unread.render()
        subagents.render()
        syncUnreadWatcher()
      }
    }),
    model,
    profilesModel,
    registry,
    panel,
    sidebar,
    gateways,
    profiles,
    fs,
    statusBar,
    unread,
    subagents,
    hostStatus,
    ...(hostSupervisor ? [hostSupervisor] : []),
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(GatewaysViewProvider.viewId, gateways),
    vscode.window.registerWebviewViewProvider(ProfilesViewProvider.viewId, profiles),
    ...Object.entries(sections).map(([kind, provider]) =>
      vscode.window.registerWebviewViewProvider(SECTION_VIEWS[kind as SectionKind], provider),
    ),
    ...Object.values(sections),
    vscode.window.registerWebviewViewProvider(SessionPanelView.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer(SessionEditorTab.viewType, {
      deserializeWebviewPanel: async (webviewPanel, state: SurfaceState | undefined) => {
        const ref = state && sessionRef(state.hostId, state.sessionId, state.cwd)
        if (!ref || registry.tabFor(ref.host.id, ref.sessionId)) {
          webviewPanel.dispose()
          return
        }
        const title = titleOf(ref.host.id, ref.sessionId)
        if (panel.holds(ref.host.id, ref.sessionId)) {
          panel.hold(ref, title)
        }
        registry.add(SessionEditorTab.restore(context.extensionUri, store, tabDelegate, webviewPanel, ref, title))
      },
    }),
    vscode.workspace.registerFileSystemProvider(WorkerdeckFileSystem.scheme, fs, {
      isCaseSensitive: true,
    }),

    vscode.commands.registerCommand('workerdeck.host.start', () => requireHost()?.start()),
    vscode.commands.registerCommand('workerdeck.host.stop', () => requireHost()?.stop()),
    vscode.commands.registerCommand('workerdeck.host.restart', () => requireHost()?.restart()),
    vscode.commands.registerCommand('workerdeck.host.reload', () => requireHost()?.hotReload()),
    vscode.commands.registerCommand('workerdeck.host.openDashboard', () => requireHost()?.openDashboard()),
    vscode.commands.registerCommand('workerdeck.host.showLog', () => requireHost()?.showLog()),
    vscode.commands.registerCommand('workerdeck.host.actions', () => hostActions(hostSupervisor?.state ?? { kind: 'disabled' })),
    vscode.commands.registerCommand('workerdeck.host.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:workerdeck.workerdeck ${HOST_SECTION}`),
    ),

    vscode.commands.registerCommand('workerdeck.manageProfiles', () => manageProfiles(profileFlow)),
    vscode.commands.registerCommand('workerdeck.showProfiles', () => profiles.reveal()),
    vscode.commands.registerCommand('workerdeck.addProfile', () => addProfile(profileFlow)),
    vscode.commands.registerCommand('workerdeck.refreshProfiles', () => profilesModel.refresh()),
    vscode.commands.registerCommand('workerdeck.addGateway', () => addGateway(gatewayFlow)),
    vscode.commands.registerCommand('workerdeck.showGateways', () => gateways.reveal()),
    vscode.commands.registerCommand('workerdeck.newSession', () => createSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.resumeSession', () => resumeSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

    vscode.commands.registerCommand('workerdeck.showFilter', () => sidebar.setFilterOpen(true)),
    vscode.commands.registerCommand('workerdeck.hideFilter', () => sidebar.setFilterOpen(false)),
    vscode.commands.registerCommand('workerdeck.toggleFilter', () => sidebar.toggleFilter()),

    vscode.commands.registerCommand('workerdeck.subagentsActive', () => sidebar.setSubagents('all')),
    vscode.commands.registerCommand('workerdeck.subagentsAll', () => sidebar.setSubagents('none')),
    vscode.commands.registerCommand('workerdeck.subagentsNone', () => sidebar.setSubagents('active')),

    vscode.commands.registerCommand('workerdeck.showCompletedTasks', () => setTasksShowCompleted(true)),
    vscode.commands.registerCommand('workerdeck.hideCompletedTasks', () => setTasksShowCompleted(false)),

    vscode.commands.registerCommand('workerdeck.openSessionInEditor', async () => {
      const session = panel.session
      if (!session) {
        void vscode.window.showInformationMessage('WorkerDeck: open a session in the Agent panel first.')
        return
      }
      await selectSession(session.host.id, session.sessionId, { target: 'editor' })
    }),
    vscode.commands.registerCommand('workerdeck.moveSessionToPanel', async () => {
      const focused = registry.focused
      const tab = registry.activeTab() ?? (focused.kind === 'editor' ? (focused as SessionEditorTab) : undefined)
      if (!tab) {
        void vscode.window.showInformationMessage('WorkerDeck: no session tab is active.')
        return
      }
      await moveToPanel(tab)
    }),

    vscode.commands.registerCommand('workerdeck.selectModel', async () => {
      const surface = registry.focused
      const vitals = surface.vitals
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
        surface.setModel(picked.value)
      }
    }),
    vscode.commands.registerCommand('workerdeck.selectPermissionMode', async () => {
      const surface = registry.focused
      const vitals = surface.vitals
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
        surface.setPermissionMode(picked.mode)
      }
    }),

    vscode.commands.registerCommand('workerdeck.useSkill', () => pickCommand(registry.focused)),

    vscode.commands.registerCommand('workerdeck.openProjectFolder', async () => {
      const session = registry.focused.session
      if (!session?.cwd) {
        void vscode.window.showInformationMessage('WorkerDeck: open a session first.')
        return
      }
      const uri = isLoopbackHost(session.host)
        ? vscode.Uri.file(session.cwd)
        : vscode.Uri.from({
            scheme: WorkerdeckFileSystem.scheme,
            authority: session.host.id.toLowerCase(),
            path: session.cwd,
          })
      const name =
        uri.scheme === WorkerdeckFileSystem.scheme ? `${session.host.name}: ${session.cwd.split('/').pop() ?? session.cwd}` : undefined
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
        uri,
        name,
      })
    }),
  )
}

function sameRef(a: SessionRef, b: SessionRef): boolean {
  return a.host.id === b.host.id && a.sessionId === b.sessionId
}

// The panel runs `panelSurface: 'external'`, so the in-panel skills dialog never mounts - this QuickPick is its
// native stand-in, over the same merged list the composer's `/` offers.
async function pickCommand(surface: AnySurface): Promise<void> {
  const rows = surface.vitals?.composerCommands
  if (!rows) {
    void vscode.window.showInformationMessage('WorkerDeck: commands are listed once the session connects - send a message first.')
    return
  }
  if (rows.length === 0) {
    void vscode.window.showInformationMessage('WorkerDeck: this session offers no commands or skills.')
    return
  }
  const picked = await vscode.window.showQuickPick(
    rows.map((row) => ({
      label: row.label,
      description: [row.kind === 'skill' ? 'skill' : undefined, row.scope, row.enabled ? undefined : 'disabled']
        .filter(Boolean)
        .join(' - '),
      detail: row.description?.split('\n')[0],
      insertText: row.insertText,
      // A skill the session reported but disabled stays visible and unpickable, like an ungrantable permission mode.
      alwaysShow: true,
      disabled: !row.enabled,
    })),
    { title: 'WorkerDeck: commands and skills', placeHolder: 'Insert into the composer' },
  )
  if (picked && !picked.disabled) {
    surface.insertComposerText(picked.insertText)
  }
}

export function deactivate(): void {}
