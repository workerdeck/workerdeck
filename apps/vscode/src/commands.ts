import * as vscode from 'vscode'
import { WorkerdeckFileSystem } from './fsp.ts'
import type { HostStore } from './hosts.ts'
import { isLocalHost } from './machine.ts'
import type { SessionPanelView } from './panel.ts'
import type { AnySurface } from './session-surface.ts'
import type { SessionEditorTab } from './session-tab.ts'
import type { SelectOptions, SidebarProvider } from './sidebar.ts'
import { currentModel, modelLabel } from './status-bar.ts'
import type { SurfaceRegistry } from './surfaces.ts'
import { hostActions } from './host/status-item.ts'
import type { HostSupervisor } from './host/supervisor.ts'
import { HOST_SECTION } from './host/settings.ts'

export type CommandTable = Record<string, (...args: never[]) => unknown>

type PickableItem = vscode.QuickPickItem & { disabled?: boolean }

export type HostCommandDeps = {
  extensionId: string
  supervisor: HostSupervisor | undefined
  require: () => HostSupervisor | undefined
}

export type ViewCommandDeps = {
  sidebar: SidebarProvider
}

export type SessionCommandDeps = {
  store: HostStore
  panel: SessionPanelView
  registry: SurfaceRegistry
  selectSession: (hostId: string, sessionId: string, options?: SelectOptions) => Promise<void>
  moveToPanel: (tab: SessionEditorTab) => Promise<void>
  sleepSession: (hostId: string, sessionId: string) => Promise<void>
}

export function registerCommands(...tables: CommandTable[]): vscode.Disposable[] {
  return tables.flatMap((table) => Object.entries(table).map(([id, run]) => vscode.commands.registerCommand(id, run)))
}

export function hostCommands({ extensionId, supervisor, require }: HostCommandDeps): CommandTable {
  return {
    'workerdeck.host.start': () => require()?.start(),
    'workerdeck.host.stop': () => require()?.stop(),
    'workerdeck.host.restart': () => require()?.restart(),
    'workerdeck.host.reload': () => require()?.hotReload(),
    'workerdeck.host.openDashboard': () => require()?.openDashboard(),
    'workerdeck.host.showLog': () => require()?.showLog(),
    'workerdeck.host.actions': () => hostActions(supervisor?.state ?? { kind: 'disabled' }),
    'workerdeck.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`),
    'workerdeck.host.openSettings': () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} ${HOST_SECTION}`),
  }
}

export function viewCommands({ sidebar }: ViewCommandDeps): CommandTable {
  return {
    'workerdeck.showSearch': () => sidebar.setSearchOpen(true),
    'workerdeck.hideSearch': () => sidebar.setSearchOpen(false),
    'workerdeck.toggleSearch': () => sidebar.toggleSearch(),
    'workerdeck.showFilter': () => sidebar.toggleFilters(),
    'workerdeck.showFilterActive': () => sidebar.toggleFilters(),
    'workerdeck.toggleFilter': () => sidebar.toggleFilters(),
    // Each command sets the state it names: a menu item means a state, not the next one in a cycle.
    'workerdeck.subagentsActive': () => sidebar.setSubagents('active'),
    'workerdeck.subagentsAll': () => sidebar.setSubagents('all'),
    'workerdeck.subagentsNone': () => sidebar.setSubagents('none'),
  }
}

export function sessionCommands({ store, panel, registry, selectSession, moveToPanel, sleepSession }: SessionCommandDeps): CommandTable {
  return {
    'workerdeck.openSessionInEditor': async () => {
      const session = panel.session
      if (!session) {
        void vscode.window.showInformationMessage('WorkerDeck: open a session in the Agent panel first.')
        return
      }
      await selectSession(session.host.id, session.sessionId, { target: 'editor' })
    },
    'workerdeck.moveSessionToPanel': async () => {
      const focused = registry.focused
      const tab = registry.activeTab() ?? (focused.kind === 'editor' ? (focused as SessionEditorTab) : undefined)
      if (!tab) {
        void vscode.window.showInformationMessage('WorkerDeck: no session tab is active.')
        return
      }
      await moveToPanel(tab)
    },
    'workerdeck.selectModel': () => selectModel(registry.focused),
    'workerdeck.selectEffort': () => selectEffort(registry.focused),
    'workerdeck.selectPermissionMode': () => selectPermissionMode(registry.focused),
    'workerdeck.useSkill': () => pickCommand(registry.focused),
    'workerdeck.openProjectFolder': () => openProjectFolder(store, registry.focused),
    'workerdeck.sleepSession': () => sleepFocused(registry.focused, sleepSession),
  }
}

async function sleepFocused(surface: AnySurface, sleep: SessionCommandDeps['sleepSession']): Promise<void> {
  const session = surface.session
  if (!session) {
    void vscode.window.showInformationMessage('WorkerDeck: open a session first.')
    return
  }
  await sleep(session.host.id, session.sessionId)
}

// The panel runs `panelSurface: 'external'`, so the in-panel skills dialog never mounts - this QuickPick is its
// native stand-in, over the same merged list the composer's `/` offers.
export async function pickCommand(surface: AnySurface): Promise<void> {
  const rows = surface.vitals?.composerCommands
  if (!rows) {
    void vscode.window.showInformationMessage('WorkerDeck: commands are listed once the session connects - send a message first.')
    return
  }
  const items = rows.map((row) => ({
    label: row.label,
    description: [row.kind === 'skill' ? 'skill' : undefined, row.scope, row.enabled ? undefined : 'disabled'].filter(Boolean).join(' - '),
    detail: row.description?.split('\n')[0],
    insertText: row.insertText,
    // A skill the session reported but disabled stays visible and unpickable, like an ungrantable permission mode.
    alwaysShow: true,
    disabled: !row.enabled,
  }))
  const picked = await pickFromVitals(items, 'WorkerDeck: this session offers no commands or skills.', {
    title: 'WorkerDeck: commands and skills',
    placeHolder: 'Insert into the composer',
  })
  if (picked) {
    surface.insertComposerText(picked.insertText)
  }
}

async function selectModel(surface: AnySurface): Promise<void> {
  const vitals = surface.vitals
  const current = currentModel(vitals)
  const items = (vitals?.models ?? []).map((m) => ({
    label: m.displayName,
    description: m.value === current?.value ? 'current' : undefined,
    detail: m.description ?? m.resolvedModel ?? m.value,
    value: m.value,
  }))
  const picked = await pickFromVitals(items, 'WorkerDeck: no models to switch to yet.', {
    title: 'WorkerDeck: model',
    placeHolder: modelLabel(vitals),
  })
  if (picked) {
    surface.setModel(picked.value)
  }
}

async function selectEffort(surface: AnySurface): Promise<void> {
  const vitals = surface.vitals
  const current = vitals?.effort
  const items = [
    { label: 'Default', description: current ? undefined : 'current', detail: "The model's configured default", effort: undefined },
    ...(vitals?.efforts ?? []).map((effort) => ({ label: effort, description: effort === current ? 'current' : undefined, effort })),
  ]
  const picked = await pickFromVitals(vitals?.efforts.length ? items : [], 'WorkerDeck: this model takes no reasoning effort.', {
    title: 'WorkerDeck: reasoning effort',
    placeHolder: current ?? 'default',
  })
  if (picked) {
    surface.setEffort(picked.effort)
  }
}

async function selectPermissionMode(surface: AnySurface): Promise<void> {
  const current = surface.vitals?.permissionMode
  const items = (surface.vitals?.permissionModes ?? []).map((m) => ({
    label: m.dangerous ? `$(warning) ${m.label}` : m.label,
    description: m.value === current ? 'current' : undefined,
    detail: m.description,
    mode: m.value,
    // A mode the session can never be granted stays visible and unpickable.
    alwaysShow: true,
    picked: m.value === current,
    disabled: m.disabled,
  }))
  const picked = await pickFromVitals(items, 'WorkerDeck: this session has no mode switch.', { title: 'WorkerDeck: permission mode' })
  if (picked) {
    surface.setPermissionMode(picked.mode)
  }
}

async function pickFromVitals<T extends PickableItem>(items: T[], empty: string, options: vscode.QuickPickOptions): Promise<T | undefined> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(empty)
    return undefined
  }
  const picked = await vscode.window.showQuickPick(items, options)
  return picked && !picked.disabled ? picked : undefined
}

async function openProjectFolder(store: HostStore, surface: AnySurface): Promise<void> {
  const session = surface.session
  if (!session?.cwd) {
    void vscode.window.showInformationMessage('WorkerDeck: open a session first.')
    return
  }
  const uri = (await isLocalHost(store, session.host))
    ? vscode.Uri.file(session.cwd)
    : vscode.Uri.from({ scheme: WorkerdeckFileSystem.scheme, authority: session.host.id.toLowerCase(), path: session.cwd })
  const name =
    uri.scheme === WorkerdeckFileSystem.scheme ? `${session.host.name}: ${session.cwd.split('/').pop() ?? session.cwd}` : undefined
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri, name })
}
