import {
  NEW_CONVERSATION_HINT,
  STATUS_LABEL_EMOJI_MAX,
  STATUS_LABEL_TEXT_MAX,
  canSleep as canSleepRule,
  errorMessage,
  newConversationGate,
  type SessionInfo,
  type StatusLabelInput,
} from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { agentFileUri, type AgentFile } from './agent-settings.ts'
import type { HostStore } from './hosts.ts'
import {
  runTeamMove,
  teamMoveMessage,
  withdrawTeamInvitation,
  type SessionHandle,
  type TeamMovePlan,
  type WorkerDeckClient,
} from '@workerdeck/client'
import {
  conversationRecovery,
  startNewConversation,
  uncertainPromptOf,
  type ConversationRecovery,
  type DiscardConfirmText,
} from '@workerdeck/ui/format'
import { clientFor } from './gateway.ts'
import { deleteAgentDetail, showConversations } from './conversations.ts'
import { agentDefaultsCached, relayOfCached } from './machine.ts'
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
import { SESSION_ACTIONS, sessionActionCommand, sessionActions, teamLeadsFor, type SessionAction, type SessionMenuContext } from './session-menu.ts'
import { ProjectIconCache } from './project-icons.ts'
import type { AgentAvatarCache } from './agent-avatars.ts'

type ActionItem = vscode.QuickPickItem & { run: () => Promise<void> }

const VIEW_CONFIG_KEY = 'workerdeck.viewConfig.v1'

const SEARCH_CONTEXT_KEY = 'workerdeck.sessionsSearchOpen'
const SEARCH_OPEN_KEY = 'workerdeck.searchOpen.v1'

const FILTERED_CONTEXT_KEY = 'workerdeck.sessionsFiltered'

export type SelectOptions = {
  subagentToolUseId?: string
  revealToolUseId?: string
  shellId?: string
  target?: SurfaceTarget
  conversation?: number
}

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
  return canSleepRule(info)
}

const NEW_CONVERSATION_NOW = 'New conversation now'

async function openAgentFile(hostId: string, agentId: string, name: string, file: AgentFile): Promise<void> {
  const document = await vscode.workspace.openTextDocument(agentFileUri(hostId, agentId, name, file))
  await vscode.window.showTextDocument(document, { preview: false })
}

export class SidebarProvider extends WebviewViewHost<SidebarToHost, HostToSidebar> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.sessions'

  readonly #store: HostStore
  readonly #model: SessionsModel
  readonly #delegate: SidebarDelegate
  #transports: WebviewTransportHost | undefined
  #searchOpen = false
  #filtersRequested = false
  #avatarRequested: Extract<HostToSidebar, { kind: 'wd-avatar-picker' }> | undefined
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
    if (this.#avatarRequested) {
      this.post(this.#avatarRequested)
      this.#avatarRequested = undefined
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
    }
  }

  async #sessionMenu(hostId: string, sessionId: string): Promise<void> {
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    if (!info) {
      return
    }
    const items = this.#actionItems(hostId, info).map(([, item]) => item)
    const name = info.agent?.name ?? info.title ?? sessionId.slice(0, 8)
    // Read here, not from the list: only the session's conversations carry a failed start or an uncertain first message.
    const withRecovery = this.#recovery(hostId, info.id).then((recovery) => [...this.#recoveryItems(hostId, info, recovery), ...items])
    const picked = await vscode.window.showQuickPick(withRecovery, {
      title: info.owner ? `${name} · owner ${info.owner}` : name,
      placeHolder: 'Session actions',
    })
    await picked?.run()
  }

  menuCommands(): Record<string, (context?: SessionMenuContext) => unknown> {
    const commands: Record<string, (context?: SessionMenuContext) => unknown> = {
      [sessionActionCommand('more')]: (context) => context && this.#sessionMenu(context.hostId, context.sessionId),
    }
    for (const action of SESSION_ACTIONS) {
      commands[sessionActionCommand(action)] = async (context) => {
        const info = context && this.#model.sessionsOf(context.hostId).find((s) => s.id === context.sessionId)
        const item = info && this.#actionItems(context.hostId, info).find(([id]) => id === action)
        await item?.[1].run()
      }
    }
    return commands
  }

  #actionItems(hostId: string, info: SessionInfo): [SessionAction, ActionItem][] {
    const sessions = this.#model.sessionsOf(hostId)
    const leads = teamLeadsFor(sessions, info)
    const surface = this.#delegate.surfaceOf(hostId, info.id)
    return sessionActions(info, { surface, hasLeads: leads.length > 0 }).map((action) => [
      action,
      this.#actionItem(action, hostId, info, sessions, leads),
    ])
  }

  #actionItem(action: SessionAction, hostId: string, info: SessionInfo, sessions: SessionInfo[], leads: SessionInfo[]): ActionItem {
    const sessionId = info.id
    const agent = info.agent
    switch (action) {
      case 'stop':
        return {
          label: '$(debug-stop) Stop',
          detail: 'Interrupt the turn in flight',
          run: () => this.#stopSession(hostId, sessionId),
        }
      case 'moveToPanel':
        return {
          label: '$(layout-panel) Move to Panel',
          detail: 'Close the editor tab and show the session in the Agent panel',
          run: () => this.#delegate.moveToPanel(hostId, sessionId),
        }
      case 'openInEditor':
        return {
          label: '$(empty-window) Open in Editor Area',
          detail: 'Show the session in an editor tab (Cmd/Ctrl+click a session does the same)',
          run: () => this.#delegate.selectSession(hostId, sessionId, { target: 'editor' }),
        }
      case 'setStatus':
        return {
          label: info.statusLabel ? '$(comment) Change status' : '$(comment) Set status',
          detail: 'The line under the name in the list; the agent can change it with set_status',
          run: () => this.#setStatus(hostId, info),
        }
      case 'newConversation': {
        const gate = newConversationGate(info)
        return {
          label: '$(debug-restart) New conversation',
          description: gate.enabled ? undefined : gate.reason,
          detail: NEW_CONVERSATION_HINT,
          run: async () => {
            if (!gate.enabled) {
              void vscode.window.showInformationMessage(`WorkerDeck: ${gate.reason}.`)
              return
            }
            await this.#newConversation(hostId, info)
          },
        }
      }
      case 'sleep':
        return {
          label: '$(debug-pause) Sleep',
          detail: 'Release the engine process; the next message wakes it',
          run: () => this.sleepSession(hostId, sessionId),
        }
      case 'makeAgent':
        return {
          label: '$(person) Make agent',
          detail: 'Keep this session as a named agent with an avatar',
          run: () => this.#agentCall(hostId, 'could not make an agent', (client) => client.nameSession(sessionId, {})),
        }
      case 'leaveTeam':
        return {
          label: '$(sign-out) Leave team',
          detail: `Leave ${agent?.team ?? 'the team'} and stand on its own`,
          run: () => this.#agentCall(hostId, 'could not leave the team', (client) => client.updateAgent(agent!.id, { lead: null })),
        }
      case 'addToTeam':
        return {
          label: '$(organization) Add to team…',
          detail: 'Join another agent as a team member',
          run: async () => {
            const target = await vscode.window.showQuickPick(
              leads.map((lead) => ({ label: lead.agent!.name, description: lead.title, session: lead })),
              { title: `Add ${agent?.name ?? info.title ?? 'session'} to a team`, placeHolder: 'Lead' },
            )
            if (target) {
              await this.#moveIntoTeam({ hostId, sessionId }, { hostId, sessionId: target.session.id })
            }
          },
        }
      case 'dissolveTeam': {
        const members = sessions.filter((s) => s.agent?.lead === agent!.id)
        return {
          label: '$(ungroup-by-ref-type) Dissolve team',
          detail: `Release ${members.length} member${members.length === 1 ? '' : 's'}; they stay as agents`,
          run: () =>
            this.#agentCall(hostId, 'could not dissolve the team', async (client) => {
              for (const member of members) {
                await client.updateAgent(member.agent!.id, { lead: null })
              }
            }),
        }
      }
      case 'makePrivate':
      case 'share':
        return this.#sharingItem(hostId, agent!.id, action === 'makePrivate')
      case 'changeAvatar':
        return {
          label: '$(smiley) Change avatar',
          detail: 'Pick a new avatar from a few candidates',
          run: () => this.#changeAvatar(hostId, sessionId),
        }
      case 'editSettings':
        return {
          label: '$(settings-gear) Edit settings',
          detail: 'Project, profile, model, permission mode, instruction scope, sleep; saved on save',
          run: () => openAgentFile(hostId, agent!.id, agent!.name, 'settings'),
        }
      case 'editBrief':
        return {
          label: '$(note) Edit brief',
          detail: 'The standing brief, as markdown; saved on save',
          run: () => openAgentFile(hostId, agent!.id, agent!.name, 'brief'),
        }
      case 'conversations':
        return {
          label: '$(history) Conversations…',
          detail: 'Past conversations open read-only',
          run: () =>
            showConversations(
              { store: this.#store, selectSession: this.#delegate.selectSession },
              {
                hostId,
                sessionId,
                name: agent?.name ?? info.title ?? sessionId.slice(0, 8),
                ...(info.title ? { title: info.title } : {}),
              },
            ),
        }
      case 'deleteAgent':
        return {
          label: '$(trash) Delete agent…',
          detail: deleteAgentDetail(agent!.name),
          run: () => this.#deleteAgent(hostId, info),
        }
      case 'delete':
        return {
          label: '$(trash) Delete',
          detail: 'Remove the session from the gateway',
          run: () => this.#deleteSession(hostId, sessionId),
        }
    }
  }

  async agentSaved(saved: { hostId: string; agentId: string; name: string; file: AgentFile }): Promise<void> {
    const what = saved.file === 'settings' ? 'settings' : 'brief'
    const message = `WorkerDeck: saved ${saved.name}'s ${what}. They apply when it next starts or wakes.`
    const info = this.#model.sessionsOf(saved.hostId).find((s) => s.agent?.id === saved.agentId)
    if (!info || !newConversationGate(info).enabled) {
      void vscode.window.showInformationMessage(message)
      return
    }
    const choice = await vscode.window.showInformationMessage(message, NEW_CONVERSATION_NOW)
    if (choice === NEW_CONVERSATION_NOW) {
      await this.#newConversation(saved.hostId, info)
    }
  }

  async #recovery(hostId: string, sessionId: string): Promise<ConversationRecovery | undefined> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    const answer = await client?.conversations(sessionId).catch(() => undefined)
    return answer && conversationRecovery(answer)
  }

  #recoveryItems(
    hostId: string,
    info: SessionInfo,
    recovery: ConversationRecovery | undefined,
  ): (vscode.QuickPickItem & { run: () => Promise<void> })[] {
    const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = []
    const failed = recovery?.startFailed
    if (failed) {
      items.push({
        label: '$(debug-restart) Retry start',
        detail: failed.error,
        run: () =>
          this.#agentCall(hostId, 'could not start the new conversation', (client) => client.retryConversationStart(info.id, failed.n)),
      })
    }
    const uncertain = recovery?.uncertainPrompt
    if (uncertain) {
      items.push(
        {
          label: '$(send) Send again',
          description: 'first message may not have arrived',
          detail: uncertain.text,
          run: () =>
            this.#agentCall(hostId, 'could not send the message again', (client) => client.settlePendingPrompt(info.id, true, uncertain.n)),
        },
        {
          label: '$(close) Dismiss',
          detail: 'Drop the first message that may not have arrived',
          run: () =>
            this.#agentCall(hostId, 'could not dismiss the message', (client) => client.settlePendingPrompt(info.id, false, uncertain.n)),
        },
      )
    }
    return items
  }

  async #newConversation(hostId: string, info: SessionInfo): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      return
    }
    const expectedGeneration = info.conversation ?? 1
    try {
      await startNewConversation(client, info.id, { expectedGeneration }, confirmDiscard)
    } catch (err) {
      const message = errorMessage(err)
      const uncertain = uncertainPromptOf(err)
      if (uncertain) {
        const choice = await vscode.window.showErrorMessage(`WorkerDeck: ${message}`, 'Send again', 'Dismiss')
        if (choice) {
          const send = choice === 'Send again'
          await this.#agentCall(hostId, send ? 'could not send the message again' : 'could not dismiss the message', (client) =>
            client.settlePendingPrompt(info.id, send, uncertain.promptConversation),
          )
        }
      } else if (message.includes('retry starting it first')) {
        const choice = await vscode.window.showErrorMessage(`WorkerDeck: ${message}`, 'Retry start')
        if (choice === 'Retry start') {
          await this.#agentCall(hostId, 'could not start the new conversation', (retry) =>
            retry.retryConversationStart(info.id, expectedGeneration),
          )
        }
      } else {
        const choice = await vscode.window.showErrorMessage(`WorkerDeck: could not start a new conversation - ${message}`, 'Try again')
        if (choice === 'Try again') {
          await this.#model.refresh()
          const fresh = this.#model.sessionsOf(hostId).find((s) => s.id === info.id)
          if (fresh) {
            await this.#newConversation(hostId, fresh)
          }
          return
        }
      }
    }
    await this.#model.refresh()
  }

  // The panel showing the agent stays on its last conversation, which turns into a read-only archive.
  async #deleteAgent(hostId: string, info: SessionInfo): Promise<void> {
    const agent = info.agent
    if (!agent) {
      return
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${agent.name}?`,
      { modal: true, detail: deleteAgentDetail(agent.name) },
      'Delete agent',
    )
    if (confirmed !== 'Delete agent') {
      return
    }
    await this.#agentCall(hostId, 'could not delete the agent', (client) =>
      client.retireAgent(agent.id, { expectedGeneration: info.conversation ?? 1 }),
    )
  }

  // The picker draws the candidates, so it lives in this webview; a request before the view has booted waits for `onReady`.
  async #changeAvatar(hostId: string, sessionId: string): Promise<void> {
    const picker = { kind: 'wd-avatar-picker' as const, hostId, sessionId }
    if (this.view && this.ready) {
      this.post(picker)
      return
    }
    this.#avatarRequested = picker
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)
  }

  async #setStatus(hostId: string, info: SessionInfo): Promise<void> {
    const current = info.statusLabel
    const text = await vscode.window.showInputBox({
      title: 'Status',
      prompt: 'Start with an emoji if you like. Leave empty to clear.',
      value: current ? (current.emoji ? `${current.emoji} ${current.text}` : current.text) : '',
      validateInput: (value) => (value.trim().length > STATUS_LABEL_TEXT_MAX + STATUS_LABEL_EMOJI_MAX + 1 ? 'Too long' : undefined),
    })
    if (text === undefined) {
      return
    }
    await this.#agentCall(hostId, 'could not set the status', (client) =>
      client.updateSession(info.id, { statusLabel: statusLabelFrom(text) }),
    )
  }

  #sharingItem(hostId: string, agentId: string, shared: boolean): vscode.QuickPickItem & { run: () => Promise<void> } {
    if (shared) {
      return {
        label: '$(lock) Make private',
        detail: 'Hide this agent from other owners',
        run: () => this.#agentCall(hostId, 'could not change sharing', (client) => client.updateAgent(agentId, { sharing: 'private' })),
      }
    }
    const host = this.#store.get(hostId)
    const allowed = (host ? agentDefaultsCached(host)?.allowShared : undefined) !== false
    return {
      label: '$(globe) Share with other owners',
      description: allowed ? undefined : 'turned off on this gateway',
      detail: 'Other owners see a card and their shared agents can message this one',
      run: async () => {
        if (!allowed) {
          void vscode.window.showInformationMessage('WorkerDeck: this gateway shares no agents (`--agent-sharing never`).')
          return
        }
        await this.#agentCall(hostId, 'could not change sharing', (client) => client.updateAgent(agentId, { sharing: 'shared' }))
      },
    }
  }

  async #teamMove(msg: Extract<SidebarToHost, { kind: 'wd-team-move' }>): Promise<void> {
    const leadHostId = msg.leadHostId ?? msg.hostId
    await this.#moveIntoTeam(
      { hostId: msg.hostId, sessionId: msg.sessionId },
      msg.leadSessionId === null ? null : { hostId: leadHostId, sessionId: msg.leadSessionId },
      { order: msg.order, siblings: msg.siblings },
    )
  }

  // One path for a drag and the `Add to team` item: asks before a join across owners, then reports what the move left
  // behind (a kept adoption, an open invitation, an unsaved order) with the one safe next action.
  async #moveIntoTeam(
    mover: { hostId: string; sessionId: string },
    leadAt: { hostId: string; sessionId: string } | null,
    placement: { order?: number; siblings?: Array<{ hostId?: string; sessionId: string; order: number }> } = {},
  ): Promise<void> {
    const sessionOn = (hostId: string, sessionId: string) => this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const moverInfo = sessionOn(mover.hostId, mover.sessionId)
    const leadInfo = leadAt === null ? null : sessionOn(leadAt.hostId, leadAt.sessionId)
    const lead = leadInfo === null ? null : leadInfo?.agent?.id
    if (!moverInfo || lead === undefined || leadInfo === undefined) {
      return
    }
    const moverOwner = this.#ownerOf(mover.hostId, moverInfo)
    const leadOwner = leadAt && leadInfo ? this.#ownerOf(leadAt.hostId, leadInfo) : undefined
    const crossOwner = leadInfo !== null && moverOwner !== leadOwner
    if (crossOwner) {
      const leadName = leadInfo.agent?.name ?? 'that lead'
      const ok = await vscode.window.showWarningMessage(
        `Join ${leadName}'s team across owners?`,
        {
          modal: true,
          detail: `${moverInfo.agent?.name ?? moverInfo.title ?? 'This session'} belongs to ${moverOwner ?? 'no owner'}, ${leadName} to ${leadOwner ?? 'no owner'}. In one team they can message each other; shells, files and approvals stay on their own gateway.`,
        },
        'Join across owners',
      )
      if (ok !== 'Join across owners') {
        return
      }
    }
    const hostIds = new Set([
      mover.hostId,
      ...(leadAt ? [leadAt.hostId] : []),
      ...(placement.siblings ?? []).map((s) => s.hostId ?? mover.hostId),
    ])
    const clients = new Map<string, WorkerDeckClient>()
    for (const id of hostIds) {
      const host = this.#store.get(id)
      const client = host && (await clientFor(this.#store, host))
      if (client) {
        clients.set(id, client)
      }
    }
    const plan: TeamMovePlan = {
      mover: { hostId: mover.hostId, sessionId: mover.sessionId, agentId: moverInfo.agent?.id, owner: moverOwner },
      lead: lead && leadAt ? { hostId: leadAt.hostId, agentId: lead } : null,
      order: placement.order,
      siblings: (placement.siblings ?? []).flatMap((s) => {
        const hostId = s.hostId ?? mover.hostId
        const agentId = sessionOn(hostId, s.sessionId)?.agent?.id
        return agentId ? [{ hostId, agentId, order: s.order }] : []
      }),
      ...(crossOwner ? { crossOwner: true as const } : {}),
    }
    const failure = lead ? 'could not join the team' : 'could not leave the team'
    try {
      const outcome = await runTeamMove(
        plan,
        (id) => clients.get(id),
        (id) => {
          const host = this.#store.get(id)
          return host ? relayOfCached(host) : undefined
        },
      )
      await this.#model.refresh()
      const message = teamMoveMessage(outcome)
      const invitation = outcome.invitation?.state === 'open' ? outcome.invitation : undefined
      if (!message) {
        return
      }
      if (outcome.committed === 'yes' && !invitation) {
        void vscode.window.showWarningMessage(`WorkerDeck: ${message}`)
        return
      }
      const action = invitation ? 'Withdraw invitation' : undefined
      const picked = await vscode.window.showErrorMessage(`WorkerDeck: ${message}`, ...(action ? [action] : []))
      if (picked && invitation) {
        try {
          await withdrawTeamInvitation(invitation, (id) => clients.get(id))
          void vscode.window.showInformationMessage('WorkerDeck: invitation withdrawn.')
        } catch (err) {
          void vscode.window.showErrorMessage(`WorkerDeck: could not withdraw the invitation - ${errorMessage(err)}`)
        }
        await this.#model.refresh()
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${failure} - ${errorMessage(err)}`)
      await this.#model.refresh()
    }
  }

  // The session's own owner; a gateway from before owners has only its relay's.
  #ownerOf(hostId: string, info: SessionInfo): string | undefined {
    const host = this.#store.get(hostId)
    return info.owner ?? (host ? relayOfCached(host)?.owner : undefined)
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
    if (info?.agent) {
      return await this.#deleteAgent(hostId, info)
    }
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

// A leading emoji (one grapheme of pictographic text) splits off; the rest is the line.
export function statusLabelFrom(input: string): StatusLabelInput | null {
  const line = input.trim()
  if (!line) {
    return null
  }
  const [first, ...rest] = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((part) => part.segment)
  if (first && /\p{Extended_Pictographic}/u.test(first) && rest.join('').trim()) {
    return { emoji: first, text: rest.join('').trim() }
  }
  return { text: line }
}

async function confirmDiscard(text: DiscardConfirmText): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(text.title, { modal: true, detail: text.detail }, text.confirm)
  return choice === text.confirm
}
