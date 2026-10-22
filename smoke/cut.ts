// pnpm smoke:cut [all|claude]   - costs about eight short claude turns (haiku) and, with `all`, one codex turn.
//
// The unit suites drive fake engines; a real CLI decides the things the cut leans on. A green run proves, per check:
// a real Claude reply stamps the prompt as consumed, so a plain REST cut needs no discard; a stale token is refused;
// conversation n+1 does not know n's word while n's history still reads back from the engine store; an EARLY interrupt
// either leaves no unconfirmed input or one that discard-and-cut clears; a typed `/clear` is acked and cuts;
// `context_reset` cuts under the same id and its prompt is answered; a cut can switch claude to codex; and every past
// conversation is still a session file in the engine's own store, which the gateway never writes.
//
// It spawns its OWN gateway on a free port and its own state dir, with a config naming only its own profiles.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import {
  GENERATION_HEADER,
  type ConversationsResponse,
  type ServerFrame,
  type SessionEvent,
  type SessionInfo,
  type UnconfirmedInputRefusal,
} from '@workerdeck/protocol'
import { fail, finish, note, ok, step, warn } from './lib/report.ts'

const withCodex = (process.argv[2] ?? 'all') === 'all'
const WORD = 'ORRERY'
// A port free a moment ago, and a child that must still be alive once it answers: never another gateway's.
const PORT = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => resolve(port))
  })
})
const base = `http://127.0.0.1:${PORT}/v1`
const root = realpathSync(mkdtempSync(join(tmpdir(), 'wd-cut-')))
const stateDir = join(root, 'state')
const workDir = join(root, 'work')
const configPath = join(root, 'gateway.config.mjs')
const claudeHome = join(homedir(), '.claude')
mkdirSync(workDir, { recursive: true })

writeFileSync(
  configPath,
  `export default {\n  profiles: [\n    { name: 'claude', configDir: ${JSON.stringify(claudeHome)} },\n` +
    `    { name: 'codex', engine: 'codex' },\n  ],\n  allowedCwdRoots: [${JSON.stringify(root)}],\n` +
    `  parking: { parkDelayMs: 600_000 },\n}\n`,
)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function check(passed: boolean, what: string, detail?: string): void {
  if (passed) {
    ok(what, detail)
  } else {
    fail(what, detail)
  }
}

type Reply = { status: number; body: any }

async function call(path: string, method = 'GET', body?: unknown, generation?: number): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(generation === undefined ? {} : { [GENERATION_HEADER]: String(generation) }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function conversations(id: string): Promise<ConversationsResponse> {
  return (await call(`/sessions/${id}/conversations`)).body as ConversationsResponse
}

async function current(id: string): Promise<number> {
  return (await conversations(id)).conversation ?? 0
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    }
    await sleep(500)
  }
}

async function idle(id: string, timeoutMs = 120_000): Promise<SessionInfo> {
  return waitFor(
    async () => {
      const info = (await call(`/sessions/${id}`)).body.session as SessionInfo | undefined
      const record = await conversations(id)
      return info?.status === 'idle' && record.pendingPrompt?.state !== 'sending' ? info : undefined
    },
    timeoutMs,
    `${id} idle`,
  )
}

// One socket per conversation: a cut closes it with 4011 once n+1 is durable.
type Socket = {
  frames: ServerFrame[]
  events: SessionEvent[]
  generation: number
  send: (command: Record<string, unknown>) => void
  turn: (text: string, timeoutMs?: number) => Promise<string>
  closed: Promise<number>
  close: () => void
}

async function open(id: string): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  const frames: ServerFrame[] = []
  const events: SessionEvent[] = []
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  const attached = new Promise<number>((resolve) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      frames.push(frame)
      if (frame.type === 'attached') {
        resolve(frame.session.conversation ?? 1)
      }
      if (frame.type === 'event') {
        events.push(frame.event)
      }
    })
  })
  ws.on('error', () => {})
  const generation = await Promise.race([
    attached,
    closed.then((code) => Promise.reject(new Error(`socket closed (${code}) before attached`))),
    sleep(20_000).then(() => Promise.reject(new Error('no attached frame within 20s'))),
  ])
  await sleep(1_000)
  const send = (command: Record<string, unknown>): void => ws.send(JSON.stringify({ ...command, generation }))
  const turn = async (text: string, timeoutMs = 180_000): Promise<string> => {
    const from = events.length
    send({ type: 'user_message', text })
    const deadline = Date.now() + timeoutMs
    while (!events.slice(from).some((event) => event.type === 'turn_result')) {
      if (Date.now() > deadline) {
        throw new Error(`no turn_result within ${timeoutMs / 1000}s for "${text.slice(0, 40)}"`)
      }
      await sleep(250)
    }
    return replyText(events.slice(from))
  }
  return { frames, events, generation, send, turn, closed, close: () => ws.close() }
}

function replyText(events: SessionEvent[]): string {
  return events
    .flatMap((event) => (event.type === 'assistant_message' && event.parentToolUseId === null ? [event.message.content] : []))
    .map((content) =>
      typeof content === 'string'
        ? content
        : content.map((block) => ((block as { type?: string }).type === 'text' ? (block as { text: string }).text : '')).join(''),
    )
    .join('\n')
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
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKERDECK_AUTH_KEY: undefined } },
  )
  let exited = false
  child.once('exit', () => (exited = true))
  child.stderr?.on('data', (data) => {
    const line = String(data).trim()
    if (line) {
      console.log(`    \u001b[2m[gateway] ${line}\u001b[0m`)
    }
  })
  await waitFor(
    async () => {
      if (exited) {
        throw new Error('the gateway exited before it answered')
      }
      try {
        return (await fetch(`${base}/sessions`)).ok && !exited ? true : undefined
      } catch {
        return undefined
      }
    },
    30_000,
    'the gateway',
  )
}

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
}

async function create(extra: Record<string, unknown> = {}): Promise<SessionInfo> {
  const res = await call('/sessions', 'POST', {
    cwd: workDir,
    profile: 'claude',
    model: 'haiku',
    permissionMode: 'bypassPermissions',
    ...extra,
  })
  if (res.status !== 201) {
    throw new Error(`create → ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.session as SessionInfo
}

function cut(id: string, expectedGeneration: number, extra: Record<string, unknown> = {}): Promise<Reply> {
  return call(`/sessions/${id}/conversations`, 'POST', { expectedGeneration, ...extra })
}

// Read only: the engine's own store, where `claude --resume` and the CLI stats look.
function claudeStoreHas(engineSessionId: string): boolean {
  const projects = join(claudeHome, 'projects')
  return existsSync(projects) && readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${engineSessionId}.jsonl`)))
}

function codexStoreHas(threadId: string): boolean {
  const walk = (dir: string): boolean =>
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.includes(threadId),
    )
  return walk(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'))
}

async function main(): Promise<void> {
  step('1. A plain session answers, and its reply stamps the prompt as consumed')
  await startGateway()
  const plain = await create()
  const id = plain.id
  await idle(id)
  let socket = await open(id)
  check(socket.generation === 1, 'a new session attaches on conversation 1', String(socket.generation))
  const first = await socket.turn(`Remember the secret word ${WORD}. Reply with just OK.`)
  note(`reply: ${JSON.stringify(first.slice(0, 60))}`)
  await idle(id)
  const afterTurn = await conversations(id)
  check(afterTurn.pendingPrompt === undefined, 'no pending prompt after an answered turn')

  step('2. REST cut: a stale or missing token is refused, the current one cuts under the same id')
  check((await cut(id, 7)).status === 409, 'a stale expectedGeneration is refused')
  check((await call(`/sessions/${id}`, 'PATCH', { title: 'x' })).status === 409, 'a mutation with no generation header is refused')
  const closing = socket.closed
  const cut1 = await cut(id, 1)
  check(cut1.status === 200 && cut1.body.conversation === 2, 'the cut answers conversation 2', `${cut1.status} ${JSON.stringify(cut1.body).slice(0, 160)}`)
  check(cut1.body.session?.id === id, 'the id is unchanged')
  const code = await Promise.race([closing, sleep(15_000).then(() => 0)])
  check(code === 4011, 'the old socket closes with 4011', String(code))
  await idle(id)
  socket = await open(id)
  check(socket.generation === 2, 'a new socket attaches on conversation 2', String(socket.generation))
  const recall = await socket.turn('What secret word were you asked to remember? Reply with just the word, or NONE.')
  check(!recall.toUpperCase().includes(WORD), 'conversation 2 does not know the word from 1', JSON.stringify(recall.slice(0, 60)))
  await idle(id)
  const listed = await conversations(id)
  const one = listed.history.find((entry) => entry.n === 1)
  check(one?.engine === 'claude' && one.engineSessionId !== undefined, 'history lists conversation 1 with its engine session id')
  const read = await call(`/sessions/${id}/conversations/1`)
  check(read.status === 200 && JSON.stringify(read.body.events).includes(WORD), 'conversation 1 reads back from the engine store with the word')

  step('3. An EARLY interrupt: unconfirmed input either never appears or discard-and-cut clears it')
  socket.send({ type: 'user_message', text: 'Write a 300-word story about a lighthouse.', clientId: 'early-1' })
  socket.send({ type: 'interrupt' })
  await sleep(4_000)
  await idle(id)
  const acks = socket.frames.filter((frame) => frame.type === 'ack')
  note(`acks: ${JSON.stringify(acks)}`)
  const early = await cut(id, 2)
  if (early.status === 200) {
    ok('the cut went through without a discard', 'the reply stamp (or its absence) left no unconfirmed input')
  } else if (early.status === 409 && (early.body as UnconfirmedInputRefusal).code === 'unconfirmed_input') {
    const refusal = early.body as UnconfirmedInputRefusal
    ok('the cut is refused with unconfirmed_input', `pendingInput ${refusal.pendingInput}, peer ${refusal.mayIncludePeer}`)
    const discarded = await call(`/sessions/${id}/conversations/discard`, 'POST', {
      expectedGeneration: 2,
      inputRevision: refusal.inputRevision,
    })
    check(discarded.status === 200 && discarded.body.conversation === 3, 'discard-and-cut recovers onto conversation 3', `${discarded.status}`)
  } else {
    fail('the cut after an early interrupt', `${early.status} ${JSON.stringify(early.body).slice(0, 200)}`)
  }
  await idle(id)
  const n3 = await current(id)
  check(n3 === 3, 'the session is on conversation 3', String(n3))

  step('4. A typed /clear is acked with its outcome and cuts')
  socket = await open(id)
  const closing3 = socket.closed
  socket.send({ type: 'user_message', text: '/clear', clientId: 'clear-1' })
  await Promise.race([closing3, sleep(30_000)])
  const ack = socket.frames.find((frame) => frame.type === 'ack' && frame.clientId === 'clear-1')
  check(ack !== undefined && !('notDelivered' in ack), 'the /clear is acked as delivered', JSON.stringify(ack))
  await idle(id)
  check((await current(id)) === 4, 'the session is on conversation 4')

  step('5. context_reset from an agent cuts under the same id, and its prompt is answered')
  const agent = await create({ agent: { name: 'Cutter' }, agentContextReset: true })
  await idle(agent.id)
  const agentSocket = await open(agent.id)
  const agentClosed = agentSocket.closed
  void agentSocket
    .turn(
      'Call the context_reset tool with prompt "Reply with just RESET-OK" and reason "smoke". Then stop; do not reply.',
      240_000,
    )
    .catch(() => {})
  const agentCode = await Promise.race([agentClosed, sleep(240_000).then(() => 0)])
  check(agentCode === 4011, 'the agent socket closes with 4011 after context_reset', String(agentCode))
  await idle(agent.id, 180_000)
  check((await current(agent.id)) === 2, 'the agent is on conversation 2 under the same id')
  const fresh = await open(agent.id)
  await sleep(2_000)
  check(replyText(fresh.events).includes('RESET-OK'), 'the reset prompt was answered in conversation 2')
  fresh.close()

  if (withCodex) {
    step('6. A cut switches the engine: claude to codex under the same id')
    const switched = await cut(id, 4, { target: { profile: 'codex' } })
    check(switched.status === 200 && switched.body.session?.engine === 'codex', 'conversation 5 runs on codex', `${switched.status}`)
    await idle(id, 180_000)
    socket = await open(id)
    const pong = await socket.turn('Reply with just PONG.', 240_000)
    check(pong.toUpperCase().includes('PONG'), 'codex answered in conversation 5', JSON.stringify(pong.slice(0, 60)))
    socket.close()
    await idle(id)
    const cutToCodex = await cut(id, 5)
    check(cutToCodex.status === 200, 'a cut ends the codex conversation too')
    await idle(id, 120_000)
  }

  step('7. Every past conversation is still in the engine store')
  for (const sessionId of [id, agent.id]) {
    for (const entry of (await conversations(sessionId)).history) {
      if (!entry.engineSessionId) {
        warn(`conversation ${entry.n} of ${sessionId} never got an engine session id`, 'it never ran a turn')
        continue
      }
      const kept = entry.engine === 'codex' ? codexStoreHas(entry.engineSessionId) : claudeStoreHas(entry.engineSessionId)
      check(kept, `conversation ${entry.n} (${entry.engine}) is in the engine store`, entry.engineSessionId)
    }
  }
}

try {
  await main()
} catch (error) {
  fail('the smoke ran to the end', error instanceof Error ? error.message : String(error))
} finally {
  await stopGateway()
  rmSync(root, { recursive: true, force: true })
}
finish()
