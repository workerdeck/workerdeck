import { SUBAGENT_HISTORY, type SubagentInfo } from '@workerdeck/protocol'

/**
 * The codex side of `SessionInfo.subagents`. Nothing is inferred (unlike
 * `engines/claude/subagents.ts`): `subAgentActivity {kind: 'started'}` announces
 * every agent, so a record is keyed by **thread id** — the wire's handle — while
 * exposing the anchor **tool-use id** that `parentToolUseId` on nested events
 * must equal for `subagentItems` to reassemble the sidechain.
 *
 * A record survives the runner's turns (codex agents outlive the turn that
 * spawned them) and ends only at {@link sweep}, when the app-server child dies.
 * The settled tail is bounded by {@link SUBAGENT_HISTORY}; running records are not.
 * Full story: docs/GOTCHAS.md §Codex engine.
 */
export class CodexAgentTracker {
  #byThread = new Map<string, CodexAgent>()
  #settleCounter = 0

  /** The record whose thread this is — the attribution lookup. */
  get(agentThreadId: string): CodexAgent | undefined {
    return this.#byThread.get(agentThreadId)
  }

  /** Open (or return) the record for a thread. Fill-in, never overwrite: a
   * label-less fallback record keeps its accumulated count and its already
   * published toolUseId when the announcing item arrives late. */
  open(agentThreadId: string, toolUseId: string, agentType: string | undefined, ts: number): CodexAgent {
    let record = this.#byThread.get(agentThreadId)
    if (!record) {
      record = {
        agentThreadId,
        toolUseId,
        status: 'running',
        startedAt: ts,
        toolCount: 0,
        counted: new Set(),
      }
      this.#byThread.set(agentThreadId, record)
    }
    record.agentType ??= agentType
    return record
  }

  /** The agent's thread ran again (`kind: 'interacted'`, or a fresh
   * `turn/started` on its thread): a settled verdict no longer describes it. */
  revive(record: CodexAgent): void {
    record.status = 'running'
    record.settledOrder = undefined
  }

  #settle(record: CodexAgent, status: 'done' | 'failed'): void {
    record.status = status
    record.settledOrder = ++this.#settleCounter
    let settled = 0
    for (const r of this.#byThread.values()) {
      if (r.settledOrder !== undefined) {
        settled++
      }
    }
    while (settled > SUBAGENT_HISTORY) {
      let oldest: CodexAgent | undefined
      for (const r of this.#byThread.values()) {
        if (r.settledOrder === undefined) {
          continue
        }
        if (!oldest || r.settledOrder < oldest.settledOrder!) {
          oldest = r
        }
      }
      if (!oldest) {
        break
      }
      this.#byThread.delete(oldest.agentThreadId)
      settled--
    }
  }

  /** A real verdict for one agent — its thread's `turn/completed`, or the
   * `interrupted` activity edge. */
  settle(record: CodexAgent, status: 'done' | 'failed'): void {
    if (record.status === status) {
      return
    }
    this.#settle(record, status)
  }

  /** The process the agents lived in is gone (child death, session close):
   * everything still running is settled as failed — the report can never come. */
  sweep(): void {
    for (const record of this.#byThread.values()) {
      if (record.status === 'running') {
        this.#settle(record, 'failed')
      }
    }
  }

  /**
   * The conversation these agents belonged to is gone (a `conversation_reset`).
   *
   * Deliberately NOT {@link CodexAgentTracker.sweep}: that settles the running
   * ones as failed and keeps the rows, which is right when the *process* dies —
   * the transcript still holds the anchor `tool_use` each row points at, and a
   * row that vanished would leave that card unexplained. A clear is the other
   * way round. The anchors go with the transcript, so a surviving row would
   * publish a `toolUseId` that resolves to nothing — and clients key a
   * pressable, enterable agent line off exactly that id.
   */
  forget(): void {
    this.#byThread.clear()
  }

  /** The thread ids currently tracked — what a clear remembers so a still-running
   * agent's later traffic can be dropped rather than re-anchored. */
  threadIds(): string[] {
    return Array.from(this.#byThread.keys())
  }

  /** The rollup as `SessionInfo.subagents` serves it — spawn order, fresh
   * objects, and `undefined` when there is nothing to say (absent and empty
   * mean the same thing to a client, and bytes on a polled list are paid for). */
  list(): SubagentInfo[] | undefined {
    if (this.#byThread.size === 0) {
      return undefined
    }
    const out: SubagentInfo[] = []
    for (const r of this.#byThread.values()) {
      out.push({
        toolUseId: r.toolUseId,
        agentType: r.agentType,
        status: r.status,
        startedAt: r.startedAt,
        toolCount: r.toolCount,
      })
    }
    return out
  }
}

export type CodexAgent = {
  /** The wire's handle: the thread every one of this agent's notifications names. */
  agentThreadId: string
  /** The protocol's handle: the anchor `tool_use`'s id, which nested events
   * carry as `parentToolUseId` and `SubagentInfo.toolUseId` publishes. */
  toolUseId: string
  /** The agent's name — `agentPath`'s basename ('date_one'). Doubles as the
   * anchor input's `subagent_type`, which is the field `isAgentRecord` and
   * `taskIdentity` key a pressable, labelled row off. */
  agentType?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  /** Nested tool calls emitted so far — the running progress reading. */
  toolCount: number
  /** Tool-use ids already counted: `imageGeneration` re-emits its card with the
   * finished input (an upsert, one row), and a count that ticked twice for one
   * picture would make two agents' readings incomparable. */
  counted: Set<string>
  /** Whether the anchor `tool_use` row exists in the transcript yet. */
  anchored?: boolean
  /** Monotonic settle stamp; the retention bound evicts the smallest. Insertion
   * order cannot stand in: records open in spawn order, and a slow early agent
   * settles after a fast late one. */
  settledOrder?: number
}
