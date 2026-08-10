import * as vscode from 'vscode'
import type { SessionVitals } from '@workerdeck/ui'
import { HostStore, isLoopbackHost } from './hosts.ts'
import { SessionsModel } from './sessions-model.ts'
import { SessionPanelProvider } from './panel.ts'
import { SidebarProvider } from './sidebar.ts'
import { SectionViewProvider, type SectionKind } from './section-view.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { startDevReload } from './dev-reload.ts'
import { SessionStatusBar, currentModel, modelLabel } from './status-bar.ts'
import { Watermarks } from './watermarks.ts'

/** Section view ids — each its OWN view, so VS Code owns collapse/placement. */
const SECTION_VIEWS: Record<SectionKind, string> = {
  info: 'workerdeck.sessionInfo',
  context: 'workerdeck.context',
  usage: 'workerdeck.usage',
  mcp: 'workerdeck.mcp',
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new HostStore(context)
  const model = new SessionsModel(store)
  const fs = new WorkerdeckFileSystem(store)

  // Vitals for the SELECTED session, relayed panel → here → section views.
  // Cleared on selection change so a new session never wears the old one's
  // readings while its first snapshot is still in flight.
  let vitals: SessionVitals | undefined
  const statusBar = new SessionStatusBar()
  const watermarks = new Watermarks(context)

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
    watermarks.mark(active.host.id, active.sessionId, {
      itemCount: vitals?.itemCount,
      activity: info?.activityCount,
      turns: info?.numTurns,
    })
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
      vitals = v
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
  sidebar = new SidebarProvider(context, context.extensionUri, store, model, {
    selectSession: async (hostId, sessionId) => {
      const host = store.get(hostId)
      if (!host) return
      const info = model.sessionsOf(hostId).find((s) => s.id === sessionId)
      // Only a REAL change drops the readings. Re-clicking the session already
      // on screen doesn't remount the panel, so nothing would ever re-send them
      // — Context and Usage would sit empty until the next event moved one.
      if (!panel.isShowing(hostId, sessionId)) vitals = undefined
      model.setSelected({ hostId, sessionId })
      await panel.show({ host, sessionId, cwd: info?.cwd })
    },
    clearPanelIfActive: async (sessionId) => {
      if (panel.active?.sessionId === sessionId) {
        vitals = undefined
        model.setSelected(undefined)
        await panel.show(undefined)
      }
    },
    activeSessionId: () => panel.active?.sessionId,
  })

  // The window status bar IS the agent's status bar — the panel renders none of
  // its own (`statusSurface='external'` in the webview). Fed from both sides:
  // vitals for the live readings, the sessions poll for the title and cost.
  panel.onDidChangeActive(() => pushStatusBar())
  model.onDidChange(() => pushStatusBar())
  pushStatusBar()

  context.subscriptions.push(
    startDevReload(context, [panel, sidebar, ...Object.values(sections)]),
    // The typeface is baked into the panel's HTML (it must be right on the first
    // paint), so changing it means re-rendering it — the same re-render the dev
    // reloader does, after which the webview re-announces itself. The panel
    // alone: the sidebar and section views follow VS Code's UI font.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workerdeck.fontFamily')) panel.reloadWebview()
      // Which badges the window bar carries is a per-render read, so showing
      // and hiding one is just a re-render against the readings we already hold.
      if (e.affectsConfiguration('workerdeck.statusBar')) statusBar.refresh()
    }),
    model,
    panel,
    sidebar,
    fs,
    statusBar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
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

    vscode.commands.registerCommand('workerdeck.addGateway', () =>
      sidebar.navigate({ kind: 'wd-navigate', screen: 'gateway' }),
    ),
    vscode.commands.registerCommand('workerdeck.gateways', () =>
      sidebar.navigate({ kind: 'wd-navigate', screen: 'gateways' }),
    ),
    vscode.commands.registerCommand('workerdeck.newSession', () =>
      sidebar.navigate({ kind: 'wd-navigate', screen: 'new-session' }),
    ),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

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
