import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JsonRpcError,
  SessionRunner,
  withPeerContext,
  type AppServerConnection,
  type AppServerConnectFn,
  type HistoryFn,
} from '@workerdeck/core'
import type { ProfileInfo, SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import {
  createHistoryReader,
  engineHomeOf,
  type HistoryReaderOptions,
  type HistoryTarget,
  type ReaderChild,
} from '../src/services/history-reader.ts'
import { eventually } from './helpers.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

type Messages = Awaited<ReturnType<HistoryFn>>

function entry(type: 'user' | 'assistant', uuid: string, message: unknown): Messages[number] {
  return { type, uuid, session_id: 'sdk-1', message, parent_tool_use_id: null, parent_agent_id: null } as Messages[number]
}

const ORIGIN = { kind: 'peer' as const, sessionId: 'peer-1', hostId: 'mini', name: 'Astra', engine: 'codex' as const }

const CLAUDE_FIXTURE: Messages = [
  entry('user', 'u-peer', { role: 'user', content: withPeerContext('please review', { origin: ORIGIN }) }),
  entry('user', 'u-task', { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }),
  entry('assistant', 'a-1', {
    id: 'msg_1',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'first', signature: 's' },
      { type: 'thinking', thinking: 'second', signature: 's' },
      { type: 'text', text: 'done' },
    ],
  }),
  {
    type: 'system',
    uuid: 's-1',
    session_id: 'sdk-1',
    message: {},
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as Messages[number],
]

const claudeTarget: HistoryTarget = { sessionId: 'wd-1', engine: 'claude', engineSessionId: 'sdk-1', cwd: '/tmp/project' }
const codexTarget: HistoryTarget = { sessionId: 'wd-2', engine: 'codex', engineSessionId: 'thread-1', cwd: '/tmp/project' }

const CODEX_TURNS = [
  {
    id: 'turn-1',
    items: [
      { type: 'userMessage', id: 'item-u', content: [{ type: 'text', text: withPeerContext('hello codex', { origin: ORIGIN }) }] },
      { type: 'agentMessage', id: 'item-a', text: 'hi there' },
    ],
  },
]

type FakeConnection = AppServerConnection & { calls: string[]; closed: number }

function fakeCodex(answer: (method: string, params: unknown) => Promise<unknown>): {
  connect: AppServerConnectFn
  connections: FakeConnection[]
} {
  const connections: FakeConnection[] = []
  const connect: AppServerConnectFn = () => {
    const connection: FakeConnection = {
      calls: [],
      closed: 0,
      request: (method, params) => {
        connection.calls.push(method)
        return answer(method, params)
      },
      notify: (method) => {
        connection.calls.push(`notify:${method}`)
      },
      onNotification: () => {},
      onRequest: () => {},
      onClose: () => {},
      close: () => {
        connection.closed++
      },
    }
    connections.push(connection)
    return connection
  }
  return { connect, connections }
}

function codexAnswers(turns: unknown = CODEX_TURNS): (method: string) => Promise<unknown> {
  return async (method) => (method === 'initialize' ? {} : { thread: { id: 'thread-1', turns } })
}

const FORBIDDEN = /^(thread\/start|thread\/resume|turn\/)/

type FakeChild = ReaderChild & { args: string[]; env: Record<string, string>; killed: string[]; exit(code: number, out?: string): void }

function fakeSpawn(): { spawnChild: HistoryReaderOptions['spawnChild']; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawnChild = (args: string[], env: Record<string, string>): ReaderChild => {
    const emitter = new EventEmitter()
    const stdout = new PassThrough()
    const child = Object.assign(emitter, {
      args,
      env,
      killed: [] as string[],
      stdout,
      stderr: new PassThrough(),
      kill: (signal?: NodeJS.Signals) => {
        child.killed.push(signal ?? 'SIGTERM')
        return true
      },
      exit: (code: number, out?: string) => {
        if (out !== undefined) {
          stdout.write(out)
        }
        setImmediate(() => emitter.emit('exit', code, null))
      },
    }) as unknown as FakeChild
    children.push(child)
    return child
  }
  return { spawnChild, children }
}

async function runnerBackfill(messages: Messages): Promise<SessionEventBody[]> {
  const runner = new SessionRunner({
    cwd: '/tmp/project',
    resume: 'sdk-1',
    startAsleep: true,
    historyFn: async () => messages,
    sessionInfoFn: async () => undefined,
  })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event), undefined, { coalesceReplay: false })
  await runner.start()
  await eventually(() => expect(events.some((e) => e.type === 'engine_sleep')).toBe(true))
  runner.close()
  return events
    .filter((e) => e.type === 'user_message' || e.type === 'assistant_message')
    .map(({ seq: _seq, ts: _ts, ...body }) => body as SessionEventBody)
}

function gatewayEnvWith(configDir: string): Record<string, string | undefined> {
  return { CLAUDE_CONFIG_DIR: configDir, HOME: '/nonexistent' }
}

describe('history reader: claude', () => {
  it("converts a transcript exactly like the runner's dormant-wake backfill", async () => {
    const configDir = temp('wd-hr-claude-')
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const reader = createHistoryReader({ gatewayEnv: gatewayEnvWith(configDir), claudeHistory })
    const read = await reader.read(claudeTarget)
    expect(claudeHistory).toHaveBeenCalledWith('sdk-1', { dir: '/tmp/project' })
    expect(read.kind).toBe('ok')
    const events = read.kind === 'ok' ? read.events : []
    expect(events).toEqual(await runnerBackfill(CLAUDE_FIXTURE))
    const [peer, task, assistant] = events
    expect(peer).toMatchObject({ type: 'user_message', message: { content: 'please review' }, origin: ORIGIN, replay: true })
    expect(task).toMatchObject({ type: 'user_message', synthetic: true, replay: true })
    expect(assistant).toMatchObject({ type: 'assistant_message', replay: true, uuid: 'a-1' })
    const blocks = assistant?.type === 'assistant_message' && Array.isArray(assistant.message.content) ? assistant.message.content : []
    expect(blocks[1]).toMatchObject({ type: 'thinking', addressed: true })
  })

  it('reports an empty transcript, or no engine identity, as missing', async () => {
    const configDir = temp('wd-hr-claude-')
    const reader = createHistoryReader({ gatewayEnv: gatewayEnvWith(configDir), claudeHistory: async () => [] })
    expect(await reader.read(claudeTarget)).toEqual({ kind: 'missing' })
    expect(await reader.read({ ...claudeTarget, engineSessionId: undefined })).toEqual({ kind: 'missing' })
  })

  it('reports a thrown read as failed', async () => {
    const configDir = temp('wd-hr-claude-')
    const reader = createHistoryReader({
      gatewayEnv: gatewayEnvWith(configDir),
      claudeHistory: async () => {
        throw new Error('disk on fire')
      },
    })
    expect(await reader.read(claudeTarget)).toEqual({ kind: 'failed', error: 'disk on fire' })
  })

  it("reads in-process when the profile's config dir is the gateway's own", async () => {
    const configDir = temp('wd-hr-claude-')
    const { spawnChild, children } = fakeSpawn()
    const profile: ProfileInfo = { name: 'default', configDir }
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const reader = createHistoryReader({ gatewayEnv: gatewayEnvWith(configDir), profile: () => profile, claudeHistory, spawnChild })
    expect((await reader.read({ ...claudeTarget, profile: 'default' })).kind).toBe('ok')
    expect(claudeHistory).toHaveBeenCalledOnce()
    expect(children).toHaveLength(0)
  })

  it("takes the child path under the profile's own config dir when it differs from the gateway's", async () => {
    const gatewayDir = temp('wd-hr-gw-')
    const profileDir = temp('wd-hr-profile-')
    const { spawnChild, children } = fakeSpawn()
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const reader = createHistoryReader({
      gatewayEnv: gatewayEnvWith(gatewayDir),
      profile: (name) => (name === 'work' ? { name: 'work', configDir: profileDir } : undefined),
      sessionEnvFor: () => ({ ...gatewayEnvWith(gatewayDir), WORKERDECK_AUTH_KEY: 'secret' }),
      claudeHistory,
      spawnChild,
      claudeSdkEntry: () => '/sdk/sdk.mjs',
    })
    const pending = reader.read({ ...claudeTarget, profile: 'work' })
    await eventually(() => expect(children).toHaveLength(1))
    const child = children[0]!
    expect(child.env.CLAUDE_CONFIG_DIR).toBe(profileDir)
    expect(child.env.WORKERDECK_AUTH_KEY).toBeUndefined()
    expect(child.args.slice(-3)).toEqual(['file:///sdk/sdk.mjs', 'sdk-1', '/tmp/project'])
    child.exit(0, JSON.stringify(CLAUDE_FIXTURE))
    const read = await pending
    expect(claudeHistory).not.toHaveBeenCalled()
    expect(read).toEqual({ kind: 'ok', events: await runnerBackfill(CLAUDE_FIXTURE) })
  })

  it('kills the child on timeout and on abort, and fails on a non-zero exit', async () => {
    const gatewayDir = temp('wd-hr-gw-')
    const profileDir = temp('wd-hr-profile-')
    mkdirSync(join(profileDir, 'projects'))
    const { spawnChild, children } = fakeSpawn()
    const options = (timeoutMs: number): HistoryReaderOptions => ({
      gatewayEnv: gatewayEnvWith(gatewayDir),
      profile: () => ({ name: 'work', configDir: profileDir }),
      spawnChild,
      claudeSdkEntry: () => '/sdk/sdk.mjs',
      timeoutMs,
    })
    const target = { ...claudeTarget, profile: 'work' }
    expect(await createHistoryReader(options(30)).read(target)).toEqual({ kind: 'failed', error: 'history read timed out after 30 ms' })
    expect(children[0]!.killed).toEqual(['SIGKILL'])

    const reader = createHistoryReader(options(10_000))
    const controller = new AbortController()
    const aborted = reader.read(target, controller.signal)
    await eventually(() => expect(children).toHaveLength(2))
    controller.abort()
    expect(await aborted).toEqual({ kind: 'failed', error: 'history read aborted' })
    expect(children[1]!.killed).toEqual(['SIGKILL'])

    const crashed = reader.read(target)
    await eventually(() => expect(children).toHaveLength(3))
    children[2]!.exit(1)
    expect(await crashed).toMatchObject({ kind: 'failed', error: expect.stringContaining('code 1') })
  })
})

describe('history reader: codex', () => {
  it('calls exactly initialize then thread/read, converts the turns, and closes the app-server', async () => {
    const { connect, connections } = fakeCodex(codexAnswers())
    const params: unknown[] = []
    const reader = createHistoryReader({
      codexConnect: (options) => {
        params.push(options.env.CODEX_HOME)
        return connect(options)
      },
      profile: () => ({ name: 'codex', engine: 'codex', codexHome: '/homes/codex' }),
    })
    const read = await reader.read({ ...codexTarget, profile: 'codex' })
    expect(params).toEqual(['/homes/codex'])
    const connection = connections[0]!
    expect(connection.calls).toEqual(['initialize', 'notify:initialized', 'thread/read'])
    expect(connection.calls.filter((method) => FORBIDDEN.test(method))).toEqual([])
    expect(connection.closed).toBeGreaterThanOrEqual(1)
    expect(read.kind).toBe('ok')
    const events = read.kind === 'ok' ? read.events : []
    expect(events[0]).toMatchObject({ type: 'user_message', message: { content: 'hello codex' }, origin: ORIGIN, replay: true })
    expect(events.some((e) => e.type === 'assistant_message' && e.replay === true)).toBe(true)
  })

  it('passes threadId and includeTurns to thread/read', async () => {
    const seen: unknown[] = []
    const { connect } = fakeCodex(async (method, params) => {
      seen.push([method, params])
      return method === 'initialize' ? {} : { thread: { turns: CODEX_TURNS } }
    })
    await createHistoryReader({ codexConnect: connect }).read(codexTarget)
    expect(seen[1]).toEqual(['thread/read', { threadId: 'thread-1', includeTurns: true }])
  })

  it('maps a missing thread to missing and other errors to failed, closing every time', async () => {
    const missing = fakeCodex(async (method) => {
      if (method === 'thread/read') {
        throw new JsonRpcError(-32600, 'no rollout found for thread id thread-1')
      }
      return {}
    })
    expect(await createHistoryReader({ codexConnect: missing.connect }).read(codexTarget)).toEqual({ kind: 'missing' })
    expect(missing.connections[0]!.closed).toBeGreaterThanOrEqual(1)

    const empty = fakeCodex(codexAnswers([]))
    expect(await createHistoryReader({ codexConnect: empty.connect }).read(codexTarget)).toEqual({ kind: 'missing' })
    expect(empty.connections[0]!.closed).toBeGreaterThanOrEqual(1)

    const broken = fakeCodex(async () => {
      throw new JsonRpcError(-32603, 'internal error')
    })
    expect(await createHistoryReader({ codexConnect: broken.connect }).read(codexTarget)).toEqual({
      kind: 'failed',
      error: 'internal error',
    })
    expect(broken.connections[0]!.calls).toEqual(['initialize'])
    expect(broken.connections[0]!.closed).toBeGreaterThanOrEqual(1)

    const unspawnable: AppServerConnectFn = () => {
      throw new Error('spawn ENOENT')
    }
    expect(await createHistoryReader({ codexConnect: unspawnable }).read(codexTarget)).toEqual({ kind: 'failed', error: 'spawn ENOENT' })
  })

  it('closes the app-server on timeout and on abort', async () => {
    const hung = fakeCodex(() => new Promise(() => {}))
    const timed = createHistoryReader({ codexConnect: hung.connect, timeoutMs: 30 })
    expect(await timed.read(codexTarget)).toEqual({ kind: 'failed', error: 'history read timed out after 30 ms' })
    expect(hung.connections[0]!.closed).toBeGreaterThanOrEqual(1)

    const controller = new AbortController()
    const pending = createHistoryReader({ codexConnect: hung.connect }).read(codexTarget, controller.signal)
    await eventually(() => expect(hung.connections).toHaveLength(2))
    controller.abort()
    expect(await pending).toEqual({ kind: 'failed', error: 'history read aborted' })
    expect(hung.connections[1]!.closed).toBeGreaterThanOrEqual(1)
  })
})

describe('history reader: scheduling and engines', () => {
  it('runs at most maxConcurrent reads and queues the rest', async () => {
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    const { connect } = fakeCodex(async (method) => {
      if (method === 'initialize') {
        return {}
      }
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return { thread: { turns: CODEX_TURNS } }
    })
    const reader = createHistoryReader({ codexConnect: connect })
    const reads = Array.from({ length: 5 }, () => reader.read(codexTarget))
    for (let released = 0; released < 5; released++) {
      await eventually(() => expect(releases.length).toBeGreaterThan(released))
      expect(active).toBeLessThanOrEqual(2)
      releases[released]!()
    }
    const results = await Promise.all(reads)
    expect(peak).toBe(2)
    expect(results.every((r) => r.kind === 'ok')).toBe(true)
  })

  it('drops a queued read when its signal aborts before it starts', async () => {
    const hung = fakeCodex(() => new Promise(() => {}))
    const reader = createHistoryReader({ codexConnect: hung.connect, maxConcurrent: 1, timeoutMs: 1000 })
    const first = new AbortController()
    const firstRead = reader.read(codexTarget, first.signal)
    const queued = new AbortController()
    const queuedRead = reader.read(codexTarget, queued.signal)
    queued.abort()
    expect(await queuedRead).toEqual({ kind: 'failed', error: 'history read aborted' })
    expect(hung.connections).toHaveLength(1)
    first.abort()
    await firstRead
  })

  it('answers missing for the provider engine without touching any seam', async () => {
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const { connect, connections } = fakeCodex(codexAnswers())
    const reader = createHistoryReader({ claudeHistory, codexConnect: connect })
    expect(await reader.read({ ...claudeTarget, engine: 'provider' })).toEqual({ kind: 'missing' })
    expect(claudeHistory).not.toHaveBeenCalled()
    expect(connections).toHaveLength(0)
  })

  it('fails, without reading, for a profile the gateway no longer knows', async () => {
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const reader = createHistoryReader({ claudeHistory, profile: () => undefined })
    expect(await reader.read({ ...claudeTarget, profile: 'gone' })).toEqual({ kind: 'failed', error: 'unknown profile: gone' })
    expect(claudeHistory).not.toHaveBeenCalled()
  })
})

describe('history reader: the engine home recorded at archive time', () => {
  it("reads claude history from the recorded config dir after the profile's dir changed", async () => {
    const gatewayDir = temp('wd-hr-gw-')
    const recorded = temp('wd-hr-recorded-')
    const moved = temp('wd-hr-moved-')
    const { spawnChild, children } = fakeSpawn()
    const reader = createHistoryReader({
      gatewayEnv: gatewayEnvWith(gatewayDir),
      profile: () => ({ name: 'work', configDir: moved }),
      sessionEnvFor: () => ({ ...gatewayEnvWith(moved) }),
      spawnChild,
      claudeSdkEntry: () => '/sdk/sdk.mjs',
    })
    const pending = reader.read({ ...claudeTarget, profile: 'work', home: { claudeConfigDir: recorded } })
    await eventually(() => expect(children).toHaveLength(1))
    expect(children[0]!.env.CLAUDE_CONFIG_DIR).toBe(recorded)
    children[0]!.exit(0, JSON.stringify(CLAUDE_FIXTURE))
    expect((await pending).kind).toBe('ok')
  })

  it('reads claude history for a deleted profile from the recorded config dir', async () => {
    const gatewayDir = temp('wd-hr-gw-')
    const recorded = temp('wd-hr-recorded-')
    const { spawnChild, children } = fakeSpawn()
    const claudeHistory = vi.fn(async () => CLAUDE_FIXTURE)
    const reader = createHistoryReader({
      gatewayEnv: gatewayEnvWith(gatewayDir),
      profile: () => undefined,
      claudeHistory,
      spawnChild,
      claudeSdkEntry: () => '/sdk/sdk.mjs',
    })
    const pending = reader.read({ ...claudeTarget, profile: 'gone', home: { claudeConfigDir: recorded } })
    await eventually(() => expect(children).toHaveLength(1))
    expect(children[0]!.env.CLAUDE_CONFIG_DIR).toBe(recorded)
    children[0]!.exit(0, JSON.stringify(CLAUDE_FIXTURE))
    expect((await pending).kind).toBe('ok')

    const inProcess = createHistoryReader({ gatewayEnv: gatewayEnvWith(gatewayDir), profile: () => undefined, claudeHistory, spawnChild })
    expect((await inProcess.read({ ...claudeTarget, profile: 'gone', home: { claudeConfigDir: gatewayDir } })).kind).toBe('ok')
    expect(claudeHistory).toHaveBeenCalledOnce()
  })

  it('reads codex history from the recorded home after the profile moved or was deleted', async () => {
    const homes: unknown[] = []
    const { connect } = fakeCodex(codexAnswers())
    let profile: ProfileInfo | undefined = { name: 'codex', engine: 'codex', codexHome: '/homes/new' }
    const reader = createHistoryReader({
      codexConnect: (options) => {
        homes.push(options.env.CODEX_HOME)
        return connect(options)
      },
      profile: () => profile,
    })
    const target: HistoryTarget = { ...codexTarget, profile: 'codex', home: { codexHome: '/homes/old' } }
    expect((await reader.read(target)).kind).toBe('ok')
    profile = undefined
    expect((await reader.read(target)).kind).toBe('ok')
    expect(homes).toEqual(['/homes/old', '/homes/old'])
  })

  it('resolves only the two store dirs, the way a read would, and nothing for the provider engine', () => {
    const env = { CLAUDE_CONFIG_DIR: '/env/claude', CODEX_HOME: '/env/codex', ANTHROPIC_API_KEY: 'secret' }
    expect(engineHomeOf({ name: 'p', configDir: '/p/claude' }, 'claude', () => env, env)).toEqual({ claudeConfigDir: '/p/claude' })
    expect(engineHomeOf({ name: 'p' }, 'claude', () => env, {})).toEqual({ claudeConfigDir: '/env/claude' })
    expect(engineHomeOf(undefined, 'claude', () => ({}), env)).toEqual({ claudeConfigDir: '/env/claude' })
    expect(engineHomeOf({ name: 'c', engine: 'codex' }, 'codex', () => env, {})).toEqual({ codexHome: '/env/codex' })
    expect(engineHomeOf({ name: 'c', engine: 'codex', codexHome: '/c/home' }, 'codex', () => env, env)).toEqual({ codexHome: '/c/home' })
    expect(engineHomeOf(undefined, 'provider', () => env, env)).toBeUndefined()
  })
})
