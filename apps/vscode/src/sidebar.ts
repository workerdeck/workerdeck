import { errorMessage, type SessionInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import type { SessionHandle, WorkerDeckClient } from '@workerdeck/client'
import { clientFor } from './gateway.ts'
import type { SessionsModel } from './sessions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSidebar, SidebarToHost, SurfaceTarget } from './bridge-protocol.ts'
import {
  buildRows,
  displayCustomized,
  facetFilterCount,
  filterRows,
  normalizeViewConfig,
  runningSubagents,
  type SubagentDisplay,
  type ViewConfig,
} from './view-config.ts'
import { WebviewViewHost } from './webview-host.ts'
import { ProjectIconCache } from './project-icons.ts'
import type { AgentAvatarCache } from './agent-avatars.ts'

const VIEW_CONFIG_KEY = 'workerdeck.viewConfig.v1'

const SEARCH_CONTEXT_KEY = 'workerdeck.sessionsSearchOpen'
const SEARCH_OPEN_KEY = 'workerdeck.searchOpen.v1'

const FILTERED_CONTEXT_KEY = 'workerdeck.sessionsFiltered'

export type SelectOptions = { subagentToolUseId?: string; revealToolUseId?: string; shellId?: string; target?: SurfaceTarget }

export type SidebarDelegate = {
  selectSession: (hostId: string, sessionId: string, options?: SelectOptions) => Promise<void>
  sessionDeleted: (hostId: string, sessionId: string) => Promise<void>
  surfaceOf: (hostId: string, sessionId: string) => 'panel' | 'editor' | undefined
  moveToPanel: (hostId: string, sessionId: string) => Promise<void>
  revealGateways: (options: { add?: boolean }) => Promise<void>
  newSession: (preset: { hostId: string; cwd?: string }) => Promise<void>
  unread: (rows: number, waiting: number) => void
  subagents: (running: number, sessions: number) => void
}

export function canSleep(info: SessionInfo): boolean {
  return info.capabilities?.engineSleep === true && info.status === 'idle' && !info.engineAsleep
}

export class SidebarProvider extends WebviewViewHost<SidebarToHost, HostToSidebar> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.sessions'

  readonly #store: HostStore
  readonly #model: SessionsModel
  readonly #delegate: SidebarDelegate
  #transports: WebviewTransportHost | undefined
  #searchOpen = false
  #filtersRequested = false
  readonly #context: vscode.ExtensionContext
  #viewConfig: ViewConfig
  readonly #icons: ProjectIconCache
  readonly #avatars: AgentAvatarCache

  protected readonly bundle = 'sidebar.js'

  constructor(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    store: HostStore,
    model: SessionsModel,
    avatars: AgentAvatarCache,
    delegate: SidebarDelegate,
  ) {
    super(extensionUri)
    this.#context = context
    this.#store = store
    this.#model = model
    this.#delegate = delegate
    this.#icons = new ProjectIconCache(store, () => this.post({ kind: 'wd-project-icons', icons: this.#icons.entries() }))
    this.#avatars = avatars
    avatars.onDidChange(() => this.post({ kind: 'wd-agent-avatars', avatars: this.#avatars.entries() }))
    this.#viewConfig = normalizeViewConfig(context.globalState.get<ViewConfig>(VIEW_CONFIG_KEY))
    // Seeds the context keys, so the title bar shows the right toggle icons before the view opens.
    this.setSearchOpen(context.globalState.get<boolean>(SEARCH_OPEN_KEY) ?? false)
    this.#syncFiltered()
    model.onDidChange(() => this.#pushState())
  }

  protected override wire(view: vscode.WebviewView): void {
    this.resetForReload()
    view.onDidChangeVisibility(() => this.#model.setWatching(SidebarProvider.viewId, view.visible))
    this.#model.setWatching(SidebarProvider.viewId, view.visible)
  }

  protected override resetForReload(): void {
    this.#transports?.dispose()
    this.#transports = new WebviewTransportHost(this.#store, (msg) => this.post(msg))
  }

  protected override intercept(msg: SidebarToHost): Promise<boolean> | boolean {
    return this.#transports?.handle(msg) ?? false
  }

  protected override onViewDisposed(): void {
    this.#transports?.dispose()
    this.#model.setWatching(SidebarProvider.viewId, false)
  }

  setSearchOpen(open: boolean): void {
    this.#searchOpen = open
    void this.#context.globalState.update(SEARCH_OPEN_KEY, open)
    void vscode.commands.executeCommand('setContext', SEARCH_CONTEXT_KEY, open)
    this.post({ kind: 'wd-search-open', open })
  }

  toggleSearch(): void {
    this.setSearchOpen(!this.#searchOpen)
  }

  // The popover lives in the webview, so a press on the title bar before the view has booted is held until `onReady`.
  toggleFilters(): void {
    if (this.view && this.ready) {
      this.post({ kind: 'wd-filters-toggle' })
      return
    }
    this.#filtersRequested = true
    void vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)
  }

  setSubagents(subagents: SubagentDisplay): void {
    this.#viewConfig = { ...this.#viewConfig, subagents }
    void this.#context.globalState.update(VIEW_CONFIG_KEY, this.#viewConfig)
    this.#syncFiltered()
    this.post({ kind: 'wd-subagents', subagents })
  }

  #syncFiltered(): void {
    const filtered = facetFilterCount(this.#viewConfig) > 0 || displayCustomized(this.#viewConfig)
    void vscode.commands.executeCommand('setContext', FILTERED_CONTEXT_KEY, filtered)
  }

  subagentsDisplay(): SubagentDisplay {
    return this.#viewConfig.subagents
  }

  #pushState(): void {
    if (this.view && this.ready) {
      const state = this.#model.sidebarState()
      this.post({ kind: 'wd-sidebar-state', state })
      this.#icons.ensure(state.sessions)
      this.#avatars.ensure(state.sessions)
    }
    this.refreshUnread()
  }

  refreshUnread(): void {
    const state = this.#model.sidebarState()
    const visible = filterRows(buildRows(state), this.#viewConfig, state.scope)
    const rows = visible.reduce((total, row) => total + (state.unseen?.[`${row.hostId}:${row.info.id}`] ?? 0), 0)
    this.#delegate.unread(rows, this.#model.attentionCount())
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

  protected override onReady(): void {
    // Whole, not incremental: a webview VS Code rebuilt has no map to merge into.
    this.post({ kind: 'wd-project-icons', icons: this.#icons.entries() })
    this.post({ kind: 'wd-agent-avatars', avatars: this.#avatars.entries() })
    this.#pushState()
    // The webview boots with the bar closed and learns otherwise here: it cannot read a context key.
    this.post({ kind: 'wd-search-open', open: this.#searchOpen })
    this.post({ kind: 'wd-subagents', subagents: this.#viewConfig.subagents })
    if (this.#filtersRequested) {
      this.#filtersRequested = false
      this.post({ kind: 'wd-filters-toggle' })
    }
  }

  protected override async onMessage(msg: SidebarToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-reveal-gateways': {
        await this.#delegate.revealGateways({ add: msg.add })
        return
      }
      case 'wd-view-config': {
        this.#viewConfig = msg.config
        void this.#context.globalState.update(VIEW_CONFIG_KEY, msg.config)
        this.#syncFiltered()
        this.#pushState()
        return
      }
      case 'wd-new-session': {
        await this.#delegate.newSession({ hostId: msg.hostId, cwd: msg.cwd })
        return
      }
      case 'wd-select-session': {
        await this.#delegate.selectSession(msg.hostId, msg.sessionId, {
          subagentToolUseId: msg.subagentToolUseId,
          revealToolUseId: msg.revealToolUseId,
          shellId: msg.shellId,
          target: msg.target,
        })
        return
      }
      case 'wd-stop-task': {
        return this.#stopTask(msg.hostId, msg.sessionId, msg.toolUseId)
      }
      case 'wd-kill-shell': {
        return this.#killShell(msg.hostId, msg.sessionId, msg.shellId)
      }
      case 'wd-shell-agent-write': {
        return this.#shellAgentWrite(msg.hostId, msg.sessionId, msg.shellId, msg.enabled)
      }
      case 'wd-stop-session': {
        return this.#stopSession(msg.hostId, msg.sessionId)
      }
      case 'wd-rename-session': {
        return this.#renameSession(msg.hostId, msg.sessionId, msg.title)
      }
      case 'wd-rename-agent': {
        const agentId = this.#model.sessionsOf(msg.hostId).find((s) => s.id === msg.sessionId)?.agent?.id
        return agentId
          ? this.#agentCall(msg.hostId, 'rename failed', (client) => client.updateAgent(agentId, { name: msg.name }))
          : undefined
      }
      case 'wd-team-move': {
        return this.#teamMove(msg)
      }
      case 'wd-delete-session': {
        return this.#deleteSession(msg.hostId, msg.sessionId)
      }
      case 'wd-session-menu': {
        return this.#sessionMenu(msg.hostId, msg.sessionId)
      }
    }
  }

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
    const surface = this.#delegate.surfaceOf(hostId, sessionId)
    if (surface === 'editor') {
      items.push({
        label: '$(layout-panel) Move to Panel',
        detail: 'Close the editor tab and show the session in the Agent panel',
        run: () => this.#delegate.moveToPanel(hostId, sessionId),
      })
    } else {
      items.push({
        label: '$(empty-window) Open in Editor Area',
        detail: 'Show the session in an editor tab (Cmd/Ctrl+click a session does the same)',
        run: () => this.#delegate.selectSession(hostId, sessionId, { target: 'editor' }),
      })
    }
    if (info.capabilities?.clearContext) {
      items.push({
        label: '$(clear-all) Clear context',
        detail: 'Start a fresh conversation - the old one stays resumable',
        run: () => this.#clearSession(hostId, sessionId),
      })
    }
    if (canSleep(info)) {
      items.push({
        label: '$(debug-pause) Sleep',
        detail: 'Release the engine process; the next message wakes it',
        run: () => this.sleepSession(hostId, sessionId),
      })
    }
    items.push(...this.#teamItems(hostId, info))
    items.push({
      label: '$(trash) Delete',
      detail: info.agent ? 'End this session; the agent stays and can be restarted' : 'Remove the session from the gateway',
      run: () => this.#deleteSession(hostId, sessionId),
    })
    const picked = await vscode.window.showQuickPick(items, {
      title: info.title ?? sessionId.slice(0, 8),
      placeHolder: 'Session actions',
    })
    await picked?.run()
  }

  #teamItems(hostId: string, info: SessionInfo): (vscode.QuickPickItem & { run: () => Promise<void> })[] {
    const agent = info.agent
    const sessions = this.#model.sessionsOf(hostId)
    const leads = sessions.filter((s) => s.agent && s.agent.lead === undefined && s.agent.id !== agent?.id && s.id !== info.id)
    const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = []
    if (!agent) {
      items.push({
        label: '$(person) Make agent',
        detail: 'Keep this session as a named agent with an avatar',
        run: () => this.#agentCall(hostId, 'could not make an agent', (client) => client.createAgent({ adopt: info.id })),
      })
    }
    if (agent?.lead !== undefined) {
      items.push({
        label: '$(sign-out) Leave team',
        detail: `Leave ${agent.team ?? 'the team'} and stand on its own`,
        run: () => this.#agentCall(hostId, 'could not leave the team', (client) => client.updateAgent(agent.id, { lead: null })),
      })
    } else if (!agent?.leads && leads.length > 0) {
      items.push({
        label: '$(organization) Add to team…',
        detail: 'Join another agent as a team member',
        run: async () => {
          const target = await vscode.window.showQuickPick(
            leads.map((lead) => ({ label: lead.agent!.name, description: lead.title, id: lead.agent!.id })),
            { title: `Add ${agent?.name ?? info.title ?? 'session'} to a team`, placeHolder: 'Lead' },
          )
          if (!target) {
            return
          }
          await this.#agentCall(hostId, 'could not join the team', (client) =>
            agent ? client.updateAgent(agent.id, { lead: target.id }) : client.createAgent({ adopt: info.id, lead: target.id }),
          )
        },
      })
    }
    if (agent?.leads) {
      const members = sessions.filter((s) => s.agent?.lead === agent.id)
      items.push({
        label: '$(ungroup-by-ref-type) Dissolve team',
        detail: `Release ${members.length} member${members.length === 1 ? '' : 's'}; they stay as agents`,
        run: () =>
          this.#agentCall(hostId, 'could not dissolve the team', async (client) => {
            for (const member of members) {
              await client.updateAgent(member.agent!.id, { lead: null })
            }
          }),
      })
    }
    if (agent) {
      items.push({
        label: '$(debug-restart) New conversation',
        detail: 'Restart the agent in a fresh session; the old one stays resumable',
        run: () => this.#agentCall(hostId, 'could not restart the agent', (client) => client.restartAgent(agent.id)),
      })
      items.push({
        label: '$(person-remove) Retire agent',
        detail: agent.leads ? 'End the agent and its session; members are released' : 'End the agent and its session',
        run: async () => {
          const ok = await vscode.window.showWarningMessage(`Retire ${agent.name}?`, { modal: true }, 'Retire')
          if (ok === 'Retire') {
            await this.#agentCall(hostId, 'could not retire the agent', (client) => client.retireAgent(agent.id))
          }
        },
      })
    }
    return items
  }

  async #teamMove(msg: Extract<SidebarToHost, { kind: 'wd-team-move' }>): Promise<void> {
    const sessions = this.#model.sessionsOf(msg.hostId)
    const agentOf = (sessionId: string) => sessions.find((s) => s.id === sessionId)?.agent?.id
    const lead = msg.leadSessionId === null ? null : agentOf(msg.leadSessionId)
    if (lead === undefined) {
      return
    }
    const mover = agentOf(msg.sessionId)
    await this.#agentCall(msg.hostId, lead ? 'could not join the team' : 'could not leave the team', async (client) => {
      if (mover) {
        await client.updateAgent(mover, lead ? { lead, ...(msg.order === undefined ? {} : { order: msg.order }) } : { lead: null })
      } else if (lead) {
        const adopted = await client.createAgent({ adopt: msg.sessionId, lead })
        if (msg.order !== undefined) {
          await client.updateAgent(adopted.agent.id, { order: msg.order })
        }
      }
      for (const sibling of msg.siblings ?? []) {
        const id = agentOf(sibling.sessionId)
        if (id) {
          await client.updateAgent(id, { order: sibling.order })
        }
      }
    })
  }

  async #agentCall(hostId: string, failure: string, call: (client: WorkerDeckClient) => Promise<unknown>): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await call(client)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${failure} - ${errorMessage(err)}`)
    }
    await this.#model.refresh()
  }

  async sleepSession(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    if (!info || !canSleep(info)) {
      void vscode.window.showInformationMessage('WorkerDeck: only an idle, awake session whose engine supports it can sleep.')
      return
    }
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.sleepSession(sessionId)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: sleep failed - ${errorMessage(err)}`)
    }
    await this.#model.refresh()
  }

  async #stopSession(hostId: string, sessionId: string): Promise<void> {
    await this.#command(hostId, sessionId, (handle) => handle.interrupt())
  }

  // The frame gets a beat to flush before the socket goes; a command that never reached the gateway would look like one that did.
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

  async #clearSession(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(
      `Clear the conversation in "${info?.title ?? sessionId.slice(0, 8)}"?`,
      {
        modal: true,
        detail:
          'The session keeps running and starts a fresh conversation. The old one is not ' +
          'deleted - it stays resumable from "Resume a previous session".',
      },
      'Clear context',
    )
    if (confirmed !== 'Clear context') {
      return
    }
    await this.#command(hostId, sessionId, (handle) => handle.clearContext())
  }

  async #killShell(hostId: string, sessionId: string, shellId: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.killShell(sessionId, shellId)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: kill failed - ${errorMessage(err)}`)
    }
    await this.#model.refresh()
  }

  async #stopTask(hostId: string, sessionId: string, toolUseId: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.stopTask(sessionId, toolUseId)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: stop failed - ${errorMessage(err)}`)
    }
    await this.#model.refresh()
  }

  async #shellAgentWrite(hostId: string, sessionId: string, shellId: string, enabled: boolean): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.setShellAgentWrite(sessionId, shellId, enabled)
    } catch (err) {
      const verb = enabled ? 'grant' : 'revoke'
      void vscode.window.showErrorMessage(`WorkerDeck: ${verb} failed - ${errorMessage(err)}`)
    }
    await this.#model.refresh()
  }

  async #renameSession(hostId: string, sessionId: string, title: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    try {
      await client.updateSession(sessionId, { title: title.trim() || null })
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: rename failed - ${errorMessage(err)}`)
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
      void vscode.window.showErrorMessage(`WorkerDeck: delete failed - ${errorMessage(err)}`)
    }
    await this.#delegate.sessionDeleted(hostId, sessionId)
    await this.#model.refresh()
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
