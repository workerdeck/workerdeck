// pnpm smoke:context-reset [claude|codex|all]   - costs two short turns per engine, on the operator's own credentials.
//
// The unit suites drive fake engines. A green run proves, per real engine: the agent can call `context_reset`; the
// engine reports the turn's result before it reports idle (the error-cancel check depends on that order); the
// gateway's clear lands as a `conversation_reset` carrying the reason; the agent's prompt is the first message of
// the fresh conversation and gets answered; the word from before the reset is gone; the gateway tools still work
// after the clear; and an immediate second reset is refused by the rate limit, not run.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRunner, SessionRunner, connectAppServer, resolveBundledCodexExecutable, type Runner } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'
import { ContextResetService } from '../packages/server/src/services/context-resets.ts'
import { fail, finish, note, ok, step } from './lib/report.ts'

const WORD = 'ORRERY'
const MARK = 'RESUMED'
const REASON = 'smoke test reset'
const RESET_PROMPT =
  `You are continuing after a context reset. Call the session_info tool once. Then call the context_reset tool with ` +
  `prompt "again" and reason "second". Then reply with the word ${MARK}, then what context_reset answered, then the ` +
  `secret word from before the reset if you know one, else NONE.`
const which = process.argv[2] ?? 'all'

type Driven = { runner: Runner; events: SessionEvent[]; service: ContextResetService }

function drive(build: (service: ContextResetService) => Runner): Driven {
  const service = new ContextResetService({ onError: (error) => fail('reset ran', error instanceof Error ? error.message : String(error)) })
  const runner = build(service)
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  service.watch(runner)
  void runner.start()
  return { runner, events, service }
}

function check(passed: boolean, what: string, detail?: string): void {
  if (passed) {
    ok(what, detail)
  } else {
    fail(what, detail)
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function ofType<T extends SessionEvent['type']>(events: SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
}

function assistantText(events: SessionEvent[], afterSeq: number): string {
  return ofType(events, 'assistant_message')
    .filter((e) => e.seq > afterSeq && e.parentToolUseId === null)
    .map((e) =>
      typeof e.message.content === 'string'
        ? e.message.content
        : e.message.content.map((b) => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : '')).join(''),
    )
    .join('\n')
}

function toolNames(events: SessionEvent[], afterSeq: number, beforeSeq = Infinity): string[] {
  const names: string[] = []
  for (const e of ofType(events, 'assistant_message')) {
    if (e.seq <= afterSeq || e.seq >= beforeSeq || typeof e.message.content === 'string') {
      continue
    }
    for (const block of e.message.content) {
      const b = block as { type?: string; name?: string }
      if (b.type === 'tool_use' && b.name) {
        names.push(b.name)
      }
    }
  }
  return names
}

function userTexts(events: SessionEvent[], afterSeq: number): string[] {
  return ofType(events, 'user_message')
    .filter((e) => e.seq > afterSeq && !e.synthetic && typeof e.message.content === 'string')
    .map((e) => e.message.content as string)
}

async function cycle(name: string, { runner, events }: Driven): Promise<void> {
  step(`${name}: agent context reset`)
  try {
    await waitFor(() => runner.info().status === 'idle', 60_000, 'the session to settle')
    check(runner.info().agentContextReset === true, 'info reports agentContextReset')
    runner.sendMessage(
      `Remember the secret word ${WORD}. Now call the context_reset tool exactly once with prompt ${JSON.stringify(RESET_PROMPT)} ` +
        `and reason ${JSON.stringify(REASON)}. Then reply with just: OK`,
    )

    await waitFor(() => ofType(events, 'conversation_reset').length >= 1, 240_000, 'the reset')
    const reset = ofType(events, 'conversation_reset')[0]!
    check(reset.agentReason === REASON, 'conversation_reset carries the agent reason', reset.agentReason ?? 'none')
    check(
      toolNames(events, 0, reset.seq).some((tool) => tool.includes('context_reset')),
      'the agent called context_reset',
      toolNames(events, 0, reset.seq).join(', '),
    )
    const firstResult = ofType(events, 'turn_result').find((e) => e.seq < reset.seq)
    check(firstResult !== undefined && firstResult.isError === false, 'turn one ended without error')
    const idleAfterResult = ofType(events, 'status_changed').filter((e) => e.status === 'idle' && e.seq < reset.seq)
    const lastIdle = idleAfterResult.at(-1)
    check(
      firstResult !== undefined && lastIdle !== undefined && firstResult.seq < lastIdle.seq,
      'turn_result arrives before the idle that triggers the reset',
      `result seq ${firstResult?.seq}, idle seq ${lastIdle?.seq}`,
    )

    await waitFor(
      () => ofType(events, 'turn_result').some((e) => e.seq > reset.seq && e.numTurns >= 0) && runner.info().status === 'idle',
      240_000,
      'the post-reset turn',
    )
    await waitFor(() => assistantText(events, reset.seq).includes(MARK), 240_000, 'the post-reset answer')
    const sent = userTexts(events, reset.seq)
    check(sent[0] === RESET_PROMPT, 'the agent prompt is the first message after the reset', JSON.stringify(sent[0]?.slice(0, 80)))
    const answer = assistantText(events, reset.seq)
    note(`answer: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`)
    check(answer.includes(MARK), 'the fresh conversation answered the prompt')
    check(!answer.includes(WORD), 'the secret word did not survive the reset')
    const after = toolNames(events, reset.seq)
    check(
      after.some((tool) => tool.includes('session_info')),
      'gateway tools callable after the reset',
      after.join(', ') || 'no tool calls',
    )
    check(
      after.some((tool) => tool.includes('context_reset')),
      'the second context_reset was attempted',
      after.join(', ') || 'no tool calls',
    )
    check(/refused/i.test(JSON.stringify(events.filter((e) => e.seq > reset.seq))), 'the second reset was refused by the rate limit')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    check(ofType(events, 'conversation_reset').length === 1, 'no second reset ran')
    check(!events.some((e) => e.type === 'session_closed'), 'session never closed')
    const errors = ofType(events, 'session_error')
    check(errors.length === 0, 'no session_error', JSON.stringify(errors.map((e) => e.message)))
  } catch (error) {
    fail(`${name} cycle`, error instanceof Error ? error.message : String(error))
    const resetSeq = ofType(events, 'conversation_reset')[0]?.seq ?? 0
    for (const e of events.filter((ev) => ev.seq >= resetSeq && ev.type !== 'stream_delta')) {
      note(`${e.seq} ${e.type} ${JSON.stringify(e).slice(0, 220)}`)
    }
  } finally {
    runner.close()
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'wd-context-reset-'))
const env: Record<string, string | undefined> = { ...process.env, WORKERDECK_AUTH_KEY: undefined }

if (which === 'claude' || which === 'all') {
  await cycle(
    'claude',
    drive(
      (contextReset) =>
        new SessionRunner({
          cwd,
          env,
          model: 'haiku',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          contextReset,
        }),
    ),
  )
}
if (which === 'codex' || which === 'all') {
  const codexBin = resolveBundledCodexExecutable()
  if (!codexBin) {
    fail('codex binary resolvable')
  } else {
    await cycle(
      'codex',
      drive(
        (contextReset) =>
          new CodexRunner({
            cwd,
            env,
            model: process.argv.find((arg) => arg.includes('gpt')) ?? 'gpt-5.6-luna',
            permissionMode: 'bypassPermissions',
            contextReset,
            connectFn: (options) => connectAppServer({ executable: codexBin, ...options }),
          }),
      ),
    )
  }
}

rmSync(cwd, { recursive: true, force: true })
finish()
