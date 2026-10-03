// pnpm smoke:background [claude|codex|all]   - one or two short turns per engine, on the operator's own credentials.
//
// The unit suites fake the task output file and the app-server's deltas. A green run proves, against the real
// engines: claude streams a foreground Bash call's output as `tool_output` while it runs, `backgroundTask` makes the
// blocked call return at once and lets a message queued behind it be answered while the command is still going,
// and the command's completion still arrives; codex streams `item/commandExecution/outputDelta` as `tool_output`
// onto the command's own row.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRunner, SessionRunner, connectAppServer, resolveBundledCodexExecutable, type Runner } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'
import { fail, finish, note, ok, step } from './lib/report.ts'

const which = process.argv[2] ?? 'all'
const MARK = `BG_${Math.random().toString(36).slice(2, 7)}`
const LOOP = `for i in $(seq 1 15); do echo ${MARK} line $i; sleep 2; done`

function drive(runner: Runner): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  return events
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

function toolUseIds(events: SessionEvent[], name: string): string[] {
  const ids: string[] = []
  for (const e of events) {
    if (e.type !== 'assistant_message' || typeof e.message.content === 'string') {
      continue
    }
    for (const block of e.message.content) {
      const b = block as { type?: string; name?: string; id?: string }
      if (b.type === 'tool_use' && b.name === name && b.id) {
        ids.push(b.id)
      }
    }
  }
  return ids
}

function toolResultText(events: SessionEvent[], toolUseId: string): string | undefined {
  for (const e of events) {
    if (e.type !== 'user_message' || typeof e.message.content === 'string') {
      continue
    }
    for (const block of e.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown }
      if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
        return typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      }
    }
  }
  return undefined
}

function outputs(events: SessionEvent[], toolUseId?: string) {
  return events.filter(
    (e): e is Extract<SessionEvent, { type: 'tool_output' }> => e.type === 'tool_output' && (toolUseId === undefined || e.toolUseId === toolUseId),
  )
}

function assistantTextAfter(events: SessionEvent[], seq: number): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'assistant_message' }> => e.type === 'assistant_message' && e.seq > seq)
    .map((e) => (typeof e.message.content === 'string' ? e.message.content : JSON.stringify(e.message.content)))
    .join('\n')
}

async function claude(cwd: string, env: Record<string, string | undefined>): Promise<void> {
  step('claude: live output, then move to background')
  const runner = new SessionRunner({ cwd, env, model: 'haiku', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
  const events = drive(runner)
  try {
    await waitFor(() => runner.info().status === 'idle', 60_000, 'the session to settle')
    runner.sendMessage(`Run exactly this one Bash command in the FOREGROUND (not run_in_background), with timeout 120000: ${LOOP}\nThen reply with just: done`)
    await waitFor(() => toolUseIds(events, 'Bash').length > 0, 120_000, 'the Bash call')
    const bashId = toolUseIds(events, 'Bash')[0]!
    await waitFor(() => outputs(events, bashId).some((e) => e.tail.includes(`${MARK} line 3`)), 30_000, 'live output')
    ok('foreground output streamed as tool_output', outputs(events, bashId).at(-1)!.tail.split('\n').at(-1))

    const mark = runner.info().lastSeq
    runner.sendMessage('Status question while that runs: what is 6 times 7? Answer with just the number.')
    const movedAt = Date.now()
    check(await runner.backgroundTask!(bashId), 'backgroundTask accepted')
    await waitFor(() => toolResultText(events, bashId) !== undefined, 15_000, 'the blocked call to return')
    note(`call returned ${Date.now() - movedAt} ms after the move`)
    check(/background/i.test(toolResultText(events, bashId)!), 'the call returned as backgrounded', toolResultText(events, bashId)!.slice(0, 120))
    await waitFor(() => assistantTextAfter(events, mark).includes('42'), 90_000, 'the queued message to be answered')
    const answeredAfter = Date.now() - movedAt
    check(answeredAfter < 28_000, 'queued message answered while the command still ran', `${answeredAfter} ms after the move`)
    await waitFor(
      () => events.some((e) => e.type === 'sdk_event' && e.payload.subtype === 'task_notification' && e.payload.tool_use_id === bashId),
      90_000,
      'the backgrounded command to finish',
    )
    ok('the backgrounded command reported its completion')
    check(!events.some((e) => e.type === 'session_error'), 'no session_error')
  } catch (error) {
    fail('claude cycle', error instanceof Error ? error.message : String(error))
  } finally {
    runner.close()
  }
}

async function codex(cwd: string, env: Record<string, string | undefined>): Promise<void> {
  step('codex: live command output')
  const codexBin = resolveBundledCodexExecutable()
  if (!codexBin) {
    fail('codex binary resolvable')
    return
  }
  const runner = new CodexRunner({
    cwd,
    env,
    model: process.argv.find((arg) => arg.includes('gpt')) ?? 'gpt-5.6-luna',
    permissionMode: 'bypassPermissions',
    connectFn: (options) => connectAppServer({ executable: codexBin, ...options }),
  })
  const events = drive(runner)
  try {
    await waitFor(() => runner.info().status === 'idle', 60_000, 'the session to settle')
    runner.sendMessage(`Run this shell command and wait for it to finish, then reply with just: done\n${LOOP}`)
    await waitFor(() => outputs(events).some((e) => e.tail.includes(`${MARK} line 3`)), 120_000, 'live output')
    const first = outputs(events).find((e) => e.tail.includes(MARK))!
    check(toolUseIds(events, 'CodexCommand').includes(first.toolUseId), 'tool_output lands on the command row', first.toolUseId)
    await waitFor(() => runner.info().status === 'idle', 120_000, 'the turn to end')
    check(outputs(events).length >= 3, 'several tails while it ran', `${outputs(events).length} tool_output events`)
    check(!events.some((e) => e.type === 'session_error'), 'no session_error')
  } catch (error) {
    fail('codex cycle', error instanceof Error ? error.message : String(error))
  } finally {
    runner.close()
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'wd-background-'))
const env: Record<string, string | undefined> = { ...process.env, WORKERDECK_AUTH_KEY: undefined }
if (which === 'claude' || which === 'all') {
  await claude(cwd, env)
}
if (which === 'codex' || which === 'all') {
  await codex(cwd, env)
}
rmSync(cwd, { recursive: true, force: true })
finish()
