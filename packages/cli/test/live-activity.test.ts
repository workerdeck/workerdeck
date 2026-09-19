import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PermissionRequest, SessionInfo } from '@workerdeck/protocol'
import { attributesFor, buildLiveActivityPush, contentHash, projectContentState } from '../src/apns/live-activity.ts'

const FIXTURES = fileURLToPath(new URL('../../../apps/ios/WorkerDeckKit/Tests/WorkerDeckActivityTests/Fixtures/', import.meta.url))
const HOST_ID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301'
const STARTED = 1_757_764_800_000

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'ses_7f3a',
    status: 'running',
    cwd: '/Users/t/projects/ai/workerdeck',
    engine: 'claude',
    title: 'Wire the forwarder',
    createdAt: STARTED,
    lastSeq: 412,
    epoch: 2,
    pendingPermissionCount: 0,
    ...overrides,
  }
}

function checklist(done: number, active: string, total: number): SessionInfo['checklist'] {
  return Array.from({ length: total }, (_, index) => ({
    text: index === done ? active : `step ${index}`,
    status: index < done ? ('completed' as const) : index === done ? ('in_progress' as const) : ('pending' as const),
  }))
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: 'req_18b2', toolName: 'Bash', toolUseId: 'tu_1', input: {}, ...overrides }
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which auth method should the widget use?',
      header: 'Auth method',
      options: [{ label: 'Shared Keychain group' }, { label: 'App Group' }, { label: 'Hand off to the app' }],
    },
  ],
}

describe('live activity projection', () => {
  it('draws a running turn from the checklist, not from a tool event', () => {
    const state = projectContentState({
      info: session({ checklist: checklist(2, 'Reading packages/cli/src/apns/client.ts', 7) }),
      startedAtMs: STARTED,
    })
    expect(state.phase).toBe('running')
    expect(state.headline).toBe('Reading packages/cli/src/apns/client.ts')
    expect(state.steps).toEqual({ done: 2, total: 7 })
    expect(state.request).toBeUndefined()
  })

  it('says Working when the agent has planned nothing to say', () => {
    expect(projectContentState({ info: session(), startedAtMs: STARTED }).headline).toBe('Working…')
  })

  it('turns a permission request into an approval card with its command visible', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({ title: 'Bash', input: { command: 'pnpm --filter workerdeck test' } }),
      startedAtMs: STARTED,
    })
    expect(state.phase).toBe('approval')
    expect(state.headline).toBe('Bash')
    expect(state.detail).toBe('pnpm --filter workerdeck test')
    expect(state.request?.kind).toBe('permission')
    // A permission has nothing to choose between, so it carries no input: the buttons are
    // Approve/Deny, which need only the request id.
    expect(state.request?.choices).toEqual([])
    expect(state.request?.inputJSON).toBeUndefined()
  })

  it('gives a single-select question real buttons and the input to answer with', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({ id: 'req_18b3', toolName: 'AskUserQuestion', input: QUESTION_INPUT }),
      startedAtMs: STARTED,
    })
    expect(state.phase).toBe('question')
    expect(state.headline).toBe('Auth method')
    expect(state.detail).toBe('Which auth method should the widget use?')
    expect(state.request?.choices.map((choice) => choice.label)).toEqual(['Shared Keychain group', 'App Group', 'Hand off to the app'])
    expect(JSON.parse(state.request!.inputJSON!)).toEqual(QUESTION_INPUT)
  })

  it('refuses buttons for a multi-select question rather than answering one of many', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({
        toolName: 'AskUserQuestion',
        input: { questions: [{ ...QUESTION_INPUT.questions[0], multiSelect: true }] },
      }),
      startedAtMs: STARTED,
    })
    expect(state.request?.choices).toEqual([])
    expect(state.request?.inputJSON).toBeUndefined()
  })

  it('refuses buttons when there is more than one question', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({
        toolName: 'AskUserQuestion',
        input: { questions: [QUESTION_INPUT.questions[0], { ...QUESTION_INPUT.questions[0], header: 'Second' }] },
      }),
      startedAtMs: STARTED,
    })
    expect(state.request?.choices).toEqual([])
  })

  it('refuses buttons past the layout budget of four options', () => {
    const options = Array.from({ length: 5 }, (_, index) => ({ label: `option ${index}` }))
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({ toolName: 'AskUserQuestion', input: { questions: [{ ...QUESTION_INPUT.questions[0], options }] } }),
      startedAtMs: STARTED,
    })
    expect(state.request?.choices).toEqual([])
  })

  it('reads an ExitPlanMode request as a plan, not as an ordinary approval', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({ toolName: 'ExitPlanMode', input: { plan: 'Ship the widget extension first.' } }),
      startedAtMs: STARTED,
    })
    expect(state.phase).toBe('plan')
    expect(state.request?.kind).toBe('plan')
  })

  it('maps every terminal status onto a final phase', () => {
    const phase = (status: SessionInfo['status']) => projectContentState({ info: session({ status }), startedAtMs: STARTED }).phase
    expect(phase('idle')).toBe('done')
    expect(phase('parked')).toBe('parked')
    expect(phase('failed')).toBe('failed')
    expect(phase('closed')).toBe('ended')
    expect(phase('starting')).toBe('running')
  })

  it('carries an expiry as epoch milliseconds so the card can count down', () => {
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({ expiresAt: STARTED + 430_000 }),
      startedAtMs: STARTED,
    })
    expect(state.expiresAtMs).toBe(1_757_765_230_000)
  })

  it('never sets a decision - that field is the phone’s, and a push is what clears it', () => {
    expect(projectContentState({ info: session(), startedAtMs: STARTED }).decision).toBeNull()
  })

  it('hashes equal states equally so a no-op update is never pushed', () => {
    const one = projectContentState({ info: session(), startedAtMs: STARTED })
    const two = projectContentState({ info: session(), startedAtMs: STARTED })
    expect(contentHash(one)).toBe(contentHash(two))
    expect(contentHash({ ...one, headline: 'different' })).not.toBe(contentHash(one))
  })
})

describe('live activity push', () => {
  const attributes = attributesFor(session(), HOST_ID)
  const running = projectContentState({ info: session(), startedAtMs: STARTED })

  it('sends attributes and an alert only on a start', () => {
    const start = buildLiveActivityPush('start', { attributes, state: running, now: STARTED })
    const aps = (start.payload as { aps: Record<string, unknown> }).aps
    expect(aps.event).toBe('start')
    expect(aps['attributes-type']).toBe('SessionActivityAttributes')
    expect(aps.attributes).toEqual(attributes)
    expect(aps['input-push-token']).toBe(1)
    expect(aps.alert).toBeDefined()

    const update = buildLiveActivityPush('update', { attributes, state: running, now: STARTED })
    const updateAps = (update.payload as { aps: Record<string, unknown> }).aps
    expect(updateAps.attributes).toBeUndefined()
    // A second sound for a request the alert push already announced is noise.
    expect(updateAps.alert).toBeUndefined()
  })

  it('times out every push, so an offline phone cannot replay an answered question', () => {
    const urgent = buildLiveActivityPush('update', { attributes, state: running, urgent: true, now: STARTED })
    const progress = buildLiveActivityPush('update', { attributes, state: running, now: STARTED })
    expect(urgent.expiration).toBe(progress.expiration)
    expect(urgent.priority).toBe(10)
    expect(progress.priority).toBe(5)
  })

  it('ends with a dismissal date instead of a stale date', () => {
    const end = buildLiveActivityPush('end', {
      attributes,
      state: projectContentState({ info: session({ status: 'idle' }), startedAtMs: STARTED }),
      now: STARTED,
    })
    const aps = (end.payload as { aps: Record<string, unknown> }).aps
    expect(aps['dismissal-date']).toBe(Math.floor((STARTED + 15 * 60 * 1000) / 1000))
    expect(aps['stale-date']).toBeUndefined()
    expect(end.priority).toBe(10)
  })

  it('ranks a waiting card above a working one for the Dynamic Island', () => {
    const waiting = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request(),
      startedAtMs: STARTED,
    })
    const scoreOf = (state: typeof running) =>
      (buildLiveActivityPush('update', { attributes, state, now: STARTED }).payload as { aps: Record<string, unknown> }).aps[
        'relevance-score'
      ]
    expect(scoreOf(waiting)).toBeGreaterThan(scoreOf(running) as number)
  })

  it('drops the answer buttons before it drops any text', () => {
    const huge = 'x'.repeat(6000)
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', pendingPermissionCount: 1 }),
      request: request({
        toolName: 'AskUserQuestion',
        input: { questions: [{ ...QUESTION_INPUT.questions[0], question: `Which one? ${huge}` }] },
      }),
      startedAtMs: STARTED,
    })
    const push = buildLiveActivityPush('update', { attributes, state, now: STARTED })
    const sent = (push.payload as { aps: { 'content-state': typeof state } }).aps['content-state']
    expect(Buffer.byteLength(JSON.stringify(push.payload))).toBeLessThan(4096)
    expect(sent.request?.inputJSON).toBeUndefined()
    expect(sent.request?.choices).toEqual([])
    // The question is still legible; only the one-tap answer was given up.
    expect(sent.headline).toBe('Auth method')
  })

  it('still fits when every field is pathological', () => {
    const huge = 'y'.repeat(9000)
    const state = projectContentState({
      info: session({ status: 'awaiting_approval', title: huge, pendingPermissionCount: 1 }),
      request: request({ title: huge, input: { command: huge } }),
      startedAtMs: STARTED,
    })
    const push = buildLiveActivityPush('start', { attributes, state, now: STARTED })
    expect(Buffer.byteLength(JSON.stringify(push.payload))).toBeLessThan(4096)
  })
})

// The Swift side decodes these exact files with the real ActivityKit types
// (`apps/ios/WorkerDeckKit/Tests/WorkerDeckActivityTests`). Regenerate with `UPDATE_FIXTURES=1`;
// a diff here without one means the two languages have drifted apart.
describe('swift fixtures', () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      'start-running',
      buildLiveActivityPush('start', {
        attributes: attributesFor(session(), HOST_ID),
        state: projectContentState({
          info: session({ checklist: checklist(2, 'Reading packages/cli/src/apns/client.ts', 7) }),
          startedAtMs: STARTED,
        }),
        now: STARTED,
      }).payload as Record<string, unknown>,
    ],
    [
      'update-approval',
      buildLiveActivityPush('update', {
        attributes: attributesFor(session(), HOST_ID),
        state: projectContentState({
          info: session({
            status: 'awaiting_approval',
            pendingPermissionCount: 1,
            checklist: checklist(3, 'Running the suite', 7),
          }),
          request: request({ title: 'Bash', input: { command: 'pnpm --filter workerdeck test' }, expiresAt: STARTED + 430_000 }),
          startedAtMs: STARTED,
        }),
        urgent: true,
        now: STARTED + 130_000,
      }).payload as Record<string, unknown>,
    ],
    [
      'update-question',
      buildLiveActivityPush('update', {
        attributes: attributesFor(session(), HOST_ID),
        state: projectContentState({
          info: session({ status: 'awaiting_approval', pendingPermissionCount: 1, lastSeq: 447 }),
          request: request({ id: 'req_18b3', toolName: 'AskUserQuestion', input: QUESTION_INPUT }),
          startedAtMs: STARTED,
        }),
        urgent: true,
        now: STARTED + 210_000,
      }).payload as Record<string, unknown>,
    ],
    [
      'end-done',
      buildLiveActivityPush('end', {
        attributes: attributesFor(session(), HOST_ID),
        state: projectContentState({
          info: session({ status: 'idle', checklist: checklist(7, '', 7) }),
          startedAtMs: STARTED,
          finalHeadline: 'Finished in 10m 0s',
        }),
        now: STARTED + 600_000,
      }).payload as Record<string, unknown>,
    ],
  ]

  for (const [name, payload] of cases) {
    it(`matches ${name}.json`, () => {
      const path = join(FIXTURES, `${name}.json`)
      const rendered = `${JSON.stringify(payload, null, 2)}\n`
      if (process.env.UPDATE_FIXTURES === '1') {
        writeFileSync(path, rendered)
      }
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(payload)
    })
  }

  it('leaves the forward-compatibility fixture alone', () => {
    // `update-unknown-phase.json` is hand-written and must stay that way: it exists to prove the
    // phone degrades on a phase this forwarder cannot produce, so a generator could never write it.
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'update-unknown-phase.json'), 'utf8'))
    expect(payload.aps['content-state'].phase).toBe('compacting')
  })
})
