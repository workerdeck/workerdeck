import { randomUUID } from 'node:crypto'
import type {
  GoalNotice,
  PermissionRequest,
  SessionEvent,
  SessionGoal,
  SessionInfo,
  SessionStatus,
  StatusLabel,
  StatusLabelInput,
} from '@workerdeck/protocol'
import type { EngineRunnerConfig, PermissionDecision, SendMessageOptions, SessionEventListener } from '../runner-interface.ts'
import { resolveApprovalTimeoutMs } from './approval-timeout.ts'
import { SHELL_PROPOSE_TOOL, shellProposalVerdict, type ShellProposalGate } from './shells.ts'
import { attachmentRef, type AttachmentInput } from './attachments.ts'
import type { CostLedgerState } from './cost-ledger.ts'
import { LocalCommandQueue, localCommandEvent, type LocalCommandResult, type LocalShellSource } from './local-command.ts'
import { RunnerCore, approvalResolution, type CloseReason, type RunnerCoreHooks, type RunnerCoreOptions } from './runner-core.ts'
import { buildSessionReport, type LiveContext, type SessionReport } from './session-report.ts'
import type { SessionToolSources } from './session-tools.ts'
import type { SubscribeOptions } from './subscribers.ts'
import { sessionTitle, withTitle } from './title.ts'

export type EngineRunnerCoreOptions = Pick<RunnerCoreOptions, 'cost'>

export type ApprovalDeadline = { timeoutMs: number | undefined; expiresAt: number | undefined }

export type SessionReportFacts = { vendor: string | undefined; context: LiveContext | undefined; rateLimits: boolean; contextNote?: string }

export abstract class EngineRunner<C extends EngineRunnerConfig> {
  readonly id: string
  readonly createdAt: number
  protected config: C
  protected readonly core: RunnerCore
  protected readonly localCommands: LocalCommandQueue

  protected constructor(config: C, id: string, createdAt: number, options: EngineRunnerCoreOptions = {}) {
    this.config = config
    this.id = id
    this.createdAt = createdAt
    this.core = new RunnerCore({ ...options, pricing: config.pricing, hooks: this.coreHooks() })
    this.localCommands = new LocalCommandQueue((text, uuid, shell) => this.core.emit(localCommandEvent(text, uuid, shell)))
    const reason = config.agentResetReason
    if (reason !== undefined && (config as { restore?: unknown }).restore === undefined && config.resume === undefined) {
      // After the subclass constructor: its core hooks read fields it has not set yet.
      queueMicrotask(() => this.core.emit({ type: 'conversation_reset', agentReason: reason }))
    }
  }

  abstract close(reason?: CloseReason): void

  abstract info(): SessionInfo

  protected abstract reportFacts(): Promise<SessionReportFacts>

  async sessionReport(): Promise<SessionReport> {
    const facts = await this.reportFacts()
    return buildSessionReport({
      info: this.info(),
      vendor: facts.vendor,
      context: facts.context,
      contextNote: facts.contextNote,
      rateLimitsSupported: facts.rateLimits,
      events: this.core.log.events,
    })
  }

  setOwner(owner: string | undefined): void {
    this.config = { ...this.config, owner }
  }

  // Called from the base constructor, before the subclass's own fields exist: the hooks may only close over them.
  protected coreHooks(): RunnerCoreHooks {
    return {}
  }

  get status(): SessionStatus {
    return this.core.status
  }

  get lastSeq(): number {
    return this.core.log.seq
  }

  get pendingApprovals(): PermissionRequest[] {
    return this.core.pendingApprovals
  }

  setTitle(title: string | undefined): void {
    this.config = withTitle(this.config, title)
  }

  setStatusLabel(input: StatusLabelInput | null): StatusLabel | null {
    this.assertAccepting()
    const label = input ? { ...input, setAt: Date.now() } : null
    this.core.emit({ type: 'status_label', label })
    return label
  }

  // The goal `info()` shows: the log's once it has seen a change or a reset, else the one the session was built with.
  protected get goal(): SessionGoal | null {
    const logged = this.core.log.goal
    return logged === undefined ? (this.config.goal ?? null) : logged
  }

  protected emitGoal(goal: SessionGoal | null, notice?: GoalNotice): void {
    this.core.emit(notice ? { type: 'goal_changed', goal, notice } : { type: 'goal_changed', goal })
  }

  carryCost(state: CostLedgerState): void {
    this.core.carryCost(state)
  }

  costState(): CostLedgerState {
    return this.core.costState()
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.core.resolveApproval(requestId, decision, 'client')
  }

  queueLocalCommand(input: LocalCommandResult | LocalShellSource): void {
    this.assertAccepting()
    this.localCommands.push(input)
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.core.eventAt(seq)
  }

  subscribe(listener: SessionEventListener, afterSeq = 0, options?: SubscribeOptions): () => void {
    return this.core.subscribe(listener, afterSeq, options)
  }

  fail(message: string): void {
    this.core.fail(message, (reason) => this.close(reason))
  }

  protected assertAccepting(): void {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
  }

  // `queued`: the send waits behind a running turn; the engine names its uuid in `input_consumed` once a request takes it.
  protected echoUser(
    text: string,
    attachments: readonly AttachmentInput[] | undefined,
    options: SendMessageOptions | undefined,
    queued = false,
  ): string {
    const uuid = randomUUID()
    this.core.emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid,
      ...(options?.origin ? { origin: options.origin } : {}),
      ...(options?.synthetic ? { synthetic: true } : {}),
      ...(queued ? { queued: true as const } : {}),
    })
    return uuid
  }

  protected approvalDeadline(): ApprovalDeadline {
    const timeoutMs = resolveApprovalTimeoutMs(this.config.approvalTimeoutMs, this.config.defaultApprovalTimeoutMs)
    return { timeoutMs, expiresAt: timeoutMs === undefined ? undefined : Date.now() + timeoutMs }
  }

  protected get toolSources(): SessionToolSources {
    return {
      report: () => this.sessionReport(),
      status: (input) => this.setStatusLabel(input),
      avatar: this.config.avatar,
      reset: this.config.contextReset,
      peers: this.config.peers,
      shells: this.config.shells,
      write: this.config.shellAgentWrite !== undefined,
      propose: this.config.shells && this.config.shellPropose === true ? this.#proposeShell : undefined,
      goals: this.config.goals,
    }
  }

  // An ordinary approval in every respect but its origin: interrupt, close, clear and the deadline settle it as they
  // settle any other, and the abort signal is the claude engine's MCP cancellation, which nothing else reaches.
  #proposeShell: ShellProposalGate = (proposal, signal) => {
    const id = randomUUID()
    const { timeoutMs, expiresAt } = this.approvalDeadline()
    const request: PermissionRequest = {
      id,
      toolName: SHELL_PROPOSE_TOOL,
      input: { ...proposal },
      toolUseId: id,
      title: 'Run this command?',
      description: proposal.description,
      expiresAt,
    }
    return new Promise((resolve) => {
      this.core.requestApproval(request, {
        timeoutMs,
        respond: (decision, resolvedBy) => {
          resolve(shellProposalVerdict(proposal, decision))
          return approvalResolution(decision, resolvedBy)
        },
        after: () => {
          if (this.core.pendingCount === 0 && this.core.status === 'awaiting_approval') {
            this.core.setStatus('running')
          }
        },
      })
      signal?.addEventListener('abort', () => this.core.resolveApproval(id, { behavior: 'deny', message: 'Turn aborted' }, 'policy'))
      this.core.setStatus('awaiting_approval')
    })
  }

  protected baseInfo(engineTitle?: string) {
    const log = this.core.log
    return {
      id: this.id,
      status: this.core.status,
      profile: this.config.profile,
      shellAgentWrite: this.config.shells ? this.config.shellAgentWrite : undefined,
      createdAt: this.createdAt,
      epoch: this.config.epoch,
      lastSeq: log.seq,
      activityCount: log.activityCount + (this.config.counterBase?.activity ?? 0),
      proseCount: log.proseCount + (this.config.counterBase?.prose ?? 0),
      contextUsage: log.contextUsage,
      checklist: log.checklist,
      pendingPermissionCount: this.core.pendingCount,
      meta: this.config.meta,
      scope: this.config.scope,
      owner: this.config.owner,
      agentContextReset: this.config.contextReset ? (true as const) : undefined,
      title: sessionTitle(this.config, engineTitle),
      statusLabel: (log.statusLabel === undefined ? this.config.statusLabel : log.statusLabel) ?? undefined,
      goal: this.goal ?? undefined,
      failure: this.core.failure,
      costUsd: this.core.cost.costUsd,
      usageByModel: this.core.cost.byModel,
      lastActivityAt: log.lastActivityAt,
    }
  }
}
