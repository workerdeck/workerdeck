// pnpm smoke:shell-propose [claude|codex|all]   - costs a few short turns per engine.
//
// `shell_propose` against real engines: the card must come from the tool itself in every mode, bypass and claude's auto
// included, so no classifier or mode can block or skip it. Spawns its OWN gateway with `--shell` only (no write flag),
// like smoke:shell-write, and never touches a running instance.
//
// Per engine: (1) in bypassPermissions (and auto on claude) the proposal cards, the smoke edits the command, and the
// agent reports the edited output and exit code. (2) a secret proposal: the smoke types a value into stdin, the command
// counts its bytes, and the value appears in no event of the session. (3) a declined proposal starts no shell.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { PermissionMode, PermissionRequest, ServerFrame, SessionInfo, ShellInfo } from '@workerdeck/protocol'
import { conversationOf, generationHeaders } from './lib/generation.ts'
import { fail, finish, note, ok, step } from './lib/report.ts'

type Engine = 'claude' | 'codex'

type Decision = { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }

type Turn = { text: string; cards: PermissionRequest[]; policy: string[]; raw: string; done: boolean }

const arg = process.argv[2] ?? 'all'
const engines: readonly Engine[] = arg === 'all' ? ['claude', 'codex'] : [arg === 'codex' ? 'codex' : 'claude']

const PORT = 8793
const base = `http://127.0.0.1:${PORT}/v1`
const SECRET = 'smoke-secret-0123456789'

const root = mkdtempSync(join(tmpdir(), 'wd-shell-propose-'))
const stateDir = join(root, 'state')
const workDir = join(root, 'work')
const configPath = join(root, 'gateway.config.mjs')
mkdirSync(workDir, { recursive: true })

let child: ChildProcess | undefined

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const stamp = await generationHeaders(base, path, init?.method)
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...stamp, ...init?.headers } })
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

async function startGateway(): Promise<void> {
  writeFileSync(
    configPath,
    `export default {\n  profiles: [\n    { name: 'claude', configDir: \`\${process.env.HOME}/.claude\` },\n` +
      `    { name: 'codex', engine: 'codex' },\n  ],\n  allowedCwdRoots: [${JSON.stringify(root)}],\n}\n`,
  )
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
      '--shell',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKERDECK_AUTH_KEY: undefined } },
  )
  child.stderr?.on('data', (d) => {
    const text = String(d).trim()
    if (text && process.env.WD_SMOKE_DEBUG) {
      console.log(`    \u001b[2m[gateway] ${text}\u001b[0m`)
    }
  })
  const deadline = Date.now() + 120_000
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('gateway did not come up within 120s')
    }
    try {
      if ((await fetch(`${base}/sessions`)).ok) {
        return
      }
    } catch {}
    await sleep(200)
  }
}

async function stopGateway(): Promise<void> {
  if (!child) {
    return
  }
  const dead = new Promise<void>((r) => child!.once('exit', () => r()))
  child.kill('SIGINT')
  await Promise.race([dead, sleep(10_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  child = undefined
}

function bare(name: string): string {
  return name.replace(/^mcp__workerdeck__/, '')
}

async function create(engine: Engine, mode: PermissionMode): Promise<string> {
  const created = await api<{ session: SessionInfo }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: workDir, profile: engine, permissionMode: mode, ...(engine === 'claude' ? { model: 'sonnet' } : {}) }),
  })
  return created.session.id
}

async function shells(id: string): Promise<ShellInfo[]> {
  return (await api<{ shells: ShellInfo[] }>(`/sessions/${id}/shells`)).shells
}

async function turn(id: string, prompt: string, decide: (request: PermissionRequest) => Decision): Promise<Turn> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  const conversation = conversationOf(ws)
  let generation = 0
  let live = false
  const result: Turn = { text: '', cards: [], policy: [], raw: '', done: false }
  const settled = new Promise<void>((resolveTurn) => {
    const timer = setTimeout(resolveTurn, 240_000)
    ws.on('message', (data) => {
      result.raw += String(data)
      const frame = JSON.parse(String(data)) as ServerFrame
      if (frame.type !== 'event' || !live) {
        return
      }
      const event = frame.event
      if (event.type === 'permission_requested') {
        if (event.byPolicy) {
          result.policy.push(bare(event.request.toolName))
          return
        }
        result.cards.push(event.request)
        const decision = decide(event.request)
        ws.send(
          JSON.stringify({
            type: 'permission_decision',
            requestId: event.request.id,
            generation,
            ...decision,
            ...(decision.behavior === 'deny' ? { message: 'declined by the smoke' } : {}),
          }),
        )
        return
      }
      if (event.type === 'assistant_message' && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if (part.type === 'text') {
            result.text += part.text
          }
        }
      }
      if (event.type === 'turn_result') {
        result.done = true
        clearTimeout(timer)
        resolveTurn()
      }
    })
  })
  await new Promise<void>((r, j) => {
    ws.once('open', () => r())
    ws.once('error', j)
  })
  generation = await conversation
  await sleep(1_500)
  live = true
  ws.send(JSON.stringify({ type: 'user_message', text: prompt, generation }))
  await settled
  ws.close()
  if (process.env.WD_SMOKE_DEBUG) {
    note(`cards ${result.cards.map((c) => bare(c.toolName)).join(', ') || 'none'}; text ${JSON.stringify(result.text.slice(0, 200))}`)
  }
  return result
}

async function editedInMode(engine: Engine, mode: PermissionMode): Promise<void> {
  step(`${engine}: ${mode}, the proposal still cards and runs the edited command`)
  const id = await create(engine, mode)
  note(`session ${id}`)
  const run = await turn(
    id,
    'This is an automated test of shell_propose. Do not use Bash or any other command tool. Call shell_propose once ' +
      'with command "echo proposed-probe" and description "prints a probe line". Then reply with one line: the exact ' +
      'output line and the exit code the tool reported.',
    (request) =>
      bare(request.toolName) === 'shell_propose'
        ? { behavior: 'allow', updatedInput: { command: 'echo edited-$((6*7)); exit 4' } }
        : { behavior: 'deny' },
  )
  const card = run.cards.find((c) => bare(c.toolName) === 'shell_propose')
  if (card && card.input.command === 'echo proposed-probe' && String(card.input.description ?? '').length > 0) {
    ok('the proposal raised a card carrying the command and the description', JSON.stringify(card.input))
  } else {
    fail('the proposal raised a card carrying the command and the description', `cards: ${run.cards.map((c) => c.toolName).join(', ') || 'none'}`)
  }
  if (run.policy.includes('shell_propose')) {
    fail('the engine never resolved the proposal by policy', 'a policy card for shell_propose was recorded')
  }
  const proposed = (await shells(id)).filter((s) => s.proposed)
  if (proposed.length === 1 && proposed[0]!.command === 'echo edited-$((6*7)); exit 4' && proposed[0]!.exitCode === 4) {
    ok('one proposed user shell ran the edited command', `${proposed[0]!.id} owner ${proposed[0]!.owner}, exit 4`)
  } else {
    fail('one proposed user shell ran the edited command', JSON.stringify(proposed))
  }
  if (run.text.includes('edited-42') && run.text.includes('4')) {
    ok('the agent got the edited output and the exit code', JSON.stringify(run.text.trim().slice(-160)))
  } else {
    fail('the agent got the edited output and the exit code', JSON.stringify(run.text.trim().slice(-200)))
  }
}

async function secret(engine: Engine): Promise<void> {
  step(`${engine}: a secret on stdin reaches the command and no event`)
  const id = await create(engine, 'default')
  const run = await turn(
    id,
    'This is an automated test of shell_propose. Do not use Bash or any other command tool. Call shell_propose once ' +
      'with command "wc -c | tr -d \' \'", description "counts the bytes of a secret", and secret true. Then reply ' +
      'with one line: the number the command printed.',
    (request) => (bare(request.toolName) === 'shell_propose' ? { behavior: 'allow', updatedInput: { stdin: SECRET } } : { behavior: 'deny' }),
  )
  const card = run.cards.find((c) => bare(c.toolName) === 'shell_propose')
  if (card?.input.secret === true) {
    ok('the card asked for a secret')
  } else {
    fail('the card asked for a secret', card ? JSON.stringify(card.input) : 'no card')
  }
  const expected = String(SECRET.length)
  if (run.text.includes(expected)) {
    ok('the command read the secret from stdin', `${expected} bytes`)
  } else {
    fail('the command read the secret from stdin', JSON.stringify(run.text.trim().slice(-200)))
  }
  const replay = await turnLog(id)
  if (!replay.includes(SECRET) && !run.raw.includes(SECRET)) {
    ok('the secret is in no event the session recorded or streamed')
  } else {
    fail('the secret is in no event the session recorded or streamed', 'found in the event stream')
  }
}

async function declined(engine: Engine): Promise<void> {
  step(`${engine}: a declined proposal starts no shell`)
  const id = await create(engine, 'default')
  const run = await turn(
    id,
    'This is an automated test of shell_propose. Do not use Bash or any other command tool. Call shell_propose once ' +
      'with command "echo declined-probe" and description "a probe". If the user does not run it, do not retry: reply ' +
      'with one line saying so.',
    () => ({ behavior: 'deny' }),
  )
  if (run.cards.some((c) => bare(c.toolName) === 'shell_propose')) {
    ok('the proposal raised a card')
  } else {
    fail('the proposal raised a card', 'no card')
  }
  const listed = await shells(id)
  if (listed.length === 0) {
    ok('a declined proposal created no shell')
  } else {
    fail('a declined proposal created no shell', `${listed.length} shell(s)`)
  }
  if (run.done) {
    ok('the turn still finished')
  } else {
    fail('the turn still finished', 'no turn_result')
  }
}

// A fresh attach replays the whole log, which is what a parking snapshot and every later client would see.
async function turnLog(id: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  let raw = ''
  ws.on('message', (data) => {
    raw += String(data)
  })
  await new Promise<void>((r, j) => {
    ws.once('open', () => r())
    ws.once('error', j)
  })
  await sleep(2_000)
  ws.close()
  return raw
}

async function main(): Promise<void> {
  try {
    await startGateway()
    for (const engine of engines) {
      await editedInMode(engine, 'bypassPermissions')
      if (engine === 'claude') {
        await editedInMode(engine, 'auto')
      }
      await secret(engine)
      await declined(engine)
    }
  } finally {
    await stopGateway()
    rmSync(root, { recursive: true, force: true })
  }
}

main()
  .catch((error: unknown) => {
    fail('the smoke ran to the end', error instanceof Error ? error.message : String(error))
  })
  .finally(() => finish())
