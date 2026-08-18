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
 * Three decisions live here rather than in the protocol doc:
 *
 * **What counts as a spawn.** A record opens when a *top-level* assistant
 * message carries a `tool_use` named `Task` or `Agent` — the moment the
 * sub-agent exists, so a just-spawned agent is visible before its first nested
 * event, with the block's input in hand for its labels. Both names are observed
 * SDK spellings (`Task` synchronous, `Agent` async), and the name is a
 * convention, not a law — a session that spawned three `Agent`s under a tracker
 * that only knew `Task` reported all three as label-less failures. So three
 * more openers back the allowlist up: the CLI's own `task_started` system event
 * (which positively names the `tool_use_id` an agent runs under, with the brief
 * as labels), the launch acknowledgement (below), and — as before — any nested
 * event whose `parentToolUseId` has no record: an id that events demonstrably
 * nest under *is* a sub-agent, whatever the spawning call was named. A fallback
 * record never saw an input, so it stays label-less until a named signal fills
 * it in rather than resetting an accumulated count.
 *
 * **A background agent's `tool_result` is a launch receipt, not a verdict.**
 * An async agent's spawn call resolves seconds after the spawn with "Async
 * agent launched successfully. (This tool result is internal metadata …)" —
 * long before the agent has done anything — and its actual outcome travels on
 * a `task_notification` system event instead (`status: 'completed'` is `done`,
 * any other way of stopping is `failed`: the report the notification exists to
 * deliver never came). Settling on the receipt would read "0 of 3 agents
 * running" while three agents burn tokens, so a non-error result on a record
 * known to be background never settles it. Known how: the `task_started` event
 * live, or the receipt's own wrapper text on a resume — the stored transcript
 * carries none of the CLI's system events, so, exactly as
 * `isSyntheticUserText` documents for the `<task-notification>` blob, the text
 * is the only signal the replayed path has.
 *
 * **What an interrupted turn leaves behind.** A Task whose `tool_result` never
 * arrives — interrupt, session error, a turn or budget cap — would otherwise
 * read `running` on an idle session forever, a lie a list re-renders at every
 * poll. So the end of a turn settles every still-running record as `failed`:
 * the report never came, which is the one thing `done` could have claimed. The
 * sweep keys on `turn_result`, on the status coming to rest (`idle` — which is
 * how a resumed history that ends mid-Task settles, since the backfill replays
 * no `turn_result` — or a terminal state), and on the session closing. A real
 * verdict arriving anyway outranks the sweep's inference. The sweep's premise
 * — "the turn ended, so anything still running was cut off" — is false for a
 * background agent, which is *designed* to outlive its turn: the real session
 * behind this file ended three turns while its agents ran, and every
 * `turn_result` re-branded live, working agents as failures. So the turn and
 * idle sweeps spare a record marked background by a **live** signal. They do
 * not spare one whose only evidence is replayed: the backfill describes a
 * process that is gone, and a background agent the old process died inside can
 * never notify — `running` would be the forever-lie again. `session_closed`
 * and the terminal statuses settle everything, background included, for the
 * same reason: the process hosting those agents is gone.
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
          if (!SPAWNER_NAMES.has(block.name)) continue
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
        // A background agent stopping, as the resume backfill spells it: the
        // `<task-notification>` wrapper the CLI writes into the transcript
        // (live, the same fact arrives as a `task_notification` system event
        // and no user message at all). Parsed before the plain-string return
        // below — the stored form is a bare string.
        const note = parseTaskNotification(firstText(body.message.content))
        if (note) {
          const record = this.#recordFor(note.toolUseId, ts)
          const status = note.status === 'completed' ? 'done' : 'failed'
          if (record.status !== status) this.#settle(record, status)
          return
        }
        const content = body.message.content
        if (typeof content === 'string') return
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const result = block as {
            tool_use_id?: unknown
            is_error?: unknown
            content?: unknown
          }
          if (typeof result.tool_use_id !== 'string') continue
          if (result.is_error !== true && isLaunchAck(result.content)) {
            // The receipt marks the record background rather than settling it —
            // and *how* it was marked matters to the sweep: `live` outlives the
            // turn, `replay` describes a process that is gone. Live evidence is
            // never downgraded by a re-streamed duplicate on resume.
            const record = this.#recordFor(result.tool_use_id, ts)
            if (record.background !== 'live') {
              record.background = body.replay === true ? 'replay' : 'live'
            }
            continue
          }
          const record = this.#records.get(result.tool_use_id)
          if (!record) continue
          // Belt beside the wording sniff above: whatever the receipt says, a
          // non-error result on a background record carries no verdict — the
          // verdict travels on the notification.
          if (result.is_error !== true && record.background !== undefined) continue
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
      case 'sdk_event': {
        // The CLI's background-task lifecycle, live only — none of it lands in
        // the stored transcript a resume replays. `task_updated` is skipped on
        // purpose: it is keyed by task id alone, and the `task_notification`
        // that follows it carries the `tool_use_id` this rollup is keyed by.
        // `task_progress`'s `description` is skipped too — it is the agent's
        // *current activity* ("Running grep …"), not its brief, and a label
        // slot that changed per poll would be a status field wearing a label's
        // name.
        const p = body.payload as {
          type?: unknown
          subtype?: unknown
          tool_use_id?: unknown
          status?: unknown
          subagent_type?: unknown
          description?: unknown
        }
        if (p.type !== 'system' || typeof p.tool_use_id !== 'string') return
        if (p.subtype === 'task_started') {
          const record = this.#recordFor(p.tool_use_id, ts)
          record.background = 'live'
          record.agentType ??= cleaned(p.subagent_type)
          record.description ??= cleaned(p.description)
          return
        }
        if (p.subtype === 'task_notification') {
          const record = this.#recordFor(p.tool_use_id, ts)
          const status = p.status === 'completed' ? 'done' : 'failed'
          if (record.status !== status) this.#settle(record, status)
          return
        }
        return
      }
      case 'turn_result':
        this.#sweep(false)
        return
      case 'session_closed':
        this.#sweep(true)
        return
      case 'status_changed':
        if (body.status === 'idle') this.#sweep(false)
        else if (body.status === 'failed' || body.status === 'closed') this.#sweep(true)
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

  /**
   * End of turn (`final: false`): anything still running was cut off before
   * its report — except a background agent the live process still hosts, which
   * is designed to outlive the turn and settles by notification instead. End
   * of session (`final: true`): everything, background included, because the
   * process those agents lived in is gone.
   */
  #sweep(final: boolean): void {
    for (const record of this.#records.values()) {
      if (record.status !== 'running') continue
      if (!final && record.background === 'live') continue
      this.#settle(record, 'failed')
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
  /** Set when this is a *background* agent — one designed to outlive the turn
   * that spawned it — and by what kind of evidence: `live` (the `task_started`
   * event, or the launch receipt arriving on the live stream) spares it from
   * the turn/idle sweep; `replay` (the receipt replayed from a resumed
   * transcript) does not, because the process that ran it is gone and it can
   * never notify. Never downgraded from `live`. Internal — protocol's
   * `SubagentInfo` deliberately says nothing about it. */
  background?: 'live' | 'replay'
}

/** The spawner names observed in the wild: `Task` runs the agent inside the
 * turn, `Agent` launches it in the background. Deliberately just these two —
 * a third spelling is caught by `task_started`, the launch receipt, or the
 * nested-event fallback, so widening this to every tool would only turn
 * ordinary calls into phantom agents. */
const SPAWNER_NAMES = new Set(['Task', 'Agent'])

/** The async spawn's immediate `tool_result` — "Async agent launched
 * successfully. (This tool result is internal metadata …)" — recognized by its
 * wrapper text because on a resume that text is the only signal there is (the
 * `SYNTHETIC_USER_PREFIXES` argument; the CLI's system events are not stored).
 * Live, `task_started` marks the record first and this is redundant armor. */
const isLaunchAck = (content: unknown): boolean => {
  const text =
    typeof content === 'string' ? content : firstText(Array.isArray(content) ? content : [])
  return typeof text === 'string' && text.trimStart().startsWith('Async agent launched')
}

/** A background agent stopping, parsed from the `<task-notification>` wrapper
 * the CLI writes into the transcript. Field-tolerant on purpose: only the
 * `tool-use-id` (this rollup's key) and the `status` verdict are read. */
const parseTaskNotification = (
  text: string | undefined,
): { toolUseId: string; status: string } | undefined => {
  if (text === undefined || !text.trimStart().startsWith('<task-notification>')) return undefined
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1]
  if (toolUseId === undefined) return undefined
  const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(text)?.[1] ?? ''
  return { toolUseId, status }
}

/** The first text of a message body, however the content is spelled — the
 * stored transcript uses bare strings, the live stream uses blocks. */
const firstText = (content: string | ContentBlock[] | unknown[]): string | undefined => {
  if (typeof content === 'string') return content
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null | undefined
    if (b?.type === 'text' && typeof b.text === 'string') return b.text
  }
  return undefined
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
