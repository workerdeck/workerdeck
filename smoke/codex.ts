/**
 * smoke:codex — everything a fake cannot validate about the Codex engine.
 *
 *   pnpm smoke:codex [model]        # full run — needs codex auth, costs plan/API usage
 *   pnpm smoke:codex --canary       # the free auth-drift canaries only (network, no tokens)
 *
 * Auth (either route; both verified 2026-08-05, see the PRD's matrix):
 *   - `codex login` in YOUR terminal (ChatGPT plan), or
 *   - CODEX_API_KEY in the environment / repo .env.
 *   OPENAI_API_KEY alone does NOT work — codex exec ignores it (canary 1 is the
 *   alarm for the release where that changes).
 *
 * The paid part is the drift alarm for `--experimental-json` (the SDK is
 * pre-1.0 and the flag's name promises drift): the real JSONL vocabulary vs
 * our §9.2 mapping, a real command execution with its exit code, the §9.5
 * usage-relation asserts (open question 1), resume continuity, interrupt
 * behavior + post-interrupt resumability (open question 3), and the read-only
 * sandbox actually refusing a write (open question 2). Any change to
 * CodexRunner's spawn options or event mapping requires a run.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Codex } from '@openai/codex-sdk'
import { CodexRunner, resolveBundledCodexExecutable } from '@workerdeck/core'
import type { CodexFactory, CodexOptionsLike } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'

const MODEL = process.argv.find((a) => !a.startsWith('-') && a.includes('gpt')) ?? 'gpt-5.6-luna'
const CANARY_ONLY = process.argv.includes('--canary')

const execFileP = promisify(execFile)
let failures = 0
const pass = (name: string, detail: string) => console.log(`  PASS  ${name} — ${detail}`)
const fail = (name: string, detail: string) => {
  failures += 1
  console.error(`  FAIL  ${name} — ${detail}`)
}

/** Complete child env (codex replaces, never merges) with a scratch home. */
function scratchEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'codex-smoke-home-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // The scratch home isolates auth; the auth env vars are controlled per test.
  delete env.CODEX_API_KEY
  delete env.OPENAI_API_KEY
  delete env.CODEX_ACCESS_TOKEN
  env.CODEX_HOME = home
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

/** One throwaway exec turn; returns the terminal failure message ('' = completed). */
async function probeTurn(env: Record<string, string>): Promise<string> {
  const codex = new Codex({ env })
  const thread = codex.startThread({
    sandboxMode: 'read-only',
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
  })
  try {
    const { events } = await thread.runStreamed('say hi')
    let lastError = ''
    for await (const event of events) {
      if (event.type === 'turn.failed') return event.error.message
      if (event.type === 'error') lastError = event.message
      if (event.type === 'turn.completed') return ''
    }
    return lastError || 'stream ended without a terminal event'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function canaries(): Promise<void> {
  console.log('\n— free auth-drift canaries (fake keys, scratch CODEX_HOME, no tokens) —')

  // 1. OPENAI_API_KEY alone must still be a no-op for exec. The day this
  //    fails with invalid_api_key instead, codex started honoring the var and
  //    the availability probe's rule 4 (and its reason line) are stale.
  const viaOpenai = await probeTurn(scratchEnv({ OPENAI_API_KEY: 'sk-smoke-fake' }))
  if (viaOpenai.includes('Missing bearer')) {
    pass('OPENAI_API_KEY ignored', 'exec sent no credential (Missing bearer)')
  } else if (viaOpenai.toLowerCase().includes('invalid') && viaOpenai.includes('api')) {
    fail(
      'OPENAI_API_KEY ignored',
      `exec SENT the key (${viaOpenai.slice(0, 80)}…) — codex now honors OPENAI_API_KEY; ` +
        'update the availability probe (PRD §6.4 rule 4) and ENGINE docs',
    )
  } else {
    fail('OPENAI_API_KEY ignored', `unexpected failure shape: ${viaOpenai.slice(0, 120)}`)
  }

  // 2. CODEX_API_KEY must still reach exec as a bearer (the env auth route).
  const viaCodexKey = await probeTurn(scratchEnv({ CODEX_API_KEY: 'sk-smoke-fake' }))
  if (viaCodexKey.includes('invalid_api_key') || viaCodexKey.includes('Incorrect API key')) {
    pass('CODEX_API_KEY honored', 'exec sent the key (invalid_api_key for the fake)')
  } else {
    fail('CODEX_API_KEY honored', `unexpected failure shape: ${viaCodexKey.slice(0, 120)}`)
  }

  // 3. `login status` still exit-codes its verdict on an empty home.
  const codexBin = resolveBundledCodexExecutable()
  if (!codexBin) {
    fail('login status verdict', 'could not resolve the bundled codex binary')
  } else {
    try {
      await execFileP(codexBin, ['login', 'status'], { env: scratchEnv(), timeout: 15_000 })
      fail('login status verdict', 'exit 0 on an empty CODEX_HOME')
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      const output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
      if (output.includes('Not logged in')) {
        pass('login status verdict', 'empty home → "Not logged in", exit 1')
      } else {
        fail('login status verdict', `unexpected output: ${output.trim().slice(0, 80)}`)
      }
    }
  }
}

/** The auth this run will use, mirroring the availability probe's chain. */
async function detectAuth(): Promise<string | null> {
  if (process.env.CODEX_API_KEY) return 'CODEX_API_KEY'
  const codexBin = resolveBundledCodexExecutable()
  if (!codexBin) return null
  try {
    await execFileP(codexBin, ['login', 'status'], { timeout: 15_000 })
    return 'codex login'
  } catch {
    return null
  }
}

const realCodexFactory: CodexFactory = (options: CodexOptionsLike) =>
  new Codex(options) as ReturnType<CodexFactory>

function makeRunner(cwd: string, overrides: Record<string, unknown> = {}): {
  runner: CodexRunner
  events: SessionEvent[]
} {
  const runner = new CodexRunner({
    cwd,
    model: MODEL,
    codexFn: realCodexFactory,
    ...overrides,
  })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  return { runner, events }
}

const turnResults = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { type: 'turn_result' }> => e.type === 'turn_result')

async function paid(): Promise<void> {
  const auth = await detectAuth()
  if (!auth) {
    fail(
      'auth',
      'no codex credentials: run `codex login` in your own terminal, or set CODEX_API_KEY ' +
        '(in the environment or the repo .env). OPENAI_API_KEY alone is not used by codex.',
    )
    return
  }
  console.log(`\n— paid smoke (auth: ${auth}, model: ${MODEL}) —`)
  const cwd = mkdtempSync(join(tmpdir(), 'codex-smoke-cwd-'))

  try {
    // Turn 1: a real command execution, mapped through CodexRunner.
    const { runner, events } = makeRunner(cwd, {
      prompt: 'Run the shell command `echo codex-smoke-ok` and tell me its exact output.',
    })
    await runner.start()
    const [result] = turnResults(events)
    if (!result) throw new Error('turn 1 produced no turn_result')
    if (result.subtype !== 'success') {
      throw new Error(`turn 1 failed: ${result.errors?.join('; ')}`)
    }
    const commandUse = events.some(
      (e) =>
        e.type === 'assistant_message' &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'CodexCommand',
        ),
    )
    if (commandUse) pass('command execution', 'CodexCommand tool_use emitted for the echo')
    else fail('command execution', 'no CodexCommand tool_use in the transcript')
    const echoed = events.some(
      (e) =>
        e.type === 'user_message' &&
        Array.isArray(e.message.content) &&
        JSON.stringify(e.message.content).includes('codex-smoke-ok'),
    )
    if (echoed) pass('command output', 'tool_result carries the echoed marker')
    else fail('command output', 'echo output did not reach a tool_result')

    // Streaming granularity — a drift alarm in canary 1's shape, not a feature
    // test. Verified 2026-08-05 against 0.146.0: a turn is exactly
    // thread.started / turn.started / item.completed / turn.completed, with no
    // item.updated under either --experimental-json or legacy --json, so
    // CodexRunner's delta synthesis never fires and a turn lands as one wall of
    // text. The day this fails, codex started streaming: #handleItemProgress
    // has woken up, ENGINE_CAPABILITIES.codex.streaming may deserve better than
    // 'item', and the GOTCHAS bullet is stale.
    const deltas = events.filter((e) => e.type === 'stream_delta').length
    if (deltas === 0) {
      pass('no partial streaming', 'turn arrived as one item.completed, as mapped')
    } else {
      fail(
        'no partial streaming',
        `${deltas} stream_delta event(s) — codex now emits item.updated; re-check ` +
          "ENGINE_CAPABILITIES.codex.streaming and the GOTCHAS §Codex streaming bullet",
      )
    }

    // §9.5 usage asserts — the mapping already subtracted, so recover the raw
    // relation from the normalized fields: raw input = input + cache_read.
    const usage = result.usage as Record<string, number> | undefined
    if (!usage) {
      fail('usage', 'turn_result carried no usage')
    } else {
      if (usage.output_tokens! > 0) pass('usage', `nonzero output (${usage.output_tokens})`)
      else fail('usage', 'zero output tokens')
      if (usage.input_tokens! >= 0 && usage.cache_read_input_tokens! >= 0) {
        pass(
          'usage relation',
          `input(excl. cache)=${usage.input_tokens} cacheRead=${usage.cache_read_input_tokens} ` +
            'a negative input would have been clamped — see the next turn for the cache-heavy case',
        )
      }
    }

    const threadId = runner.sdkSessionId
    if (!threadId) throw new Error('no thread id after turn 1')
    runner.close()

    // Turn 2: resume continuity + the cache-heavy usage relation (open Q1).
    const resumed = makeRunner(cwd, {
      prompt: 'What exact string did I ask you to echo earlier? Reply with just the string.',
      resume: threadId,
    })
    await resumed.runner.start()
    const [turn2] = turnResults(resumed.events)
    if (turn2?.subtype === 'success' && turn2.result?.includes('codex-smoke-ok')) {
      pass('resume', 'turn 2 recalled turn 1 through `codex exec resume`')
    } else {
      fail('resume', `turn 2: ${turn2?.result ?? turn2?.errors?.join('; ') ?? 'no result'}`)
    }
    const u2 = turn2?.usage as Record<string, number> | undefined
    if (u2 && u2.input_tokens! >= 0) {
      // The §9.5 subtraction assumes OpenAI-convention input INCLUDES cached.
      // If that were wrong, a cache-heavy resume turn would clamp at 0 with a
      // large cache_read — flag the suspicious shape instead of proving it.
      if (u2.input_tokens === 0 && (u2.cache_read_input_tokens ?? 0) > 0) {
        fail(
          'usage relation (Q1)',
          `resume turn: input clamped to 0 with cacheRead=${u2.cache_read_input_tokens} — ` +
            'input_tokens may NOT include cached; re-check §9.5’s subtraction',
        )
      } else {
        pass(
          'usage relation (Q1)',
          `resume turn: input(excl. cache)=${u2.input_tokens} cacheRead=${u2.cache_read_input_tokens} — subtraction holds`,
        )
      }
    }
    resumed.runner.close()

    // Turn 3: interrupt kills cleanly (open Q3), and the thread survives it.
    const spinner = makeRunner(cwd, {
      prompt: 'Count from 1 to 500 out loud, one number per line, without using any tools.',
      resume: threadId,
    })
    const spinRun = spinner.runner.start()
    await new Promise((r) => setTimeout(r, 4000))
    await spinner.runner.interrupt()
    await spinRun
    const [spinResult] = turnResults(spinner.events)
    if (spinResult?.errors?.includes('interrupted')) {
      pass('interrupt', 'aborted turn landed as error_during_execution [interrupted]')
    } else {
      fail('interrupt', `unexpected result: ${JSON.stringify(spinResult?.errors ?? spinResult?.subtype)}`)
    }
    spinner.runner.close()

    const afterInterrupt = makeRunner(cwd, {
      prompt: 'Reply with the single word: alive',
      resume: threadId,
    })
    await afterInterrupt.runner.start()
    const [aliveResult] = turnResults(afterInterrupt.events)
    if (aliveResult?.subtype === 'success' && /alive/i.test(aliveResult.result ?? '')) {
      pass('post-interrupt resume (Q3)', 'the thread stayed resumable after a killed turn')
    } else {
      fail(
        'post-interrupt resume (Q3)',
        `resume after interrupt: ${aliveResult?.result ?? aliveResult?.errors?.join('; ') ?? 'nothing'} ` +
          '— CodexRunner may need a thread-poisoned fallback (PRD §13 Q3)',
      )
    }
    afterInterrupt.runner.close()

    // Turn 4: the read-only sandbox actually refuses a write (open Q2 /
    // permission-mode mapping). Fresh thread, default mode.
    const readonly = makeRunner(cwd, {
      prompt:
        'Create a file named smoke-write-test.txt containing "x" in the current directory. ' +
        'If you cannot, say why in one line.',
      permissionMode: 'default',
    })
    await readonly.runner.start()
    const wrote = existsSync(join(cwd, 'smoke-write-test.txt'))
    if (!wrote) pass('read-only sandbox', "'default' mode refused the write, as mapped")
    else fail('read-only sandbox', "'default' mode let a write through — §9.3's mapping is broken")
    readonly.runner.close()

    // Turn 5: an image attachment reaches the model as --image. The pixel is
    // RGBA(255,0,0,127) — decoded from these bytes, not assumed; the first
    // paid run (2026-08-05) caught an "expected blue" assertion that had never
    // executed. A model that never received the attachment cannot name it.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const vision = makeRunner(cwd, {})
    void vision.runner.start()
    vision.runner.sendMessage('In one word, what colour is this image?', [
      { id: 'smoke-img', name: 'pixel.png', mediaType: 'image/png', bytes: 70, data: png },
    ])
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (turnResults(vision.events).length > 0) {
          clearInterval(check)
          resolve()
        }
      }, 250)
    })
    const [visionResult] = turnResults(vision.events)
    if (visionResult?.subtype === 'success' && /red/i.test(visionResult.result ?? '')) {
      pass('image attachment', `the model saw the red pixel ("${visionResult.result?.trim()}")`)
    } else {
      fail(
        'image attachment',
        `answer: ${visionResult?.result ?? visionResult?.errors?.join('; ') ?? 'none'} (expected red)`,
      )
    }
    vision.runner.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`smoke:codex — @openai/codex-sdk against the real binary`)
await canaries()
if (!CANARY_ONLY) await paid()
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
