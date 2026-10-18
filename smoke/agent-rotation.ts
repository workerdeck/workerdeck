// pnpm smoke:agent-rotation [claude|codex|all]   - costs two short turns per engine, on the operator's own credentials.
//
// `packages/server/test/handover*.test.ts` drive scripted runners. A green run proves, per real engine, on one private
// in-process gateway: an agent's `context_reset` rotates it into a new session (same agent, new id); the old session
// is archived, off the list and superseded by the new one; the agent's prompt is the new session's first message and
// gets answered without the word from before; the history lists both conversations; and the archived conversation
// reads back from the engine's own store, also after the gateway restarts on the same state.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createFileAgentStore, createFileSessionStore, createWorkerServer, type WorkerServer } from '@workerdeck/server'
import type { AgentConversationsResponse, AgentResponse, ServerFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { fail, finish, note, ok, step } from './lib/report.ts'

const CLAUDE_MODEL = process.env.WD_SMOKE_CLAUDE_MODEL ?? 'haiku'
const CODEX_MODEL = process.env.WD_SMOKE_CODEX_MODEL ?? 'gpt-5.6-luna'
const NONCE = Math.random().toString(36).slice(2, 8).toUpperCase()
const WORD = `PELICAN-${NONCE}`
const MARK = `FRESH-${NONCE}`
const PROMPT = `You are starting a fresh conversation. Reply with the word ${MARK}, then the secret word from before if you know one, else NONE.`
const which = process.argv[2] ?? 'all'

delete process.env.WORKERDECK_AUTH_KEY
delete process.env.WORKERDECK_RELAY_KEY

const root = mkdtempSync(join(tmpdir(), 'wd-rotation-smoke-'))
const work = join(root, 'project')
mkdirSync(work, { recursive: true })

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(done: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`)
    }
    await sleep(250)
  }
}

function check(passed: boolean, what: string, detail?: string): void {
  if (passed) {
    ok(what, detail)
  } else {
    fail(what, detail)
  }
}

function gateway(state: string): Promise<{ server: WorkerServer; base: string; ws: string }> {
  const server = createWorkerServer({
    allowUnauthenticated: true,
    profiles: [
      { name: 'claude', configDir: join(homedir(), '.claude') },
      { name: 'codex', engine: 'codex' },
    ],
    allowedCwdRoots: [root],
    parking: { store: createFileSessionStore({ dir: join(state, 'sessions') }) },
    agentStore: createFileAgentStore(join(state, 'agents.json')),
    onDiagnostic: (error, where) => note(`${where}: ${error instanceof Error ? error.message : String(error)}`),
  })
  return server.listen(0, '127.0.0.1').then(({ port }) => ({
    server,
    base: `http://127.0.0.1:${port}/v1`,
    ws: `ws://127.0.0.1:${port}/v1`,
  }))
}

async function json<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } })
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

function textOf(event: SessionEvent): string {
  if (event.type !== 'assistant_message' && event.type !== 'user_message') {
    return ''
  }
  const content = event.message.content
  return typeof content === 'string'
    ? content
    : content.map((block) => ((block as { type?: string }).type === 'text' ? (block as { text: string }).text : '')).join('')
}

// The whole archive replay: the attached frame names its last seq, and every row up to it arrives right after.
function readArchive(ws: string, id: string): Promise<{ info: SessionInfo; events: SessionEvent[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${ws}/sessions/${id}/ws`)
    const events: SessionEvent[] = []
    let info: SessionInfo | undefined
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`archive replay incomplete: ${events.length} of ${info?.lastSeq ?? '?'} rows`))
    }, 60_000)
    const settle = () => {
      if (info && events.length >= info.lastSeq) {
        clearTimeout(timer)
        socket.close()
        resolve({ info, events })
      }
    }
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as ServerFrame
      if (frame.type === 'attached') {
        info = frame.session
      } else if (frame.type === 'event') {
        events.push(frame.event)
      } else if (frame.type === 'protocol_error') {
        note(`archive: ${frame.message}`)
      }
      settle()
    })
    socket.on('close', (code) => {
      if (code === 1011) {
        clearTimeout(timer)
        reject(new Error('archive read failed (1011)'))
      }
    })
    socket.on('error', reject)
  })
}

async function cycle(engine: 'claude' | 'codex'): Promise<void> {
  step(`${engine}: agent context_reset rotates the conversation`)
  const state = join(root, `state-${engine}`)
  let gw = await gateway(state)
  try {
    const created = await json<AgentResponse>(gw.base, '/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: `Rot-${engine}`,
        config: {
          cwd: work,
          profile: engine,
          model: engine === 'claude' ? CLAUDE_MODEL : CODEX_MODEL,
          permissionMode: 'bypassPermissions',
        },
      }),
    })
    const agentId = created.agent.id
    const from = created.session!.id
    const old = gw.server.registry.get(from)!
    await waitFor(() => old.info().status === 'idle', 120_000, 'the first session to settle')
    old.sendMessage(
      `Remember the secret word ${WORD}. Now call the context_reset tool exactly once with prompt ${JSON.stringify(PROMPT)} ` +
        `and reason "smoke rotation". Then reply with just: OK`,
    )

    let to: string | undefined
    await waitFor(
      async () => {
        to = (await json<AgentResponse>(gw.base, `/agents/${agentId}`)).agent.sessionId
        return to !== undefined && to !== from
      },
      300_000,
      'the agent to move to a new session',
    )
    ok('the agent moved to a new session', `${from.slice(0, 8)} -> ${to!.slice(0, 8)}`)

    const archived = (await json<{ session: SessionInfo }>(gw.base, `/sessions/${from}`)).session
    check(archived.archived === true, 'the old session is archived')
    check(archived.supersededBy === to, 'the old session is superseded by the new one')
    const listed = (await json<{ sessions: SessionInfo[] }>(gw.base, '/sessions')).sessions.map((row) => row.id)
    check(!listed.includes(from) && listed.includes(to!), 'the list shows only the new session')
    check(gw.server.registry.get(from) === undefined, 'the old runner is gone')

    const fresh = gw.server.registry.get(to!)
    if (!fresh) {
      throw new Error('the new session is not live')
    }
    const events: SessionEvent[] = []
    fresh.subscribe((event) => events.push(event))
    await waitFor(
      () => events.some((event) => event.type === 'assistant_message' && textOf(event).includes(MARK)) && fresh.info().status === 'idle',
      240_000,
      'the new session to answer',
    )
    const first = events.find((event) => event.type === 'user_message' && !event.synthetic)
    check(first !== undefined && textOf(first) === PROMPT, 'the agent prompt is the first message', textOf(first!).slice(0, 60))
    const answer = events
      .filter((event) => event.type === 'assistant_message')
      .map(textOf)
      .join(' ')
    note(`answer: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`)
    check(!answer.includes(WORD), 'the secret word did not survive the rotation')
    const agent = (await json<AgentResponse>(gw.base, `/agents/${agentId}`)).agent
    check(agent.undelivered === undefined, 'no undelivered first message')

    const history = await json<AgentConversationsResponse>(gw.base, `/agents/${agentId}/conversations`)
    check(
      history.conversations.map((row) => `${row.sessionId}:${row.current}`).join(',') === `${to}:true,${from}:false`,
      'the history lists both conversations, current first',
    )

    const read = await readArchive(gw.ws, from)
    check(read.info.transcript !== 'unavailable', 'the archive reads from the engine store', `${read.events.length} rows`)
    check(
      read.events.some((event) => textOf(event).includes(WORD)),
      'the archive holds the old conversation (the secret word)',
    )

    await gw.server.close()
    gw = await gateway(state)
    const again = await readArchive(gw.ws, from)
    check(
      again.events.some((event) => textOf(event).includes(WORD)) && again.info.epoch === read.info.epoch,
      'after a gateway restart the archive reads back the same, under the same epoch',
      `${again.events.length} rows`,
    )
    check((await json<AgentResponse>(gw.base, `/agents/${agentId}`)).agent.sessionId === to, 'the agent stays on the new session')
  } catch (error) {
    fail(`${engine} cycle`, error instanceof Error ? error.message : String(error))
  } finally {
    await gw.server.close()
  }
}

try {
  if (which === 'claude' || which === 'all') {
    await cycle('claude')
  }
  if (which === 'codex' || which === 'all') {
    await cycle('codex')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
finish()
