// pnpm smoke:sleep [claude|codex|all]   - costs two short turns per engine, on the operator's own credentials.
//
// The unit suites drive fake engines, so they show the runner's bookkeeping and cannot show that a real CLI or
// app-server, stopped and started again, resumes the same conversation with its tools back. A green run proves, per
// engine: a turn answers; sleep is accepted and the child goes; a second message wakes it into the SAME conversation
// (a word from turn one is recalled); the gateway's own tool (`session_info`) is callable again after the wake; the
// session never closed; and spend did not restart from zero. The wake latency is printed, not asserted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRunner, SessionRunner, connectAppServer, resolveBundledCodexExecutable, type Runner } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'
import { fail, finish, note, ok, step } from './lib/report.ts'

const WORD = 'ORRERY'
const which = process.argv[2] ?? 'all'

type Driven = { runner: Runner & { sleep(): ReturnType<NonNullable<Runner['sleep']>> }; events: SessionEvent[] }

function drive(runner: Driven['runner']): Driven {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  return { runner, events }
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

function results(events: SessionEvent[]): Extract<SessionEvent, { type: 'turn_result' }>[] {
  return events.filter((e): e is Extract<SessionEvent, { type: 'turn_result' }> => e.type === 'turn_result')
}

function assistantText(events: SessionEvent[], afterSeq: number): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'assistant_message' }> => e.type === 'assistant_message' && e.seq > afterSeq)
    .map((e) => (typeof e.message.content === 'string' ? e.message.content : JSON.stringify(e.message.content)))
    .join('\n')
}

function toolNames(events: SessionEvent[], afterSeq: number): string[] {
  const names: string[] = []
  for (const e of events) {
    if (e.type !== 'assistant_message' || e.seq <= afterSeq || typeof e.message.content === 'string') {
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

async function cycle(name: string, { runner, events }: Driven): Promise<void> {
  step(`${name}: sleep and wake`)
  try {
    await waitFor(() => runner.info().status === 'idle', 60_000, 'the session to settle')
    runner.sendMessage(`Remember the word ${WORD}. Reply with just: OK`)
    await waitFor(() => results(events).length >= 1 && runner.info().status === 'idle', 180_000, 'turn one')
    const costBefore = runner.info().costUsd ?? runner.info().totalCostUsd ?? 0
    ok('turn one answered', `cost ${costBefore.toFixed(4)}`)

    const slept = await runner.sleep()
    if (!slept.ok) {
      fail('sleep accepted', slept.reason)
      return
    }
    ok('sleep accepted')
    check(runner.info().engineAsleep === true, 'info reports engineAsleep')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const mark = runner.info().lastSeq
    const sentAt = Date.now()
    runner.sendMessage('Call the session_info tool once. Then reply with the word I asked you to remember, and nothing else.')
    await waitFor(() => events.some((e) => e.seq > mark && e.type === 'status_changed' && e.status === 'running'), 120_000, 'the wake')
    note(`wake to running: ${Date.now() - sentAt} ms`)
    await waitFor(() => results(events).length >= 2 && runner.info().status === 'idle', 240_000, 'turn two')

    check(runner.info().engineAsleep === undefined, 'awake after the message')
    const text = assistantText(events, mark)
    check(text.includes(WORD), 'recalled the word from before the sleep', text.slice(0, 200))
    const tools = toolNames(events, mark)
    check(
      tools.some((tool) => tool.includes('session_info')),
      'session_info callable after the wake',
      tools.join(', ') || 'no tool calls',
    )
    check(!events.some((e) => e.type === 'session_closed'), 'session never closed')
    const costAfter = runner.info().costUsd ?? runner.info().totalCostUsd ?? 0
    check(costAfter > costBefore, 'spend carried across the wake', `${costBefore.toFixed(4)} -> ${costAfter.toFixed(4)}`)
    const errors = events.filter((e) => e.type === 'session_error')
    check(errors.length === 0, 'no session_error', JSON.stringify(errors.map((e) => e.message)))
  } catch (error) {
    fail(`${name} cycle`, error instanceof Error ? error.message : String(error))
  } finally {
    runner.close()
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'wd-sleep-'))
const env: Record<string, string | undefined> = { ...process.env, WORKERDECK_AUTH_KEY: undefined }

if (which === 'claude' || which === 'all') {
  await cycle(
    'claude',
    drive(new SessionRunner({ cwd, env, model: 'haiku', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })),
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
        new CodexRunner({
          cwd,
          env,
          model: process.argv.find((arg) => arg.includes('gpt')) ?? 'gpt-5.6-luna',
          permissionMode: 'bypassPermissions',
          connectFn: (options) => connectAppServer({ executable: codexBin, ...options }),
        }),
      ),
    )
  }
}

rmSync(cwd, { recursive: true, force: true })
finish()
