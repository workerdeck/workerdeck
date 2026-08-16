import {
  SUBAGENT_HISTORY,
  type ContentBlock,
  type SessionEventBody,
  type SubagentInfo,
} from '@workerdeck/protocol'

/**
 * The rollup behind `SessionInfo.subagents` — what a sessions list (which never
 * attaches) can know about the sub-agents running inside a session. Fed from
 * `SessionRunner.#emit`, the one chokepoint every event passes through, so the
 * resume backfill — which replays history through the same path — reconstructs
 * it with no persistence of its own. Grouping is by Task id throughout, never
 * adjacency: parallel sub-agents interleave in the stream, the same fact that
 * broke the terminal theme's positional row model.
 *
 * Two decisions live here rather than in the protocol doc:
 *
 * **What counts as a Task call.** A record opens when a *top-level* assistant
 * message carries a `tool_use` named `Task` — the moment the sub-agent exists,
 * so a just-spawned agent is visible before its first nested event, with the
 * block's input in hand for its labels. The name is an SDK convention, though,
 * not a law, so any nested event whose `parentToolUseId` has no record opens
 * one as a fallback: an id that events demonstrably nest under *is* a
 * sub-agent, whatever the spawning call was named. A fallback record never saw
 * an input, so it stays label-less — and if the named call does turn up, it
 * fills the labels in rather than resetting an accumulated count.
 *
 * **What an interrupted turn leaves behind.** A Task whose `tool_result` never
 * arrives — interrupt, session error, a turn or budget cap — would otherwise
 * read `running` on an idle session forever, a lie a list re-renders at every
 * poll. So the end of a turn settles every still-running record as `failed`:
 * the report never came, which is the one thing `done` could have claimed. The
 * sweep keys on `turn_result`, on the status coming to rest (`idle` — which is
 * how a resumed history that ends mid-Task settles, since the backfill replays
 * no `turn_result` — or a terminal state), and on the session closing. A real
 * `tool_result` arriving anyway outranks the sweep's inference.
 */
export class SubagentTracker {
  #records = new Map<string, TrackedSubagent>()
  #settleCounter = 0

  /** Fold one emitted event body into the rollup, in log order. */
  observe(body: SessionEventBody, ts: number): void {
    switch (body.type) {
      case 'assistant_message': {
        if (body.parentToolUseId != null) {
          const record = this.#recordFor(body.parentToolUseId, ts)
          // Progress is tool calls, not prose: a sub-agent's text and thinking
          // are its working, and counting them would make two agents' readings
          // incomparable. A nested `Task` block (a grandchild spawn, should an
          // engine ever nest) is still one tool call of *this* sub-agent.
          record.toolCount += toolUseBlocks(body.message.content).length
          return
        }
        for (const block of toolUseBlocks(body.message.content)) {
          if (block.name !== 'Task') continue
          this.#open(block, ts)
        }
        return
      }
      case 'user_message': {
        if (body.parentToolUseId != null) {
          // A sidechain's first event is usually its brief; touching the record
          // here is what makes the fallback catch a renamed spawner promptly.
          this.#recordFor(body.parentToolUseId, ts)
          return
        }
        const content = body.message.content
        if (typeof content === 'string') return
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const result = block as { tool_use_id?: unknown; is_error?: unknown }
          if (typeof result.tool_use_id !== 'string') continue
          const record = this.#records.get(result.tool_use_id)
          if (!record) continue
          const status = result.is_error === true ? 'failed' : 'done'
          // Equal-verdict results are skipped rather than re-stamped: the SDK
          // re-streams user messages on resume, and a duplicate that re-stamped
          // settle order would shuffle the retention bound. An *unequal* one
          // re-settles — the engine's own verdict outranks the sweep's.
          if (record.status === status) continue
          this.#settle(record, status)
        }
        return
      }
      case 'turn_result':
      case 'session_closed':
        this.#sweep()
        return
      case 'status_changed':
        if (body.status === 'idle' || body.status === 'failed' || body.status === 'closed') {
          this.#sweep()
        }
        return
      case 'conversation_reset':
        // The conversation is gone; so are the Tasks it ran. The same claim the
        // reset watermark makes for replay: a fresh attacher never sees those
        // rows, so a rollup pointing into them would dangle.
        this.#records.clear()
        return
      default:
        // stream_delta lands here on purpose: deltas count zero (superseded by
        // construction), and they must not open the fallback either — the
        // resume backfill replays no deltas, so a record only a delta opened
        // would not survive a rebuild.
        return
    }
  }

  /**
   * The rollup as `SessionInfo.subagents` serves it: spawn order (the
   * transcript's own), fresh objects, and `undefined` when there is nothing to
   * say — absent and empty mean the same thing to a client, and an empty array
   * on every row of a 1.2s-polled list is bytes spent saying nothing.
   */
  list(): SubagentInfo[] | undefined {
    if (this.#records.size === 0) return undefined
    const out: SubagentInfo[] = []
    for (const r of this.#records.values()) {
      out.push({
        toolUseId: r.toolUseId,
        agentType: r.agentType,
        description: r.description,
        status: r.status,
        startedAt: r.startedAt,
        toolCount: r.toolCount,
      })
    }
    return out
  }

  #recordFor(toolUseId: string, ts: number): TrackedSubagent {
    let record = this.#records.get(toolUseId)
    if (!record) {
      record = { toolUseId, status: 'running', startedAt: ts, toolCount: 0 }
      this.#records.set(toolUseId, record)
    }
    return record
  }

  #open(block: { id: string; input: unknown }, ts: number): void {
    const record = this.#recordFor(block.id, ts)
    const input = block.input as
      | { subagent_type?: unknown; description?: unknown }
      | null
      | undefined
    // Fill-in, never overwrite: this may be upgrading a label-less fallback
    // record that already accumulated a count.
    record.agentType ??= cleaned(input?.subagent_type)
    record.description ??= cleaned(input?.description)
  }

  /** End of turn: anything still running was cut off before its report. */
  #sweep(): void {
    for (const record of this.#records.values()) {
      if (record.status === 'running') this.#settle(record, 'failed')
    }
  }

  #settle(record: TrackedSubagent, status: 'done' | 'failed'): void {
    record.status = status
    record.settledOrder = ++this.#settleCounter
    // The bound is enforced here rather than in list(): a settle happens once
    // per sub-agent, list() once per row of a polled sessions list. Running
    // records are never evicted — they are the live reading and the reason the
    // field exists.
    let settled = 0
    for (const r of this.#records.values()) {
      if (r.settledOrder !== undefined) settled++
    }
    while (settled > SUBAGENT_HISTORY) {
      let oldestId: string | undefined
      let oldestOrder = Infinity
      for (const r of this.#records.values()) {
        if (r.settledOrder === undefined || r.settledOrder >= oldestOrder) continue
        oldestId = r.toolUseId
        oldestOrder = r.settledOrder
      }
      if (oldestId === undefined) break
      this.#records.delete(oldestId)
      settled--
    }
  }
}

type TrackedSubagent = SubagentInfo & {
  /** Monotonic settle stamp; the retention bound evicts the smallest. Insertion
   * order cannot stand in for it — records open in spawn order, and a slow
   * early Task settles after a fast late one. */
  settledOrder?: number
}

/** Trim, drop blank, clip at the same 80 the terminal theme's `taskLabel` uses.
 * Model-authored input rides every row of a polled sessions list, so it is
 * bounded here rather than trusted — a 10KB `description` would be paid for at
 * every poll. */
const cleaned = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length > 80 ? text.slice(0, 79) + '…' : text
}

/** The `tool_use` blocks of a message body, however the content is spelled. */
function toolUseBlocks(
  content: string | ContentBlock[],
): Array<{ id: string; name: string; input: unknown }> {
  if (typeof content === 'string') return []
  const blocks: Array<{ id: string; name: string; input: unknown }> = []
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const b = block as { id?: unknown; name?: unknown; input?: unknown }
    if (typeof b.id !== 'string' || typeof b.name !== 'string') continue
    blocks.push({ id: b.id, name: b.name, input: b.input })
  }
  return blocks
}
