import { sessionState } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { hostCommands, pickCommand, registerCommands, sessionCommands, viewCommands } from './commands.ts'
import { startDevReload } from './dev-reload.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { GatewaysViewProvider } from './gateways-view.ts'
import { AgentAvatarCache } from './agent-avatars.ts'
import { addGateway, editGateway, type GatewayFlowDeps } from './new-gateway.ts'
import { HostStore } from './hosts.ts'
import { createAgent, createSession, resumeSession, type NewSessionDeps } from './new-session.ts'
import { SessionPanelView } from './panel.ts'
import { SessionEditorTab, sessionTitle } from './session-tab.ts'
import { SurfaceRegistry } from './surfaces.ts'
import type { AnySurface, SessionRef, SurfaceDelegate } from './session-surface.ts'
import type { SelectOptions } from './sidebar.ts'
import type { AgentAvatarImage, SurfaceState } from './bridge-protocol.ts'
import { addProfile, editProfile, manageProfiles, removeProfile, type ProfileFlowDeps } from './profiles.ts'
import { ProfilesModel } from './profiles-model.ts'
import { ProfilesViewProvider } from './profiles-view.ts'
import { SectionViewProvider, type SectionKind } from './section-view.ts'
import { HostStatusItem } from './host/status-item.ts'
import { HostSupervisor } from './host/supervisor.ts'
import { HOST_SECTION, needsRestart } from './host/settings.ts'
import { SessionsModel } from './sessions-model.ts'
import { SidebarProvider } from './sidebar.ts'
import { SessionStatusBar, SubagentStatusItem, UnreadStatusItem, badgeEnabled } from './status-bar.ts'
import { createWatermarks, unseenCount } from './watermarks.ts'

const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
}

const HAS_SESSION_KEY = 'workerdeck.hasSession'
const PANEL_HAS_SESSION_KEY = 'workerdeck.panelHasSession'

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
  const titleOf = (hostId: string, sessionId: string) => sessionTitle(infoOf(hostId, sessionId), sessionId)
  const avatars = new AgentAvatarCache(store, context.globalStorageUri)
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

  const feed = {
    state: () => model.sidebarState(),
    vitals: () => registry.focused.vitals,
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
      if (p === 'tasks') {
        await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)
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
    shell: (surface) => {
      if (surface === registry.focused) {
        model.setSelectedShell(surface.shellId)
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
    peerAvatars: (hostId) => {
      const sessions = model.sessionsOf(hostId)
      avatars.ensure({ [hostId]: sessions })
      const byId: Record<string, AgentAvatarImage> = {}
      for (const info of sessions) {
        const image = avatars.imageFor(info)
        if (image) {
          byId[info.id] = image
        }
      }
      return byId
    },
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
    syncTab(tab)
    registry.add(tab)
    return tab
  }
  const syncTab = (tab: SessionEditorTab) => {
    const session = tab.session
    const info = session && infoOf(session.host.id, session.sessionId)
    if (!info) {
      return
    }
    tab.setTitle(sessionTitle(info, session.sessionId))
    tab.setState(sessionState(info))
    tab.setAvatar(avatars.iconFor(info))
    if (info.agent?.avatar) {
      avatars.ensure({ [session.host.id]: [info] })
    }
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
        asleep: info?.engineAsleep === true,
      },
      surface.vitals,
    )
  }
  const syncSelected = () => {
    const surface = registry.focused
    const session = surface.session
    model.setSelected(
      session
        ? { hostId: session.host.id, sessionId: session.sessionId, subagentToolUseId: surface.subagentToolUseId, shellId: surface.shellId }
        : undefined,
    )
  }
  const selectSession = async (hostId: string, sessionId: string, options: SelectOptions = {}) => {
    const ref = sessionRef(hostId, sessionId)
    if (!ref) {
      return
    }
    const composerFocus = !options.subagentToolUseId && !options.revealToolUseId && !options.shellId
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
    } else if (options.shellId) {
      surface.openShell(options.shellId)
    }
  }
  sidebar = new SidebarProvider(context, context.extensionUri, store, model, avatars, {
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
    newSession: (preset) => createSession(sessionFlow, preset),
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
  const pushPeerAvatars = () => {
    for (const surface of registry.all()) {
      surface.pushPeerAvatars()
    }
  }
  model.onDidChange(() => {
    for (const tab of registry.tabs()) {
      syncTab(tab)
    }
    const held = panel.heldSession
    if (held) {
      panel.retitleHeld(titleOf(held.host.id, held.sessionId))
    }
    pushStatusBar()
    pushPeerAvatars()
  })
  avatars.onDidChange(() => {
    for (const tab of registry.tabs()) {
      syncTab(tab)
    }
    pushPeerAvatars()
  })
  syncSurfaces()

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
    avatars,
    startDevReload(context, [{ reloadWebview: () => registry.reloadAll() }, sidebar, gateways, profiles, ...Object.values(sections)]),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('workerdeck.fontSize') ||
        e.affectsConfiguration('workerdeck.fontFamily') ||
        e.affectsConfiguration('workerdeck.transcriptVariant') ||
        e.affectsConfiguration('workerdeck.catchUpMode') ||
        e.affectsConfiguration('workerdeck.showThinking') ||
        e.affectsConfiguration('workerdeck.terminal') ||
        e.affectsConfiguration('workerdeck.actionStyle') ||
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.lineHeight')
      ) {
        registry.reloadAll()
      }
      if (e.affectsConfiguration(HOST_SECTION)) {
        hostStatus.render()
        if (needsRestart(e)) {
          hostSupervisor?.offerRestart()
        }
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

    ...registerCommands(
      hostCommands({ extensionId: context.extension.id, supervisor: hostSupervisor, require: requireHost }),
      viewCommands({ sidebar }),
      sessionCommands({
        store,
        panel,
        registry,
        selectSession,
        moveToPanel,
        sleepSession: (hostId, sessionId) => sidebar.sleepSession(hostId, sessionId),
      }),
      {
        'workerdeck.manageProfiles': () => manageProfiles(profileFlow),
        'workerdeck.showProfiles': () => profiles.reveal(),
        'workerdeck.addProfile': () => addProfile(profileFlow),
        'workerdeck.refreshProfiles': () => profilesModel.refresh(),
        'workerdeck.addGateway': () => addGateway(gatewayFlow),
        'workerdeck.showGateways': () => gateways.reveal(),
        'workerdeck.newSession': () => createSession(sessionFlow),
        'workerdeck.newAgent': () => createAgent(sessionFlow),
        'workerdeck.resumeSession': () => resumeSession(sessionFlow),
        'workerdeck.refreshSessions': () => model.refresh(),
      },
    ),
  )
}

function sameRef(a: SessionRef, b: SessionRef): boolean {
  return a.host.id === b.host.id && a.sessionId === b.sessionId
}

export function deactivate(): void {}
