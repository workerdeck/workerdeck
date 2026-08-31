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

const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
}

const HAS_SESSION_KEY = 'workerdeck.hasSession'

const UNREAD_WATCHER = 'workerdeck.statusBar.unread'

const ACTIVE_SESSION_KEY = 'workerdeck.activeSession'

export const activate = (context: vscode.ExtensionContext): void => {
  const store = new HostStore(context)
  const model = new SessionsModel(store)
  const fs = new WorkerdeckFileSystem(store)

  let vitals: SessionVitals | undefined
  const statusBar = new SessionStatusBar()
  const unread = new UnreadStatusItem()
  const subagents = new SubagentStatusItem()
  const watermarks = createWatermarks(context)
  const syncUnreadWatcher = () => model.setWatching(UNREAD_WATCHER, badgeEnabled('unread') || badgeEnabled('subagents'))
  syncUnreadWatcher()

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
  const gateways = new GatewaysViewProvider(context.extensionUri, store, {
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    setWatching: (watching) => model.setWatching(GatewaysViewProvider.viewId, watching),
  })
  model.onDidChange(() => gateways.push())

  model.onDidChange(() => pushSections())
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
  model.onDidChange(() => markSeen())

  // Panel and sidebar reference each other only through these delegates; construction order breaks the cycle.
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
      // Only a status change nudges the model: the rest of `vitals` moves on every stream delta.
      const moved = v.status !== vitals?.status
      vitals = v
      if (moved) {
        model.nudge()
      }
      markSeen()
      pushSections()
      pushStatusBar()
    },
    subagent: (toolUseId) => model.setSelectedSubagent(toolUseId),
    unseen: (hostId, sessionId) => {
      const mark = watermarks.get(hostId, sessionId)
      return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
    },
    visibilityChanged: () => {
      markSeen()
      // The mark is written from the last poll, so refresh and mark once more — with `force`, the panel being already hidden.
      void model.refresh().then(() => markSeen(true))
    },
  })
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
  const selectSession = async (hostId: string, sessionId: string, subagentToolUseId?: string, revealToolUseId?: string) => {
    const host = store.get(hostId)
    if (!host) {
      return
    }
    const info = model.sessionsOf(hostId).find((s) => s.id === sessionId)
    // Re-clicking the session already on screen does not remount the panel, so nothing would re-send the readings.
    if (!panel.isShowing(hostId, sessionId)) {
      vitals = undefined
    }
    model.setSelected({ hostId, sessionId, subagentToolUseId })
    void context.workspaceState.update(ACTIVE_SESSION_KEY, { hostId, sessionId, cwd: info?.cwd })
    await panel.show({ host, sessionId, cwd: info?.cwd }, { focus: !subagentToolUseId && !revealToolUseId })
    if (subagentToolUseId) {
      panel.openSubagent(subagentToolUseId)
    } else if (revealToolUseId) {
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

  const sessionFlow: NewSessionDeps = {
    store,
    state: () => model.sidebarState(),
    refresh: () => model.refresh(),
    reveal: selectSession,
  }

  panel.onDidChangeActive(() => pushStatusBar())
  model.onDidChange(() => pushStatusBar())
  pushStatusBar()

  const syncHasSession = (has: boolean) => void vscode.commands.executeCommand('setContext', HAS_SESSION_KEY, has)
  panel.onDidChangeActive((active) => syncHasSession(active !== undefined))
  syncHasSession(panel.active !== undefined)

  // Must stay after the `onDidChangeActive` subscribers above, so restoring feeds the status bar and the `when` key the way selecting would.
  const remembered = context.workspaceState.get<{
    hostId: string
    sessionId: string
    cwd?: string
  }>(ACTIVE_SESSION_KEY)
  if (remembered) {
    const host = store.get(remembered.hostId)
    if (host) {
      model.setSelected({ hostId: remembered.hostId, sessionId: remembered.sessionId })
      panel.restoreActive({ host, sessionId: remembered.sessionId, cwd: remembered.cwd })
    } else {
      void context.workspaceState.update(ACTIVE_SESSION_KEY, undefined)
    }
  }
  void model.refresh()

  context.subscriptions.push(
    startDevReload(context, [panel, sidebar, gateways, ...Object.values(sections)]),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('workerdeck.fontSize') ||
        e.affectsConfiguration('workerdeck.fontFamily') ||
        e.affectsConfiguration('workerdeck.transcriptDensity') ||
        e.affectsConfiguration('workerdeck.transcriptVariant') ||
        e.affectsConfiguration('workerdeck.terminal') ||
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.lineHeight')
      ) {
        panel.reloadWebview()
      }
      if (e.affectsConfiguration('workerdeck.statusBar')) {
        statusBar.refresh()
        unread.render()
        subagents.render()
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
    // Retained: a torn-down add/edit form loses typing, and its auth key can only be re-fetched by asking to edit the gateway again.
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
    vscode.commands.registerCommand('workerdeck.newSession', () => createSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.resumeSession', () => resumeSession(sessionFlow)),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

    vscode.commands.registerCommand('workerdeck.showFilter', () => sidebar.setFilterOpen(true)),
    vscode.commands.registerCommand('workerdeck.hideFilter', () => sidebar.setFilterOpen(false)),
    vscode.commands.registerCommand('workerdeck.toggleFilter', () => sidebar.toggleFilter()),

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

export const deactivate = (): void => {}
