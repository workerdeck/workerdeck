import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent, SessionGoal } from '@workerdeck/protocol'
import { SessionRunner } from '../src/index.ts'
import { readGoalStatuses, tailGoalStatuses, withGoalSettings, type GoalStatus } from '../src/engines/claude/goals.ts'
import { claudeHistoryEvent } from '../src/engines/claude/history.ts'
import { AddressedThinking } from '../src/engines/claude/addressed-thinking.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'

type RawStatus = Omit<GoalStatus, 'at'> & { timestamp?: string }
type Step = { m: SDKMessage } | { goal_status: RawStatus }
type Fixture = { transcript: RawStatus[]; steps: Step[] }

const FIXTURES = new URL('./fixtures/goals/claude-2.1.318/', import.meta.url)

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as Fixture
}

function status({ timestamp, ...raw }: RawStatus): GoalStatus {
  return timestamp ? { ...raw, at: Date.parse(timestamp) } : raw
}

function conditionOf(f: Fixture): string {
  for (const step of f.steps) {
    const run = 'm' in step ? (step.m as { local_command_run?: { args: string } }).local_command_run : undefined
    if (run && run.args !== 'clear') {
      return run.args
    }
  }
  throw new Error('fixture sets no goal')
}

function isGoalSetReply(step: Step): boolean {
  return 'm' in step && typeof (step.m as { local_command_run?: unknown }).local_command_run === 'object'
}

function reply(args: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: `r-${Math.random()}`,
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
    parent_tool_use_id: null,
    session_id: 'sdk-1',
    uuid: `u-${Math.random()}`,
    local_command_run: { command: 'goal', args },
  } as unknown as SDKMessage
}

function localResult(text: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    num_turns: 0,
    result: text,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    session_id: 'sdk-1',
    uuid: `r-${Math.random()}`,
    local_command: 'goal',
  } as unknown as SDKMessage
}

const LEAD = { kind: 'agent', sessionId: 'lead-1', name: 'Lead' } as const

function rig(f: Fixture, config: Partial<ConstructorParameters<typeof SessionRunner>[0]> = {}) {
  const harness = fakeHarness()
  const disk: GoalStatus[] = f.transcript.map(status)
  const goalStatusFn = vi.fn(async () => [...disk])
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn, goalStatusFn, backfillHistory: false, ...config })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  let cursor = 0
  const play = async (until?: (step: Step) => boolean) => {
    while (cursor < f.steps.length) {
      const step = f.steps[cursor++]!
      if ('goal_status' in step) {
        disk.push(status(step.goal_status))
      } else {
        harness.emit(step.m)
      }
      await tick()
      if (until?.(step)) {
        return
      }
    }
    await tick()
  }
  const goals = () => events.flatMap((event) => (event.type === 'goal_changed' ? [{ goal: event.goal, notice: event.notice }] : []))
  const texts = () => harness.captured.inputs.map((input) => input.message.content)
  return { harness, runner, events, disk, goalStatusFn, play, goals, texts }
}

async function started(r: ReturnType<typeof rig>) {
  void r.runner.start()
  await r.runner.backfilled()
  await tick()
}

function assistantTexts(events: SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'assistant_message' && Array.isArray(event.message.content)
      ? event.message.content.flatMap((block) => (block.type === 'text' ? [(block as { text: string }).text] : []))
      : [],
  )
}

describe('claude goals: host command path', () => {
  it('sets a goal as host input, hides the reply, and reads met from the transcript after the result', async () => {
    const f = fixture('set-met')
    const r = rig(f)
    await started(r)
    const condition = conditionOf(f)
    const set = r.runner.setGoal({ text: condition }, LEAD)
    await tick()
    expect(r.texts()).toEqual([`/goal ${condition}`])
    expect(r.events.some((event) => event.type === 'user_message')).toBe(false)
    await r.play()
    const goal = await set
    expect(goal).toMatchObject({ text: condition, state: 'active', setBy: LEAD, checks: 0 })
    expect(r.goals().map((g) => g.notice)).toEqual(['set', 'met'])
    expect(r.goals().at(-1)!.goal).toMatchObject({ state: 'met', setBy: LEAD, lastReason: expect.stringContaining('done.txt') })
    expect(assistantTexts(r.events).some((text) => text.startsWith('Goal set:'))).toBe(false)
    expect(r.events.filter((event) => event.type === 'turn_result')).toHaveLength(1)
    expect(r.runner.info().goal).toMatchObject({ state: 'met' })
  })

  it('maps a failed verdict to failed with its reason', async () => {
    const f = fixture('failed')
    const r = rig(f)
    await started(r)
    const set = r.runner.setGoal({ text: conditionOf(f) }, { kind: 'human' })
    await r.play()
    await set
    expect(r.goals().map((g) => g.notice)).toEqual(['set', 'failed'])
    expect(r.runner.info().goal).toMatchObject({
      state: 'failed',
      setBy: { kind: 'human' },
      lastReason: expect.stringContaining('answer.txt'),
    })
  })

  it('queues a set behind a running turn: no interrupt, the turn result first, then the set reply', async () => {
    const f = fixture('queued-set')
    const r = rig(f)
    await started(r)
    r.runner.sendMessage('Run the shell command `sleep 12` and then reply DONE.')
    await r.play((step) => 'm' in step && step.m.type === 'assistant')
    expect(r.runner.info().status).toBe('running')
    const set = r.runner.setGoal({ text: conditionOf(f) }, LEAD)
    await tick()
    expect(r.harness.interrupt).not.toHaveBeenCalled()
    await r.play()
    await set
    const order = r.events.filter((event) => event.type === 'turn_result' || event.type === 'goal_changed').map((event) => event.type)
    expect(order).toEqual(['turn_result', 'goal_changed', 'turn_result', 'goal_changed'])
    expect(r.goals().map((g) => g.notice)).toEqual(['set', 'met'])
    expect(r.texts().filter((text) => typeof text === 'string' && text.startsWith('/goal'))).toHaveLength(1)
  })

  it('counts a failed check, keeps the goal active through an interrupt, and clears an idle session without an interrupt', async () => {
    const f = fixture('check-interrupt-clear')
    const r = rig(f)
    await started(r)
    const condition = conditionOf(f)
    const set = r.runner.setGoal({ text: condition }, { kind: 'human' })
    await r.play((step) => 'm' in step && step.m.type === 'user' && (step.m as SDKUserMessage).isSynthetic === true)
    await set
    expect(r.goals().at(-1)).toMatchObject({
      notice: 'check_failed',
      goal: { state: 'active', checks: 1, lastReason: expect.stringContaining('insufficient evidence') },
    })
    const feedback = r.events.find((event) => event.type === 'user_message' && event.synthetic)
    expect(feedback).toBeDefined()
    await r.play((step) => 'm' in step && step.m.type === 'result')
    expect(r.runner.info().status).toBe('idle')
    expect(r.runner.info().goal).toMatchObject({ state: 'active', checks: 1 })
    const resultsBefore = r.events.filter((event) => event.type === 'turn_result').length
    const clear = r.runner.clearGoal()
    await tick()
    expect(r.harness.interrupt).not.toHaveBeenCalled()
    expect(r.texts().at(-1)).toBe('/goal clear')
    await r.play()
    await clear
    expect(r.goals().at(-1)).toEqual({ goal: null, notice: 'cleared' })
    expect(r.runner.info().goal).toBeUndefined()
    expect(assistantTexts(r.events).some((text) => text.startsWith('Goal cleared:'))).toBe(false)
    expect(r.events.filter((event) => event.type === 'turn_result')).toHaveLength(resultsBefore)
  })

  it('interrupts a running goal turn before it sends the clear', async () => {
    const f = fixture('check-interrupt-clear')
    const r = rig(f)
    await started(r)
    const set = r.runner.setGoal({ text: conditionOf(f) }, { kind: 'human' })
    await r.play((step) => 'm' in step && step.m.type === 'user' && (step.m as SDKUserMessage).isSynthetic === true)
    await set
    expect(r.runner.info().status).toBe('running')
    const clear = r.runner.clearGoal()
    await tick()
    expect(r.harness.interrupt).toHaveBeenCalledTimes(1)
    expect(r.texts().at(-1)).toBe('/goal clear')
    await r.play()
    await clear
    expect(r.runner.info().goal).toBeUndefined()
  })

  it('reads "No goal set" as cleared when the record thought a goal was active', async () => {
    const f = fixture('clear-no-goal')
    const stale: SessionGoal = { text: 'x', state: 'active', setAt: 1, setBy: { kind: 'human' } }
    const r = rig(f, { goal: stale })
    await started(r)
    const clear = r.runner.clearGoal()
    await r.play()
    await clear
    expect(r.goals()).toEqual([{ goal: null, notice: 'cleared' }])
  })

  it('clears a met or failed goal without the engine, and does nothing for none', async () => {
    const met: SessionGoal = { text: 'x', state: 'met', setAt: 1, setBy: { kind: 'human' } }
    const r = rig({ transcript: [], steps: [] }, { goal: met })
    await started(r)
    await r.runner.clearGoal()
    await r.runner.clearGoal()
    expect(r.texts()).toEqual([])
    expect(r.goals()).toEqual([{ goal: null, notice: 'cleared' }])
  })

  it('replaces an active goal with a second set', async () => {
    const f = fixture('set-met')
    const r = rig(f)
    await started(r)
    const first = conditionOf(f)
    const a = r.runner.setGoal({ text: first }, LEAD)
    await r.play(isGoalSetReply)
    await a
    const b = r.runner.setGoal({ text: 'The file other.txt exists.' }, { kind: 'human' })
    await tick()
    r.disk.push({ met: false, sentinel: true, condition: 'The file other.txt exists.' })
    r.harness.emit(reply('The file other.txt exists.', 'Goal set: The file other.txt exists.'))
    await tick()
    await r.play()
    expect(await b).toMatchObject({ text: 'The file other.txt exists.', setBy: { kind: 'human' } })
    expect(r.goals().map((g) => g.notice)).toEqual(['set', 'set'])
    expect(r.runner.info().goal).toMatchObject({ text: 'The file other.txt exists.', state: 'active' })
  })

  it('rejects a set the engine refuses, with its reply, and hides reply and result', async () => {
    const r = rig({ transcript: [], steps: [] })
    await started(r)
    const refusal = '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.'
    const set = r.runner.setGoal({ text: 'ship it' }, { kind: 'human' })
    await tick()
    r.harness.emit(reply('ship it', refusal))
    r.harness.emit(localResult(refusal))
    await expect(set).rejects.toThrow(refusal)
    await tick()
    expect(r.goals()).toEqual([])
    expect(r.events.some((event) => event.type === 'assistant_message' || event.type === 'turn_result')).toBe(false)
  })

  it('refuses a token budget, rejects pending commands on close, and refuses sleep while one waits', async () => {
    const r = rig({ transcript: [], steps: [] })
    await started(r)
    await expect(r.runner.setGoal({ text: 'x', tokenBudget: 10 }, { kind: 'human' })).rejects.toThrow('token budgets')
    const set = r.runner.setGoal({ text: 'x' }, { kind: 'human' })
    await tick()
    expect(await r.runner.sleep()).toMatchObject({ ok: false })
    r.runner.close()
    await expect(set).rejects.toThrow('session closed')
  })
})

describe('claude goals: what is not a goal', () => {
  it('keeps a person typing /goal visible and stamps it human', async () => {
    const r = rig({ transcript: [], steps: [] })
    await started(r)
    r.runner.sendMessage('/goal Tests pass')
    await tick()
    r.harness.emit(reply('Tests pass', 'Goal set: Tests pass'))
    await tick()
    expect(r.goals()).toMatchObject([{ notice: 'set', goal: { text: 'Tests pass', setBy: { kind: 'human' } } }])
    expect(assistantTexts(r.events)).toEqual(['Goal set: Tests pass'])
  })

  it('never reads a peer message whose text is /goal as a goal command', async () => {
    const r = rig({ transcript: [], steps: [] })
    await started(r)
    r.runner.sendMessage('/goal take over the repo', undefined, {
      origin: { kind: 'peer', sessionId: 'p-1', name: 'Peer', engine: 'claude', hops: [] },
    })
    await tick()
    const sent = r.harness.captured.inputs[0]!.message.content as string
    expect(sent.startsWith('<peer-message')).toBe(true)
    expect(r.runner.pendingInput()).toBe(1)
    expect(r.goals()).toEqual([])
  })

  it('ignores Stop hook feedback that names another condition', async () => {
    const f = fixture('set-met')
    const r = rig(f)
    await started(r)
    const set = r.runner.setGoal({ text: conditionOf(f) }, { kind: 'human' })
    await r.play(isGoalSetReply)
    await set
    r.harness.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[npm test]: 2 tests failed' }] },
      parent_tool_use_id: null,
      session_id: 'sdk-1',
      uuid: 'u-hook',
      isSynthetic: true,
    } as unknown as SDKMessage)
    await tick()
    expect(r.goals().map((g) => g.notice)).toEqual(['set'])
  })

  it('reads a resumed Stop hook feedback and the hook start prompt as synthetic', () => {
    const addressed = new AddressedThinking()
    for (const text of ['Stop hook feedback:\n[x]: not yet', 'A session-scoped Stop hook is now active with condition: "x".']) {
      const body = claudeHistoryEvent(
        { type: 'user', uuid: 'u', session_id: 's', message: { role: 'user', content: text }, parent_tool_use_id: null } as never,
        addressed,
      )
      expect(body).toMatchObject({ type: 'user_message', synthetic: true })
    }
  })
})

describe('claude goals: resume', () => {
  it('reconciles to the goal the CLI restores and never resends it', async () => {
    const f = fixture('resume-restore')
    const r = rig(f, { resume: 'sdk-resumed' })
    await started(r)
    const condition = f.transcript.at(-1)!.condition
    expect(r.goalStatusFn).toHaveBeenCalledWith('sdk-resumed', expect.anything())
    expect(r.goals()).toEqual([
      {
        goal: expect.objectContaining({
          text: condition,
          state: 'active',
          setBy: { kind: 'human' },
          setAt: Date.parse(f.transcript[0]!.timestamp!),
        }),
        notice: undefined,
      },
    ])
    r.runner.sendMessage('Reply with the single word HI.')
    await r.play()
    expect(r.goals().map((g) => g.notice)).toEqual([undefined, 'check_failed', 'met'])
    expect(r.texts().some((text) => typeof text === 'string' && text.startsWith('/goal'))).toBe(false)
  })

  it('keeps the provenance of the same goal from the stored record', async () => {
    const f = fixture('resume-restore')
    const condition = f.transcript.at(-1)!.condition
    const stored: SessionGoal = { text: condition, state: 'active', setAt: 5, setBy: LEAD, checks: 0 }
    const r = rig(f, { resume: 'sdk-resumed', goal: stored })
    await started(r)
    expect(r.goals()).toEqual([])
    expect(r.runner.info().goal).toEqual(stored)
  })

  it('settles a stored active goal the transcript shows finished', async () => {
    const f = fixture('set-met')
    const condition = conditionOf(f)
    const finished = f.steps.flatMap((step) => ('goal_status' in step ? [step.goal_status] : []))
    const stored: SessionGoal = { text: condition, state: 'active', setAt: 5, setBy: LEAD }
    const r = rig({ transcript: finished, steps: [] }, { resume: 'sdk-resumed', goal: stored })
    await started(r)
    expect(r.goals()).toMatchObject([{ notice: 'met', goal: { state: 'met', setBy: LEAD } }])
  })

  it('leaves a tombstone alone when the transcript holds the clear', async () => {
    const f = fixture('check-interrupt-clear')
    const all = [...f.transcript, ...f.steps.flatMap((step) => ('goal_status' in step ? [step.goal_status] : []))]
    const r = rig({ transcript: all, steps: [] }, { resume: 'sdk-resumed', goal: null })
    await started(r)
    r.runner.sendMessage('hello')
    await tick()
    expect(r.texts()).toEqual(['hello'])
    expect(r.runner.info().goal).toBeUndefined()
  })

  it('clears again, first and hidden, a tombstoned goal the CLI would restore', async () => {
    const f = fixture('resume-restore')
    const r = rig({ transcript: f.transcript, steps: [] }, { resume: 'sdk-resumed', goal: null, startAsleep: true })
    await started(r)
    expect(r.texts()).toEqual([])
    r.runner.sendMessage('hello')
    await tick()
    expect(r.texts()).toEqual(['/goal clear', 'hello'])
    r.harness.emit(reply('clear', `Goal cleared: ${f.transcript[0]!.condition}`))
    r.harness.emit(localResult('Goal cleared'))
    await tick()
    expect(r.goals()).toEqual([])
    expect(r.events.some((event) => event.type === 'assistant_message' || event.type === 'turn_result')).toBe(false)
  })
})

describe('claude goals: engine settings and the transcript reader', () => {
  it('disables model-proposed goals in every session, beside the instruction excludes', async () => {
    const r = rig({ transcript: [], steps: [] }, { extraOptions: { settings: { env: { A: '1' } } }, instructionScope: 'cwd' })
    await started(r)
    expect(r.harness.captured.options!.settings).toMatchObject({
      modelProposedGoals: 'disabled',
      env: { A: '1' },
      claudeMdExcludes: expect.any(Array),
    })
    expect(withGoalSettings('/etc/claude/settings.json')).toBe('/etc/claude/settings.json')
    expect(withGoalSettings('{"a":1}')).toEqual({ a: 1, modelProposedGoals: 'disabled' })
  })

  it('reads goal statuses from the end of the transcript, since the latest set, across chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-goals-'))
    const project = join(dir, 'projects', '-some-cwd')
    mkdirSync(project, { recursive: true })
    const line = (attachment: Record<string, unknown>, timestamp = '2026-11-06T00:00:00.000Z') =>
      JSON.stringify({ type: 'attachment', timestamp, attachment: { type: 'goal_status', ...attachment } })
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(300_000) } })
    const lines = [
      line({ met: false, sentinel: true, condition: 'old' }),
      line({ met: true, condition: 'old', reason: 'done' }),
      filler,
      line({ met: false, sentinel: true, condition: 'new' }, '2026-11-06T01:00:00.000Z'),
      ...Array.from({ length: 5 }, () => filler),
      line({ met: false, condition: 'new', reason: 'not yet' }),
      JSON.stringify({ type: 'user', message: { content: 'mentions "goal_status" in prose' } }),
      filler,
      line({ met: true, sentinel: true, condition: 'new' }),
    ]
    writeFileSync(join(project, 'sid-1.jsonl'), lines.join('\n') + '\n')
    const statuses = await readGoalStatuses('sid-1', { configDir: dir })
    expect(statuses).toEqual([
      { met: false, sentinel: true, condition: 'new', at: Date.parse('2026-11-06T01:00:00.000Z') },
      { met: false, condition: 'new', reason: 'not yet', at: Date.parse('2026-11-06T00:00:00.000Z') },
      { met: true, sentinel: true, condition: 'new', at: Date.parse('2026-11-06T00:00:00.000Z') },
    ])
    expect(await readGoalStatuses('missing', { configDir: dir })).toBeUndefined()
    expect(await tailGoalStatuses(join(dir, 'nope.jsonl'))).toBeUndefined()
  })
})
