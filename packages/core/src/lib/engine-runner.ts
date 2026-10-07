import { randomUUID } from 'node:crypto'
import type { PermissionRequest, SessionEvent, SessionInfo, SessionStatus, StatusLabel, StatusLabelInput } from '@workerdeck/protocol'
import type { EngineRunnerConfig, PermissionDecision, SendMessageOptions, SessionEventListener } from '../runner-interface.ts'
import { resolveApprovalTimeoutMs } from './approval-timeout.ts'
import { attachmentRef, type AttachmentInput } from './attachments.ts'
import type { CostLedgerState } from './cost-ledger.ts'
import { LocalCommandQueue, localCommandEvent, type LocalCommandResult, type LocalShellSource } from './local-command.ts'
import { RunnerCore, type CloseReason, type RunnerCoreHooks, type RunnerCoreOptions } from './runner-core.ts'
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

  protected echoUser(text: string, attachments: readonly AttachmentInput[] | undefined, options: SendMessageOptions | undefined): void {
    this.core.emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
      ...(options?.origin ? { origin: options.origin } : {}),
    })
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
    }
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
      activityCount: log.activityCount,
      proseCount: log.proseCount,
      contextUsage: log.contextUsage,
      checklist: log.checklist,
      pendingPermissionCount: this.core.pendingCount,
      meta: this.config.meta,
      scope: this.config.scope,
      owner: this.config.owner,
      agentContextReset: this.config.contextReset ? (true as const) : undefined,
      title: sessionTitle(this.config, engineTitle),
      statusLabel: (log.statusLabel === undefined ? this.config.statusLabel : log.statusLabel) ?? undefined,
      costUsd: this.core.cost.costUsd,
      usageByModel: this.core.cost.byModel,
      lastActivityAt: log.lastActivityAt,
    }
  }
}
