import * as vscode from 'vscode'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { SessionVitals } from '@workerdeck/ui'
import { HostStore, isLoopbackHost } from './hosts.ts'
import { SessionsModel } from './sessions-model.ts'
import { SessionPanelProvider } from './panel.ts'
import { SidebarProvider } from './sidebar.ts'
import { SectionViewProvider, type SectionKind } from './section-view.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { startDevReload } from './dev-reload.ts'
import { SessionStatusBar } from './status-bar.ts'

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

  const feed = {
    state: () => model.sidebarState(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
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

  /**
   * `when`-clause contexts: a section view is ABSENT (not empty) when nothing
   * is selected or the engine forswears its capability. Capabilities come from
   * live vitals when present, the rollup otherwise, the engine default last.
   */
  const updateContexts = () => {
    const selected = feed.state().selected
    const info =
      selected && model.sessionsOf(selected.hostId).find((s) => s.id === selected.sessionId)
    const caps =
      vitals?.capabilities ?? info?.capabilities ?? ENGINE_CAPABILITIES[info?.engine ?? 'claude']
    void vscode.commands.executeCommand('setContext', 'workerdeck.sessionSelected', !!info)
    void vscode.commands.executeCommand('setContext', 'workerdeck.capContext', !!caps.contextUsage)
    void vscode.commands.executeCommand('setContext', 'workerdeck.capUsage', !!caps.rateLimits)
    void vscode.commands.executeCommand('setContext', 'workerdeck.capMcp', !!caps.mcpStatus)
  }
  model.onDidChange(() => {
    updateContexts()
    pushSections()
  })
  updateContexts()

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
      updateContexts()
      pushSections()
      pushStatusBar()
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
  sidebar = new SidebarProvider(context.extensionUri, store, model, {
    selectSession: async (hostId, sessionId) => {
      const host = store.get(hostId)
      if (!host) return
      const info = model.sessionsOf(hostId).find((s) => s.id === sessionId)
      vitals = undefined
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
    vscode.commands.registerCommand('workerdeck.toggleViewConfig', () =>
      sidebar.toggleViewConfig(),
    ),
    vscode.commands.registerCommand('workerdeck.newSession', () =>
      sidebar.navigate({ kind: 'wd-navigate', screen: 'new-session' }),
    ),
    vscode.commands.registerCommand('workerdeck.refreshSessions', () => model.refresh()),

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
