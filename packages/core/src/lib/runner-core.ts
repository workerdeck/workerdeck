import type {
  ByModel,
  PermissionDecisionSource,
  PermissionRequest,
  SessionEvent,
  SessionEventBody,
  SessionStatus,
  PricingTable,
} from '@workerdeck/protocol'
import type { PermissionDecision, SessionEventListener } from '../runner-interface.ts'
import { CostLedger, type CostLedgerState } from './cost-ledger.ts'
import { EventLog } from './event-log.ts'
import { PendingRequestRegistry, type PendingOutcome } from './pending-registry.ts'
import { SubscriberSet, type SubscribeOptions } from './subscribers.ts'

export const QUESTIONS_DISABLED_MESSAGE =
  'Interactive questions are disabled for this session: choose the most reasonable option yourself and continue.'

export const APPROVAL_TIMED_OUT = 'Approval timed out'

export const SESSION_CLOSED_MESSAGE = 'Session closed'

export type CloseReason = 'client' | 'server' | 'error'

export type RunnerCoreHooks = {
  prepare?: (body: SessionEventBody) => SessionEventBody
  observe?: (body: SessionEventBody, event: SessionEvent) => void
  settled?: (body: SessionEventBody, event: SessionEvent) => void
  holdStatus?: (status: SessionStatus) => boolean
}

export type RunnerCoreOptions = {
  pricing?: PricingTable
  cost?: 'additive' | 'reconcile'
  hooks?: RunnerCoreHooks
}

export type ApprovalResolution = { behavior: 'allow' | 'deny'; resolvedBy: PermissionDecisionSource; message?: string }

export type ApprovalHandler = {
  timeoutMs?: number
  wireId?: string | number
  respond: (decision: PermissionDecision, resolvedBy: PermissionDecisionSource) => ApprovalResolution
  after?: (resolution: ApprovalResolution, decision: PermissionDecision) => void
}

type ApprovalSettle = { decision: PermissionDecision; resolvedBy: PermissionDecisionSource; followUp: boolean }

type PendingApproval = { request: PermissionRequest; wireId?: string | number }

type TurnResultBody = Extract<SessionEventBody, { type: 'turn_result' }>

// `byModel` is observed as a delta before the report; `costs` puts the ledger's figures on the event.
export type TurnReport = {
  startedAt: number
  numTurns: number
  result?: string
  errors?: string[]
  usage?: TurnResultBody['usage']
  byModel?: ByModel
  costs: boolean
  totalCostUsd?: number
}

export function approvalResolution(
  decision: PermissionDecision,
  resolvedBy: PermissionDecisionSource,
  denied = 'Denied',
): ApprovalResolution {
  return { behavior: decision.behavior, resolvedBy, message: decision.behavior === 'deny' ? (decision.message ?? denied) : undefined }
}

export class RunnerCore {
  readonly log = new EventLog()
  readonly cost: CostLedger
  readonly #subscribers = new SubscriberSet()
  readonly #registry = new PendingRequestRegistry()
  readonly #approvals = new Map<string, PendingApproval>()
  readonly #hooks: RunnerCoreHooks
  readonly #carry: 'additive' | 'reconcile'
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #closed = false

  constructor(options: RunnerCoreOptions = {}) {
    this.cost = new CostLedger(options.pricing)
    this.#carry = options.cost ?? 'additive'
    this.#hooks = options.hooks ?? {}
  }

  get status(): SessionStatus {
    return this.#status
  }

  get closed(): boolean {
    return this.#closed
  }

  get terminal(): boolean {
    return this.#status === 'closed' || this.#status === 'failed'
  }

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#approvals.values()].map((pending) => pending.request)
  }

  get pendingCount(): number {
    return this.#approvals.size
  }

  // A rebuilt runner resumes at the status it was parked with, and that is not an event.
  restoreStatus(status: SessionStatus): void {
    this.#status = status
  }

  emit(body: SessionEventBody): SessionEvent {
    const prepared = this.#hooks.prepare?.(body) ?? body
    const event = this.log.append(prepared)
    this.#hooks.observe?.(prepared, event)
    this.#subscribers.emit(event)
    this.#hooks.settled?.(prepared, event)
    return event
  }

  setStatus(status: SessionStatus, detail?: string): void {
    if (this.#hooks.holdStatus?.(status)) {
      return
    }
    if (this.#status === status && this.#statusDetail === detail) {
      return
    }
    if (this.terminal) {
      return
    }
    this.#status = status
    this.#statusDetail = detail
    this.emit({ type: 'status_changed', status, detail })
  }

  subscribe(listener: SessionEventListener, afterSeq = 0, options?: SubscribeOptions): () => void {
    return this.#subscribers.subscribe(this.log.events, listener, afterSeq, options, this.log.resetSeq)
  }

  clearSubscribers(): void {
    this.#subscribers.clear()
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.log.at(seq)
  }

  carryCost(state: CostLedgerState): void {
    if (this.#carry === 'reconcile') {
      this.cost.carryUnlessRestored(state)
    } else {
      this.cost.carry(state)
    }
  }

  costState(): CostLedgerState {
    return this.cost.snapshot()
  }

  fail(message: string, close: (reason: CloseReason) => void): void {
    if (this.#closed) {
      return
    }
    this.emit({ type: 'session_error', message })
    this.setStatus('failed')
    close('error')
  }

  // Pending approvals are denied before the teardown runs, so a prompt never outlives the session that raised it.
  close(reason: CloseReason, teardown?: () => void, options: { settleApprovals?: boolean } = {}): boolean {
    if (this.#closed) {
      return false
    }
    this.#closed = true
    if (options.settleApprovals !== false) {
      this.settleAllApprovals({ behavior: 'deny', message: SESSION_CLOSED_MESSAGE }, 'policy')
    }
    teardown?.()
    this.emit({ type: 'session_closed', reason })
    this.setStatus('closed')
    return true
  }

  requestApproval(request: PermissionRequest, handler: ApprovalHandler): void {
    this.#approvals.set(request.id, { request, wireId: handler.wireId })
    void this.#registry.register<ApprovalSettle>({
      id: request.id,
      kind: 'approval',
      timeoutMs: handler.timeoutMs,
      onSettle: (outcome) => this.#settle(request, handler, outcome),
    })
    this.emit({ type: 'permission_requested', request })
  }

  resolveApproval(requestId: string, decision: PermissionDecision, resolvedBy: PermissionDecisionSource = 'client'): boolean {
    return this.#registry.settle<ApprovalSettle>(requestId, { decision, resolvedBy, followUp: true })
  }

  // `followUp: false` skips each handler's `after`, for a caller that owns the consequence itself.
  settleAllApprovals(decision: PermissionDecision, resolvedBy: PermissionDecisionSource, followUp = true): void {
    for (const id of Array.from(this.#approvals.keys())) {
      this.#registry.settle<ApprovalSettle>(id, { decision, resolvedBy, followUp })
    }
  }

  findApproval(predicate: (request: PermissionRequest, wireId: string | number | undefined) => boolean): string | undefined {
    for (const [id, pending] of this.#approvals) {
      if (predicate(pending.request, pending.wireId)) {
        return id
      }
    }
    return undefined
  }

  // The card still reaches the transcript, resolved by policy, so an operator can see what ran without being asked.
  resolveByPolicy(request: PermissionRequest, behavior: 'allow' | 'deny', message?: string): void {
    this.emit({ type: 'permission_requested', request })
    this.emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior,
      resolvedBy: 'policy',
      ...(message !== undefined ? { message } : {}),
    })
  }

  resolveQuestionByPolicy(request: PermissionRequest, mode: 'auto' | 'deny'): boolean {
    if (mode === 'deny') {
      this.resolveByPolicy(request, 'deny', QUESTIONS_DISABLED_MESSAGE)
      return false
    }
    this.resolveByPolicy(request, 'allow')
    return true
  }

  emitTurnResult(report: TurnReport): void {
    if (report.byModel) {
      this.cost.observeDelta(report.byModel)
    }
    const isError = report.errors !== undefined
    this.emit({
      type: 'turn_result',
      subtype: isError ? 'error_during_execution' : 'success',
      isError,
      durationMs: Date.now() - report.startedAt,
      numTurns: report.numTurns,
      totalCostUsd: report.totalCostUsd ?? this.cost.reportedCostUsd ?? 0,
      result: report.result,
      errors: report.errors,
      usage: report.usage,
      ...(report.costs ? { usageByModel: this.cost.byModel, costUsd: this.cost.costUsd } : {}),
    })
  }

  #settle(request: PermissionRequest, handler: ApprovalHandler, outcome: PendingOutcome<ApprovalSettle>): void {
    this.#approvals.delete(request.id)
    const settle: ApprovalSettle = outcome.ok
      ? outcome.value
      : { decision: { behavior: 'deny', message: APPROVAL_TIMED_OUT }, resolvedBy: 'timeout', followUp: true }
    const resolution = handler.respond(settle.decision, settle.resolvedBy)
    this.emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior: resolution.behavior,
      resolvedBy: resolution.resolvedBy,
      message: resolution.message,
    })
    if (settle.followUp) {
      handler.after?.(resolution, settle.decision)
    }
  }
}
