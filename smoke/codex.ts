/**
 * smoke:codex — everything a fake cannot validate about the Codex engine.
 *
 *   pnpm smoke:codex [model]        # full run — needs codex auth, costs plan/API usage
 *   pnpm smoke:codex --canary       # the free auth-drift canaries only (network, no tokens)
 *
 * Auth — ONE route (verified 2026-08-05 against 0.146.0 by driving the raw
 * app-server; the exec-era matrix does NOT carry over): `codex login` in YOUR
 * terminal (ChatGPT plan, or `codex login --with-api-key` to persist a key
 * into CODEX_HOME). The env keys are dead ends on this surface — CODEX_API_KEY
 * is read only by `codex exec` (retired), OPENAI_API_KEY by neither; the
 * app-server sends NO credential from either, and canaries 1–2 are the alarm
 * for the release where that changes.
 *
 * The canaries drive the REAL binary through the real `CodexRunner` +
 * `connectAppServer`, so a free run also exercises the spawn contract, the
 * initialize/initialized handshake, and thread/start — drift in any of those
 * fails a canary before it costs a token.
 *
 * The free canaries also pin the two APPROVAL gates (discovered by trial):
 * `initialize` accepting `capabilities.experimentalApi: true`, and
 * `thread/start` accepting the granular `approvalPolicy` object — WorkerDeck
 * has no non-experimental fallback, so losing either gate breaks approvals
 * outright. And `skills/list`'s shape, which is free for the same reason (a
 * local directory scan, no model call) and is hand-mirrored in
 * `engines/codex/types.ts` — an unmapped field there is a panel that silently
 * loses a column.
 *
 * The paid part is the drift alarm for the app-server JSON-RPC v2 vocabulary
 * (pre-1.0, regenerable from the binary — the schema promises drift): token
 * deltas actually arriving (the reason this transport exists), a real command
 * execution with its exit code, the usage-relation asserts on the summed
 * tokenUsage/updated stream, resume continuity, interrupt behavior +
 * post-interrupt resumability, the approval flow under 'default' mode (the
 * sandbox refusal surfacing as a real permission_requested, denied, with the
 * turn surviving), and a `localImage` attachment. Any change to CodexRunner's
 * spawn options, handshake, or event mapping requires a run.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CodexRunner, connectAppServer, resolveBundledCodexExecutable } from '@workerdeck/core'
import type { PermissionRequest, SessionEvent } from '@workerdeck/protocol'

const MODEL = process.argv.find((a) => !a.startsWith('-') && a.includes('gpt')) ?? 'gpt-5.6-luna'
const CANARY_ONLY = process.argv.includes('--canary')

const execFileP = promisify(execFile)
let failures = 0
const pass = (name: string, detail: string) => console.log(`  PASS  ${name} — ${detail}`)
const fail = (name: string, detail: string) => {
  failures += 1
  console.error(`  FAIL  ${name} — ${detail}`)
}

const codexBin = resolveBundledCodexExecutable()

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

function makeRunner(
  cwd: string,
  overrides: Record<string, unknown> = {},
): { runner: CodexRunner; events: SessionEvent[] } {
  if (!codexBin) throw new Error('bundled codex binary not resolvable — is @openai/codex installed?')
  const runner = new CodexRunner({
    cwd,
    model: MODEL,
    connectFn: (options) => connectAppServer({ executable: codexBin, ...options }),
    ...overrides,
  })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  return { runner, events }
}

const turnResults = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { type: 'turn_result' }> => e.type === 'turn_result')

/**
 * One throwaway app-server turn through the real runner; returns the terminal
 * failure message ('' = completed). Handshake/spawn failures surface here too,
 * as the turn's error — which is exactly what makes the canaries a drift alarm
 * for the spawn contract as well as the auth chain.
 */
async function probeTurn(env: Record<string, string>): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-smoke-probe-'))
  const { runner, events } = makeRunner(cwd, { prompt: 'say hi', model: undefined, env })
  const timeout = setTimeout(() => runner.close(), 90_000)
  try {
    await runner.start()
    const [result] = turnResults(events)
    if (!result) return 'no turn_result within 90s'
    return result.subtype === 'success' ? '' : (result.errors?.join('; ') ?? 'unknown failure')
  } finally {
    clearTimeout(timeout)
    runner.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function canaries(): Promise<void> {
  console.log('\n— free auth-drift canaries (fake keys, scratch CODEX_HOME, no tokens) —')

  // 1. OPENAI_API_KEY alone must still be a no-op ("Missing bearer" — no
  //    credential was sent). The day this fails with invalid_api_key instead,
  //    codex started honoring the var and the probe's hint is stale.
  const viaOpenai = await probeTurn(scratchEnv({ OPENAI_API_KEY: 'sk-smoke-fake' }))
  if (viaOpenai.includes('Missing bearer')) {
    pass('OPENAI_API_KEY ignored', 'app-server sent no credential (Missing bearer)')
  } else if (viaOpenai.toLowerCase().includes('invalid') && viaOpenai.includes('api')) {
    fail(
      'OPENAI_API_KEY ignored',
      `codex SENT the key (${viaOpenai.slice(0, 80)}…) — codex now honors OPENAI_API_KEY; ` +
        'update the availability probe and the GOTCHAS auth bullet',
    )
  } else {
    fail('OPENAI_API_KEY ignored', `unexpected failure shape: ${viaOpenai.slice(0, 120)}`)
  }

  // 2. CODEX_API_KEY must still be exec-only, i.e. a no-op for the app-server
  //    (established 2026-08-05: the exec surface DID send it as a bearer, this
  //    surface does not). The probe therefore trusts `login status` alone —
  //    the day this fails with invalid_api_key, app-server started honoring
  //    the env key and the probe under-claims: restore a presence rule.
  const viaCodexKey = await probeTurn(scratchEnv({ CODEX_API_KEY: 'sk-smoke-fake' }))
  if (viaCodexKey.includes('Missing bearer')) {
    pass('CODEX_API_KEY exec-only', 'app-server sent no credential (Missing bearer)')
  } else if (viaCodexKey.includes('invalid_api_key') || viaCodexKey.includes('Incorrect API key')) {
    fail(
      'CODEX_API_KEY exec-only',
      'app-server SENT the key — it now honors CODEX_API_KEY; the availability probe ' +
        'under-claims (add the presence rule back) and the GOTCHAS auth bullet is stale',
    )
  } else {
    fail('CODEX_API_KEY exec-only', `unexpected failure shape: ${viaCodexKey.slice(0, 120)}`)
  }

  // 3. `login status` still exit-codes its verdict on an empty home — what the
  //    availability probe's rule 3 reads (exit code + fixed line, nothing else).
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

  // 4+5. The two approval gates, discovered by trial and easy to lose in a
  //      release: `initialize` must accept `capabilities.experimentalApi:
  //      true`, and `thread/start` must accept the GRANULAR approvalPolicy
  //      object (the string vocabulary never asks — measured). Both are free:
  //      no turn, no tokens, no auth (thread/start is local; credentials are
  //      first consulted at turn/start). WorkerDeck runs ONE code path — there
  //      is no non-experimental fallback — so either gate failing here means
  //      approvals are broken until the runner is updated.
  if (!codexBin) {
    fail('experimentalApi gate', 'could not resolve the bundled codex binary')
  } else {
    const gateCwd = mkdtempSync(join(tmpdir(), 'codex-smoke-gates-'))
    const connection = connectAppServer({ executable: codexBin, env: scratchEnv() })
    try {
      await connection.request('initialize', {
        clientInfo: { name: 'workerdeck-smoke', title: 'WorkerDeck smoke', version: 'gates' },
        capabilities: { experimentalApi: true },
      })
      pass('experimentalApi gate', 'initialize accepted capabilities.experimentalApi: true')
      connection.notify('initialized')
      try {
        const started = (await connection.request('thread/start', {
          cwd: gateCwd,
          sandbox: 'read-only',
          approvalPolicy: {
            granular: {
              sandbox_approval: true,
              rules: true,
              mcp_elicitations: true,
              request_permissions: true,
              skill_approval: true,
            },
          },
        })) as { thread?: { id?: string } }
        if (typeof started?.thread?.id === 'string') {
          pass('granular approvalPolicy gate', 'thread/start accepted the granular object')
        } else {
          fail('granular approvalPolicy gate', 'thread/start answered without a thread id')
        }
      } catch (error) {
        fail(
          'granular approvalPolicy gate',
          `thread/start rejected the granular approvalPolicy: ${(error as Error).message}`,
        )
      }

      // 6. `skills/list` — the shape `engines/codex/types.ts` mirrors by hand.
      //    Free (a local directory scan, no model call) and worth pinning: an
      //    unmapped field here is a skills panel that silently loses a column,
      //    and `interface.defaultPrompt` in particular is the whole reason the
      //    composer can offer skills without pretending they are commands.
      //    Asserted structurally, never on *which* skills exist — this machine's
      //    CODEX_HOME is not the contract.
      try {
        const listed = (await connection.request('skills/list', {})) as {
          data?: Array<{
            cwd?: string
            skills?: Array<{ name?: unknown; enabled?: unknown; interface?: unknown }>
            errors?: unknown[]
          }>
        }
        if (!Array.isArray(listed?.data)) {
          fail('skills/list shape', 'result has no `data` array')
        } else {
          const entries = listed.data
          const skills = entries.flatMap((e) => e?.skills ?? [])
          const named = skills.filter((s) => typeof s?.name === 'string')
          const badEntry = entries.find((e) => e?.skills !== undefined && !Array.isArray(e.skills))
          if (badEntry) {
            fail('skills/list shape', 'an entry\'s `skills` is not an array')
          } else if (named.length !== skills.length) {
            fail('skills/list shape', 'a skill came back without a string `name`')
          } else {
            // `enabled` may be absent (the runner defaults it true); `interface`
            // may be absent; neither may be a different *kind* of thing.
            const wrongEnabled = skills.find(
              (s) => s.enabled !== undefined && typeof s.enabled !== 'boolean',
            )
            const wrongInterface = skills.find(
              (s) => s.interface !== undefined && (typeof s.interface !== 'object' || s.interface === null),
            )
            if (wrongEnabled) fail('skills/list shape', '`enabled` is not a boolean')
            else if (wrongInterface) fail('skills/list shape', '`interface` is not an object')
            else {
              const withPrompt = skills.filter(
                (s) => typeof (s.interface as { defaultPrompt?: unknown })?.defaultPrompt === 'string',
              ).length
              pass(
                'skills/list shape',
                `${skills.length} skill(s) across ${entries.length} cwd(s), ` +
                  `${withPrompt} carrying interface.defaultPrompt`,
              )
            }
          }
        }
      } catch (error) {
        fail(
          'skills/list shape',
          `skills/list rejected: ${(error as Error).message} — the skills panel and the ` +
            'composer\'s skill completion are both dead until the runner is updated',
        )
      }
    } catch (error) {
      fail(
        'experimentalApi gate',
        `initialize rejected: ${(error as Error).message} — the runner has NO non-experimental ` +
          'fallback; codex approvals are broken until this is resolved',
      )
    } finally {
      connection.close()
      rmSync(gateCwd, { recursive: true, force: true })
    }
  }

  await threadItemUnionCanary()
}

/**
 * The `ThreadItem` union, pinned.
 *
 * This is the drift alarm the canaries were missing, and its absence has already
 * cost us twice: `imageGeneration` went unnoticed until someone saw a blank row,
 * and `collabAgentToolCall` / `subAgentActivity` — codex's entire multi-agent
 * surface — have been arriving as invisible `sdk_event`s since 0.146.0 without
 * anyone knowing they existed. An unmapped item is not merely unstyled, it is
 * gone from the transcript (`docs/GOTCHAS.md` §codex), so "we render everything
 * codex can say" is a claim only a pin can keep honest.
 *
 * Free, and free for a good reason: `generate-json-schema` is a local dump out of
 * the binary we already ship — no network, no auth, no tokens — so this belongs
 * in the canary set rather than the paid run.
 *
 * **A new variant is a FAIL and an unmapped one is a warning**, which is the
 * honest split: the first means the protocol moved under us, the second is a
 * standing decision recorded below. Mapping every variant is not the goal —
 * knowing about each one is.
 */
async function threadItemUnionCanary(): Promise<void> {
  if (!codexBin) return
  // Every variant present in 0.146.0. Adding to this list is the deliberate act
  // of saying "we have looked at this one".
  const KNOWN = new Set([
    'userMessage', 'hookPrompt', 'agentMessage', 'plan', 'reasoning',
    'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
    'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView',
    'sleep', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode',
    'contextCompaction',
  ])
  // What `AppServerItem` in `engines/codex/types.ts` actually models. Everything
  // else falls through `#handleItemCompleted` into an `sdk_event` and draws
  // nothing. The multi-agent pair is mapped as of the sub-agent attribution
  // work (`engines/codex/subagents.ts`): `subAgentActivity` is the spawn
  // signal the whole design keys off, `collabAgentToolCall` a plain tool card.
  const MAPPED = new Set([
    'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall',
    'webSearch', 'imageGeneration', 'imageView', 'userMessage',
    'subAgentActivity', 'collabAgentToolCall',
  ])

  const out = mkdtempSync(join(tmpdir(), 'wd-codex-schema-'))
  try {
    await execFileP(codexBin, ['app-server', 'generate-json-schema', '--out', out], {
      timeout: 60_000,
    })
    const schema = JSON.parse(
      readFileSync(join(out, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
    ) as { definitions?: Record<string, unknown>; $defs?: Record<string, unknown> }
    const item = (schema.definitions ?? schema.$defs ?? {})['ThreadItem'] as
      | { oneOf?: { properties?: { type?: { const?: string; enum?: string[] } } }[] }
      | undefined
    const variants = (item?.oneOf ?? [])
      .map((arm) => arm.properties?.type?.const ?? arm.properties?.type?.enum?.[0])
      .filter((name): name is string => typeof name === 'string')

    if (variants.length === 0) {
      fail('ThreadItem union', 'could not read the union out of the v2 schema — shape changed')
      return
    }
    const added = variants.filter((name) => !KNOWN.has(name))
    if (added.length > 0) {
      fail(
        'ThreadItem union',
        `NEW variant(s) since 0.146.0: ${added.join(', ')} — each is currently invisible in the ` +
          'transcript (an sdk_event that draws nothing). Map it in `engines/codex/types.ts` + ' +
          "`#itemCompleted`, or add it to this canary's KNOWN set to say it was considered",
      )
      return
    }
    const unmapped = variants.filter((name) => !MAPPED.has(name))
    pass(
      'ThreadItem union',
      `${variants.length} variants, none new` +
        (unmapped.length > 0 ? ` · ${unmapped.length} unmapped: ${unmapped.join(', ')}` : ''),
    )
  } catch (error) {
    fail('ThreadItem union', `generate-json-schema failed: ${(error as Error).message}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/** The auth this run will use, mirroring the availability probe's chain:
 * `login status` alone — the env keys are not read by the app-server. */
async function detectAuth(): Promise<string | null> {
  if (!codexBin) return null
  try {
    await execFileP(codexBin, ['login', 'status'], { timeout: 15_000 })
    return 'codex login'
  } catch {
    return null
  }
}

async function paid(): Promise<void> {
  const auth = await detectAuth()
  if (!auth) {
    fail(
      'auth',
      'no codex credentials: run `codex login` (or `codex login --with-api-key`) in your own ' +
        'terminal. The env keys are not read by the app-server surface.',
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

    // Token streaming — the reason the app-server transport is THE transport.
    // exec's JSONL never carried a partial message (the old smoke asserted the
    // absence); the positive counterpart is now load-bearing: text deltas must
    // arrive before the completed item, in more than one piece, and agree with
    // the final answer the completed item supersedes them with.
    const textDeltas = events
      .filter((e): e is Extract<SessionEvent, { type: 'stream_delta' }> => e.type === 'stream_delta')
      .map((e) => (e.event as { delta?: { type?: string; text?: string } }).delta)
      .filter((d) => d?.type === 'text_delta')
      .map((d) => d!.text ?? '')
    if (textDeltas.length >= 2) {
      pass('token streaming', `${textDeltas.length} text deltas for one answer`)
    } else if (textDeltas.length === 1) {
      fail('token streaming', 'the whole answer arrived as ONE delta — check item/agentMessage/delta')
    } else {
      fail(
        'token streaming',
        'no stream_delta at all — item/agentMessage/delta never fired; the capability record ' +
          "(streaming: 'token') is now a lie",
      )
    }
    // Agreement is asserted PER MESSAGE, not across the turn — a turn with a
    // tool call emits several agent messages (codex narrates "I'm running the
    // requested shell command…" before the echo, then answers after it), so
    // concatenating every delta and comparing to the last message's text
    // compares a preamble+answer against an answer and fails by construction.
    // The invariant that is actually true, and the one both reducers implement
    // ("the full message supersedes any in-flight streamed text"): the deltas
    // accumulated since the previous completed message reconstruct the next
    // one. That is what a client renders, so that is what is checked.
    let pending = ''
    let matched = 0
    const mismatches: string[] = []
    for (const event of events) {
      if (event.type === 'stream_delta') {
        const delta = (event.event as { delta?: { type?: string; text?: string } }).delta
        if (delta?.type === 'text_delta') pending += delta.text ?? ''
        continue
      }
      if (event.type !== 'assistant_message' || !Array.isArray(event.message.content)) continue
      const text = event.message.content.find((b) => b.type === 'text') as { text?: string } | undefined
      if (text === undefined) continue
      if (pending === '') continue // a message that was never streamed — nothing to agree with
      if (text.text === pending) matched += 1
      else mismatches.push(`streamed ${JSON.stringify(pending.slice(0, 30))} vs completed ${JSON.stringify((text.text ?? '').slice(0, 30))}`)
      pending = ''
    }
    if (matched > 0 && mismatches.length === 0) {
      pass('delta/final agreement', `${matched} message(s) reconstructed exactly from their deltas`)
    } else if (mismatches.length > 0) {
      fail('delta/final agreement', mismatches[0]!)
    } else {
      fail('delta/final agreement', 'no completed message was preceded by deltas')
    }

    // Usage asserts — `turn/completed` carries no usage on this surface; the
    // runner sums `thread/tokenUsage/updated.last` across the turn and applies
    // the Anthropic-convention subtraction. Recover the raw relation from the
    // normalized fields: raw input = input + cache_read.
    const usage = result.usage as Record<string, number> | undefined
    if (!usage) {
      fail('usage', 'turn_result carried no usage — tokenUsage/updated never arrived')
    } else {
      if (usage.output_tokens! > 0) pass('usage', `nonzero output (${usage.output_tokens})`)
      else fail('usage', 'zero output tokens')
      if (usage.input_tokens! >= 0 && usage.cache_read_input_tokens! >= 0) {
        pass(
          'usage relation',
          `input(excl. cache)=${usage.input_tokens} cacheRead=${usage.cache_read_input_tokens} ` +
            '— a negative input would have been clamped; see the resume turn for the cache-heavy case',
        )
      }
    }

    const threadId = runner.sdkSessionId
    if (!threadId) throw new Error('no thread id after turn 1')
    runner.close()

    // Turn 2: resume continuity (a fresh child + thread/resume) + the
    // cache-heavy usage relation.
    const resumed = makeRunner(cwd, {
      prompt: 'What exact string did I ask you to echo earlier? Reply with just the string.',
      resume: threadId,
    })
    await resumed.runner.start()
    const [turn2] = turnResults(resumed.events)
    if (turn2?.subtype === 'success' && turn2.result?.includes('codex-smoke-ok')) {
      pass('resume', 'turn 2 recalled turn 1 through thread/resume')
    } else {
      fail('resume', `turn 2: ${turn2?.result ?? turn2?.errors?.join('; ') ?? 'no result'}`)
    }
    const u2 = turn2?.usage as Record<string, number> | undefined
    if (u2 && u2.input_tokens! >= 0) {
      // The subtraction assumes OpenAI-convention inputTokens INCLUDES cached.
      // If that were wrong, a cache-heavy resume turn would clamp at 0 with a
      // large cache_read — flag the suspicious shape instead of proving it.
      if (u2.input_tokens === 0 && (u2.cache_read_input_tokens ?? 0) > 0) {
        fail(
          'usage relation (cache-heavy)',
          `resume turn: input clamped to 0 with cacheRead=${u2.cache_read_input_tokens} — ` +
            'inputTokens may NOT include cached; re-check the subtraction in #finishTurn',
        )
      } else {
        pass(
          'usage relation (cache-heavy)',
          `resume turn: input(excl. cache)=${u2.input_tokens} cacheRead=${u2.cache_read_input_tokens} — subtraction holds`,
        )
      }
    }
    resumed.runner.close()

    // Turn 3: interrupt lands cleanly (turn/interrupt → status 'interrupted'),
    // and the thread survives it.
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
      pass('post-interrupt resume', 'the thread stayed resumable after an interrupted turn')
    } else {
      fail(
        'post-interrupt resume',
        `resume after interrupt: ${aliveResult?.result ?? aliveResult?.errors?.join('; ') ?? 'nothing'}`,
      )
    }
    afterInterrupt.runner.close()

    // Turn 4: the approval flow, end to end, in 'default' mode (read-only
    // sandbox + granular ask). The write attempt is refused by the sandbox and
    // must now surface as a real permission_requested — codex's escalation
    // ("command failed; retry without sandbox?") — which the smoke DENIES, so
    // the file must still not exist and the turn must complete anyway. This is
    // the check the scripted peer cannot make: that the real binary actually
    // asks under the granular policy, and that a decline lands cleanly.
    const readonly = makeRunner(cwd, {
      prompt:
        'Create a file named smoke-write-test.txt containing "x" in the current directory ' +
        'using a shell command. If you cannot, say why in one line.',
      permissionMode: 'default',
    })
    const approvals: PermissionRequest[] = []
    readonly.runner.subscribe((event) => {
      if (event.type === 'permission_requested') {
        approvals.push(event.request)
        // Deny WITHOUT interrupt: the turn must survive a "no".
        readonly.runner.resolvePermission(event.request.id, {
          behavior: 'deny',
          message: 'smoke: keep the sandbox',
        })
      }
    })
    const readonlyTimeout = setTimeout(() => readonly.runner.close(), 120_000)
    await readonly.runner.start()
    clearTimeout(readonlyTimeout)
    if (approvals.length > 0) {
      pass(
        'sandbox escalation asks',
        `permission_requested (${approvals[0]!.toolName}): "${approvals[0]!.title ?? ''}"`,
      )
    } else {
      fail(
        'sandbox escalation asks',
        'no permission_requested — the granular ask policy did not ask; the sandbox refusal ' +
          'was silent (the pre-approvals behavior)',
      )
    }
    const wrote = existsSync(join(cwd, 'smoke-write-test.txt'))
    if (!wrote) pass('denied escalation stays denied', 'the write never landed')
    else fail('denied escalation stays denied', 'the file exists — a decline still let the write through')
    const [readonlyResult] = turnResults(readonly.events)
    if (readonlyResult?.subtype === 'success') {
      pass('decline keeps the turn alive', 'the turn completed after the deny')
    } else {
      fail(
        'decline keeps the turn alive',
        `turn ended ${readonlyResult?.subtype ?? 'not at all'}: ${readonlyResult?.errors?.join('; ') ?? ''}`,
      )
    }
    readonly.runner.close()

    // Turn 5: an image attachment reaches the model as `localImage` — the one
    // input shape no unit test can prove the binary accepts. The pixel is
    // RGBA(255,0,0,127) — decoded from these bytes, not assumed; the first
    // exec-era paid run (2026-08-05) caught an "expected blue" assertion that
    // had never executed. A model that never received the attachment cannot
    // name it.
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

console.log('smoke:codex — CodexRunner over `codex app-server` against the real binary')
await canaries()
if (!CANARY_ONLY) await paid()
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
