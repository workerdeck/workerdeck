// pnpm smoke:restart [claude|codex] [noprofile|swept|clear|all]   — costs two short turns per engine.
//
// `packages/server/test/dormant.test.ts` drives a fake engine, so it can show the record survives and the routes
// behave, and cannot show that a real claude/codex resume works — which is the whole feature.
//
// It spawns its OWN gateway on its own port with its own state dir and never touches an instance already running:
// the machine that develops this usually has one hosting live sessions, and a ctrl-c on that is indistinguishable
// from the test until afterwards.
//
// What a green run proves, in order: a real session answers a turn; the gateway dies (SIGINT) and comes back; the
// row still lists and reads idle, not running and not gone; the attach replays the pre-restart history; and a second
// turn recalls a word from the first. That last one is the only check that can tell a resumed thread apart from a
// fresh one that merely inherited the id, which is why the word is asked for rather than assumed.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, unlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ServerFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'

const [engineArg = 'claude', ...extras] = process.argv.slice(2)
const engine = engineArg === 'codex' ? 'codex' : 'claude'
function wants(name: string) {
  return extras.includes(name) || extras.includes('all')
}

// A word the model cannot produce by chance, so "it recalled the thread" is not confusable with "it answered well".
const WORD = 'ORRERY'
const PORT = 8791
const base = `http://127.0.0.1:${PORT}/v1`

const root = mkdtempSync(join(tmpdir(), 'wd-restart-'))
const stateDir = join(root, 'state')
const workDir = join(root, 'work')
const configPath = join(root, 'gateway.config.mjs')

mkdirSync(workDir, { recursive: true })

let pass = 0
let fail = 0
function ok(what: string, detail = '') {
  pass++
  console.log(`  [32m✓[0m ${what}${detail ? ` [2m${detail}[0m` : ''}`)
}
function bad(what: string, detail = '') {
  fail++
  console.log(`  [31m✗[0m ${what}${detail ? ` [2m${detail}[0m` : ''}`)
}
function step(what: string) {
  return console.log(`\n[1m${what}[0m`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  }
  return (await res.json()) as T
}

// Written per run, so the "deleted profile" variant is a second file rather than an edit to something checked in.
function writeConfig(profiles: string[]): void {
  const decls = profiles
    .map((name) =>
      name === 'codex' ? `{ name: 'codex', engine: 'codex' }` : `{ name: 'claude', configDir: \`\${process.env.HOME}/.claude\` }`,
    )
    .join(',\n    ')
  writeFileSync(
    configPath,
    `export default {\n  profiles: [\n    ${decls},\n  ],\n` +
      `  allowedCwdRoots: [${JSON.stringify(root)}],\n` +
      `  parking: { parkDelayMs: 60_000 },\n}\n`,
  )
}

let child: ChildProcess | undefined

async function startGateway(): Promise<void> {
  child = spawn(
    process.execPath,
    [
      '--conditions=@workerdeck/source',
      '--import',
      '@swc-node/register/esm-register',
      'packages/cli/src/cli.ts',
      '--config',
      configPath,
      '--port',
      String(PORT),
      '--host',
      '127.0.0.1',
      '--state-dir',
      stateDir,
      '--no-web',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr?.on('data', (d) => {
    const line = String(d).trim()
    if (line) {
      console.log(`    [2m[gateway] ${line}[0m`)
    }
  })
  const deadline = Date.now() + 30_000
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('gateway did not come up within 30s')
    }
    try {
      const res = await fetch(`${base}/sessions`)
      if (res.ok) {
        return
      }
    } catch {
      // not listening yet
    }
    await sleep(200)
  }
}

// Waits for the process to actually be gone, not merely signalled: returning early races the next `listen` onto a
// port still held.
async function stopGateway(): Promise<void> {
  if (!child) {
    return
  }
  const dead = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.kill('SIGINT')
  await Promise.race([dead, sleep(10_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  child = undefined
  await sleep(500)
}

type AttachResult = { text: string; events: SessionEvent[]; replayed: number; replayingFrom?: number }

async function attach(id: string, prompt?: string, timeoutMs = 120_000): Promise<AttachResult> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  const events: SessionEvent[] = []
  let replayed = 0
  let replayingFrom: number | undefined
  let live = false
  let text = ''
  // The listener goes on BEFORE the open await: the gateway flushes the replay the moment the socket is up, and a
  // listener attached one tick later misses the whole burst — which reads exactly like "nothing was replayed".
  //
  // The attach backlog carries no marker of its own: history and live both arrive as `{ type: 'event', event }`, so
  // "replayed" here counts events seen before this attach sent anything.
  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    // Swallowed unless asked for: two variants *expect* the attach to fail.
    ws.on('error', (e) => {
      if (process.env.WD_SMOKE_DEBUG) {
        console.log(`    \u001b[2m— ws error: ${(e as Error).message}\u001b[0m`)
      }
    })
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      if (frame.type === 'attached') {
        replayingFrom = frame.replayingFrom
        return
      }
      if (frame.type !== 'event') {
        return
      }
      events.push(frame.event)
      if (!live) {
        replayed++
      }
      if (live && frame.event.type === 'assistant_message') {
        const content = frame.event.message.content
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text') {
              text += part.text
            }
          }
        }
      }
      if (live && frame.event.type === 'turn_result') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  if (prompt) {
    // Let the replay drain first, so a `turn_result` from the history cannot be mistaken for this turn's.
    await sleep(1_500)
    live = true
    ws.send(JSON.stringify({ type: 'user_message', text: prompt }))
    await settled
  } else {
    await sleep(2_500)
  }
  ws.close()
  if (process.env.WD_SMOKE_DEBUG) {
    console.log(`    [2m[debug] ${events.length} events, ${replayed} replay, text=${JSON.stringify(text.slice(0, 60))}[0m`)
    console.log(`    [2m[debug] types: ${[...new Set(events.map((e) => e.type))].join(', ')}[0m`)
  }
  return { text: text.trim(), events, replayed, replayingFrom }
}

// Returns whether the record ever appeared, so the caller can say so rather than guess.
async function waitForRecord(id: string, timeoutMs: number): Promise<boolean> {
  const dir = join(stateDir, 'parked')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = existsSync(dir) ? readdirSync(dir) : []
    if (names.some((n) => n.startsWith(id) && n.endsWith('.json'))) {
      console.log(`  \u001b[2m— dormant record on disk\u001b[0m`)
      return true
    }
    if (Date.now() > deadline) {
      console.log(`  \u001b[33m!\u001b[0m no dormant record after ${timeoutMs / 1000}s — expect the row to vanish`)
      return false
    }
    await sleep(250)
  }
}

async function main(): Promise<void> {
  console.log(`\n[1mThe restart, end to end[0m — engine: ${engine}, port ${PORT}`)
  console.log(`[2mstate ${stateDir}[0m`)

  writeConfig([engine])
  step('1. A real session, and a turn it answers')
  await startGateway()

  const created = await api<{ session: SessionInfo }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: workDir, profile: engine }),
  })
  const id = created.session.id
  ok('session created', id)

  const first = await attach(id, `Remember the word ${WORD}. Reply with just: ok`)
  if (first.text) {
    ok('the engine answered a turn', JSON.stringify(first.text.slice(0, 40)))
  } else {
    bad('the engine answered a turn', 'no assistant text — is the profile logged in?')
  }

  step('2. ctrl-c, and back')
  // The dormant write is asynchronous and not instant — claude also writes on `system_init`, codex emits none so its
  // first record rides the post-turn `status_changed`. Killing inside that window loses the session outright.
  await waitForRecord(id, 15_000)
  await stopGateway()
  ok('gateway stopped (SIGINT)')
  await startGateway()
  ok('gateway restarted on the same state dir')

  step('3. The row survives, and reads idle')
  const listed = await api<{ sessions: SessionInfo[] }>('/sessions')
  const row = listed.sessions.find((s) => s.id === id)
  if (!row) {
    bad('the session is still listed', 'the row is gone entirely')
  } else {
    ok('the session is still listed')
    if (row.status === 'idle') {
      ok('it reads idle', row.status)
    } else {
      bad('it reads idle', `reads ${row.status}`)
    }
  }

  step('4. The attach replays, and the thread continues')
  const second = await attach(id, `What word did I ask you to remember? Reply with just that word.`)
  // The history itself, not a flag: a rebuilt session that merely inherited the id attaches cleanly and replays
  // nothing, and only looking for the pre-restart prompt can see the difference.
  const priorPrompt = second.events.some(
    (e) => e.type === 'user_message' && JSON.stringify(e.message.content).includes('Remember the word'),
  )
  if (priorPrompt) {
    ok('history arrived as replay', `${second.replayed} events before this turn`)
  } else {
    bad('history arrived as replay', 'the pre-restart prompt was not replayed')
  }

  if (second.text.toUpperCase().includes(WORD)) {
    ok('the engine resumed the SAME thread', JSON.stringify(second.text.slice(0, 40)))
  } else {
    bad('the engine resumed the SAME thread', `expected ${WORD}, got ${JSON.stringify(second.text.slice(0, 60))}`)
  }

  // Order matters: `clear` needs a real, current dormant record and both destructive variants below leave it
  // otherwise, and a swept store leaves the session unusable, so `noprofile` has to precede `swept`.
  if (wants('clear')) {
    await clearNoChild(id)
  }
  if (wants('noprofile')) {
    await deletedProfile(id)
  }
  if (wants('swept')) {
    await sweptStore(id)
  }

  await stopGateway()
}

// Reports rather than asserts, because the predicted behaviour is not what happens (`docs/GOTCHAS.md` §Claude engine).
// Claude only: the store is a slug of the cwd, and the cwd is a temp dir this run created.
async function sweptStore(id: string): Promise<void> {
  step('7. A swept engine store')
  if (engine !== 'claude') {
    console.log('  [2m— skipped: only wired for claude[0m')
    return
  }
  await stopGateway()
  // The CLI slugs the RESOLVED path; on macOS `/var/folders/…` is a symlink, so slugging the unresolved path looks
  // right and finds nothing.
  const slug = realpathSync(workDir).replace(/[/.]/g, '-')
  const dir = join(process.env.HOME ?? '', '.claude', 'projects', slug)
  if (!existsSync(dir)) {
    bad('found the engine store to sweep', `no ${dir}`)
    return
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  for (const f of files) {
    unlinkSync(join(dir, f))
  }
  ok('swept the engine store', `${files.length} transcript(s) under ${slug}`)

  await startGateway()
  const listed = await api<{ sessions: SessionInfo[] }>('/sessions')
  if (listed.sessions.some((s) => s.id === id)) {
    ok('the record deliberately stays')
  } else {
    bad('the record deliberately stays', 'the row removed itself')
  }

  // The gateway's event log lives in its own record, so the transcript replays either way and only a turn can say
  // whether the engine thread survived.
  const after = await attach(id, `What word did I ask you to remember? Reply with just that word.`)
  const replayedHistory = after.events.some(
    (e) => e.type === 'user_message' && JSON.stringify(e.message.content).includes('Remember the word'),
  )
  console.log(`  [2m— attach succeeded; history replayed: ${replayedHistory}[0m`)
  console.log(`  [2m— the engine's answer: ${JSON.stringify(after.text.slice(0, 60))}[0m`)
  if (after.text.toUpperCase().includes(WORD)) {
    console.log(`  [33m![0m the engine still recalled the word — the CLI rebuilt the thread from somewhere`)
  } else {
    ok('the engine thread is gone (the word is not recalled)')
  }
  console.log(
    `  [2m— a swept store degrades to: row listed, attach OK, transcript EMPTY,` +
      ` turn silently unanswered. Quieter than a 404, and worse.[0m`,
  )
}

// The one clear path with no eager `thread/start` to save it: with the child dead the engine session id is simply
// dropped, so the record still naming the cleared conversation has to be deleted. Asserts on the record and the
// restart, not a turn, and costs no model tokens.
async function clearNoChild(id: string): Promise<void> {
  step('5. A clear with no live child, across a restart')
  if (engine !== 'codex') {
    console.log(
      '  \u001b[2m— skipped: only codex can be cleared with its child dead ' +
        "(claude's reset comes back from the CLI, which needs one)\u001b[0m",
    )
    return
  }
  const recordPath = () => {
    const dir = join(stateDir, 'parked')
    const names = existsSync(dir) ? readdirSync(dir) : []
    const name = names.find((n) => n.startsWith(id) && n.endsWith('.json'))
    return name ? join(dir, name) : undefined
  }
  if (!recordPath()) {
    bad('a dormant record to invalidate', 'none on disk — nothing for the clear to get wrong')
    return
  }
  ok('a dormant record exists, naming the conversation about to be cleared')

  // Matched by parent pid, never `pgrep -f codex`: that would also match whatever the operator is running in their
  // own terminal, and this smoke must never touch a session it did not create.
  const kids = await new Promise<string>((resolve) => {
    const ps = spawn('pgrep', ['-P', String(child?.pid ?? 0)], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    ps.stdout.on('data', (d) => (out += String(d)))
    ps.on('close', () => resolve(out))
  })
  const pids = kids
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const pid of pids) {
    process.kill(Number(pid), 'SIGKILL')
  }
  if (pids.length > 0) {
    ok('the codex child killed', `pid ${pids.join(', ')}`)
  } else {
    bad('the codex child killed', 'the gateway had no child process to kill')
  }
  await sleep(1_000)

  const reset = await clearOverWs(id)
  if (reset) {
    ok('the clear landed with no child', 'conversation_reset emitted')
  } else {
    bad('the clear landed with no child', 'no conversation_reset within 20s')
  }

  // Give the (asynchronous, queued) store delete a moment to land.
  await sleep(1_500)
  if (!recordPath()) {
    ok('the stale dormant record is gone', 'it named the cleared conversation')
  } else {
    bad('the stale dormant record is gone', 'it survived, still naming the cleared thread')
  }

  await stopGateway()
  await startGateway()
  const listed = await api<{ sessions: SessionInfo[] }>('/sessions')
  const row = listed.sessions.find((s) => s.id === id)
  if (!row) {
    ok('the cleared session is NOT resurrected', 'the row is gone — for codex the dormant record is the way back, and the clear removed it')
    return
  }
  console.log(`  \u001b[2m— the row came back (status ${row.status}); checking it came back empty\u001b[0m`)
  const after = await attach(id, undefined, 8_000)
  const priorPrompt = after.events.some((e) => e.type === 'user_message' && JSON.stringify(e.message.content).includes('Remember the word'))
  if (priorPrompt) {
    bad('the cleared session is NOT resurrected', 'the pre-clear conversation replayed')
  } else {
    ok('the cleared session is NOT resurrected', 'it came back with none of the cleared history')
  }
}

// Not `attach()`: a clear produces no `turn_result`, so that helper would sit on its timeout. The typed `/clear`
// rather than the `clear_context` command because both are the same call in the runner.
async function clearOverWs(id: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  let sawReset = false
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20_000)
    ws.on('error', () => resolve())
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      if (frame.type !== 'event' || frame.event.type !== 'conversation_reset') {
        return
      }
      sawReset = true
      clearTimeout(timer)
      resolve()
    })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await sleep(1_500) // let the replay drain
  ws.send(JSON.stringify({ type: 'user_message', text: '/clear' }))
  await done
  ws.close()
  return sawReset
}

// `buildRunner` throws `unknown profile`, the row stays and the attach fails. No model tokens.
async function deletedProfile(id: string): Promise<void> {
  step('6. A profile deleted between restarts')
  await stopGateway()
  writeConfig([engine === 'claude' ? 'codex' : 'claude'])
  ok(`config rewritten without the '${engine}' profile`)
  await startGateway()

  const listed = await api<{ sessions: SessionInfo[] }>('/sessions')
  if (listed.sessions.some((s) => s.id === id)) {
    ok('the row stays')
  } else {
    bad('the row stays', 'the row vanished')
  }

  try {
    await attach(id, undefined, 8_000)
    bad('the attach fails with unknown profile', 'it attached anyway')
  } catch {
    ok('the attach fails, as it must')
  }
  writeConfig([engine])
}

main()
  .catch((error) => {
    fail++
    console.error(`\n[31mfatal[0m ${(error as Error).message}`)
  })
  .finally(async () => {
    await stopGateway()
    rmSync(root, { recursive: true, force: true })
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail === 0 ? 0 : 1)
  })
