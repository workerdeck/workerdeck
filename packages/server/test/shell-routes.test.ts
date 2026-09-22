import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  ENGINE_CAPABILITIES,
  SHELL_COMMAND_MAX,
  SHELL_INLINE_LINES,
  type ServerFrame,
  type SessionInfo,
  type ShellInfo,
} from '@workerdeck/protocol'
import { createWorkerServer, sandboxedProviderProfile, type WorkerServer, type WorkerServerOptions } from '../src/index.ts'
import { loadPty } from '../src/services/shells.ts'
import { fakeHarness, fakeRunner, frameCollector, listenOn } from './helpers.ts'

const pty = await loadPty()
if (pty === null) {
  console.warn('shell-routes.test: @lydell/node-pty is not installed for this platform, skipping the PTY suites')
}
const withPty = describe.skipIf(pty === null)

let running: WorkerServer | undefined
const dirs: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wd-shell-ws-')))
  dirs.push(dir)
  return dir
}

const PRINCIPALS: Record<string, unknown> = {
  operator: {},
  'alice-a': { scope: { space: 'a', user: 'alice' } },
}

async function startServer(harness: ReturnType<typeof fakeHarness>, extra: Partial<WorkerServerOptions> = {}) {
  running = createWorkerServer({
    authenticate: (req) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const url = new URL(req.url ?? '/', 'http://internal')
      return PRINCIPALS[token || (url.searchParams.get('key') ?? '')] ?? null
    },
    allowedCwdRoots: [realpathSync(tmpdir())],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    ...extra,
  })
  return listenOn(running)
}

async function startShellServer(harness: ReturnType<typeof fakeHarness>, extra: Partial<WorkerServerOptions> = {}) {
  return startServer(harness, { shell: { enabled: true, artifactDir: tempDir() }, ...extra })
}

async function createSession(base: string, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session.id
}

async function attach(wsBase: string, id: string, token: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?key=${token}`)
  const collector = frameCollector(ws)
  const attached = (await collector.waitFor((f) => f.type === 'attached')) as Extract<ServerFrame, { type: 'attached' }>
  return { ws, collector, attached }
}

function isError(frame: ServerFrame): frame is Extract<ServerFrame, { type: 'protocol_error' }> {
  return frame.type === 'protocol_error'
}

function shellRow(frame: ServerFrame): { text: string; shell: ShellInfo } | undefined {
  if (frame.type !== 'event' || frame.event.type !== 'user_message' || !frame.event.synthetic || !frame.event.shell) {
    return undefined
  }
  const content = frame.event.message.content
  return typeof content === 'string' ? { text: content, shell: frame.event.shell } : undefined
}

function localOutput(frame: ServerFrame): string | undefined {
  return shellRow(frame)?.text
}

async function waitForExit(collector: ReturnType<typeof frameCollector>, command: string) {
  const frame = await collector.waitFor((f) => {
    const row = shellRow(f)
    return row?.shell.command === command && row.shell.status === 'exited'
  }, 8000)
  return shellRow(frame)!
}

async function get(base: string, path: string, token = 'operator') {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

describe('shell_command over WS', () => {
  it('is absent from the attached frame and refused when the server has no shell', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector, attached } = await attach(wsBase, id, 'operator')
    expect('shell' in attached).toBe(false)

    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo hi' }))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('shell commands are not available on this session')
    expect(collector.frames.some((f) => localOutput(f) !== undefined)).toBe(false)
    ws.close()
  })

  it('refuses a scoped principal even with the shell enabled', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'alice-a', { cwd: tempDir() })
    const { ws, collector, attached } = await attach(wsBase, id, 'alice-a')
    expect('shell' in attached).toBe(false)
    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo hi' }))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('shell commands are not available on this session')
    ws.close()
  })

  it('refuses an engine without a host cwd', async () => {
    const harness = fakeHarness()
    const queueLocalCommand = vi.fn()
    const { base, wsBase } = await startShellServer(harness, {
      profiles: [sandboxedProviderProfile('sandboxed', { id: 'openai-compatible', model: 'test-model' })],
      createEngineRunner: ({ config }) => {
        const runner = fakeRunner('p1', config)
        return {
          ...runner,
          info: () => ({ ...runner.info(), engine: 'provider', capabilities: ENGINE_CAPABILITIES.provider }),
          queueLocalCommand,
        }
      },
    })
    const id = await createSession(base, 'operator', { profile: 'sandboxed' })
    const { ws, collector, attached } = await attach(wsBase, id, 'operator')
    expect('shell' in attached).toBe(false)
    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo hi' }))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('shell commands are not available on this session')
    expect(queueLocalCommand).not.toHaveBeenCalled()
    ws.close()
  })

  it('rejects an empty or oversized command before spawning anything', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')

    ws.send(JSON.stringify({ type: 'shell_command', command: '   ' }))
    const empty = await collector.waitFor(isError)
    expect(isError(empty) && empty.message).toBe('shell command is empty')

    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo ' + 'x'.repeat(SHELL_COMMAND_MAX) }))
    const long = await collector.waitFor((f) => isError(f) && f.message !== 'shell command is empty')
    expect(isError(long) && long.message).toBe(`shell command exceeds ${SHELL_COMMAND_MAX} characters`)
    expect(collector.frames.some((f) => localOutput(f) !== undefined)).toBe(false)
    ws.close()
  })

  it('answers the stage 2 socket commands with a protocol error', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_attach', shellId: 'nope', cols: 80, rows: 24 }))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('unknown command: shell_attach')
    ws.close()
  })
})

withPty('shell_command spawns a tracked PTY', () => {
  it('runs in the session cwd, draws one row, and rides the next message into the model', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const cwd = tempDir()
    const id = await createSession(base, 'operator', { cwd })
    const { ws, collector, attached } = await attach(wsBase, id, 'operator')
    expect(attached.shell).toBe(true)

    ws.send(JSON.stringify({ type: 'shell_command', command: 'pwd; echo done' }))
    const row = await waitForExit(collector, 'pwd; echo done')
    expect(row.text).toBe(`<local-command-stdout>$ pwd; echo done\n${cwd}\ndone</local-command-stdout>`)
    expect(row.shell).toMatchObject({ ordinal: 1, owner: 'user', status: 'exited', exitCode: 0, endReason: 'exit', sessionId: id })
    expect(harness.captured.inputs).toHaveLength(0)

    const rows = collector.frames.map(shellRow).filter((seen) => seen !== undefined)
    expect(new Set(rows.map((seen) => seen.shell.id)).size).toBe(1)

    ws.send(JSON.stringify({ type: 'user_message', text: 'what did it print?' }))
    await vi.waitFor(() => expect(harness.captured.inputs).toHaveLength(1))
    const content = harness.captured.inputs[0]!.message.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.text.startsWith('<local-command-caveat>')).toBe(true)
    expect(content[0]!.text.endsWith(`<local-command-stdout>$ pwd; echo done\n${cwd}\ndone</local-command-stdout>`)).toBe(true)
    expect(content[1]).toEqual({ type: 'text', text: 'what did it print?' })
    ws.close()
  })

  it('frames a failing command as stderr with its exit code', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo bad >&2; exit 2' }))
    const row = await waitForExit(collector, 'echo bad >&2; exit 2')
    expect(row.text).toBe('<local-command-stderr>$ echo bad >&2; exit 2\nbad\n[exit 2]</local-command-stderr>')
    ws.close()
  })

  it('bounds the row to the inline lines and keeps the whole output on the artifact', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    const command = 'i=1; while [ $i -le 200 ]; do echo line$i; i=$((i+1)); done'
    ws.send(JSON.stringify({ type: 'shell_command', command }))
    const row = await waitForExit(collector, command)
    const lines = row.text.split('\n')
    expect(lines[1]).toBe('line1')
    expect(lines).toHaveLength(SHELL_INLINE_LINES + 2)
    expect(lines.at(-1)).toContain(`[... ${200 - SHELL_INLINE_LINES} more lines ...]`)

    const res = await get(base, `/sessions/${id}/shells/${row.shell.id}/output`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const text = await res.text()
    expect(text.split('\n').filter((line) => line.startsWith('line'))).toHaveLength(200)
    const tail = await (await get(base, `/sessions/${id}/shells/${row.shell.id}/output?view=raw&tail=32`)).text()
    expect(tail.length).toBeLessThanOrEqual(64)
    ws.close()
  })

  it('has no default wall clock, lists newest first, and kills on request', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo first' }))
    await waitForExit(collector, 'echo first')
    ws.send(JSON.stringify({ type: 'shell_command', command: 'sleep 30' }))
    const started = await collector.waitFor((f) => shellRow(f)?.shell.command === 'sleep 30')
    const sleeping = shellRow(started)!.shell

    const listed = (await (await get(base, `/sessions/${id}/shells`)).json()) as { shells: ShellInfo[] }
    expect(listed.shells.map((shell) => shell.command)).toEqual(['sleep 30', 'echo first'])
    expect(listed.shells[0]!.status).toBe('running')

    const one = (await (await get(base, `/sessions/${id}/shells/${sleeping.id}`)).json()) as { shell: ShellInfo }
    expect(one.shell.id).toBe(sleeping.id)
    expect((await get(base, `/sessions/${id}/shells/nope`)).status).toBe(404)

    const killed = await fetch(`${base}/sessions/${id}/shells/${sleeping.id}/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer operator' },
    })
    expect(killed.status).toBe(200)
    expect(((await killed.json()) as { shell: ShellInfo }).shell).toMatchObject({ status: 'exited', endReason: 'killed' })
    const row = await waitForExit(collector, 'sleep 30')
    expect(row.text).toContain('[killed]')
    ws.close()
  })

  it('refuses the kill route to a scoped principal', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness)
    const id = await createSession(base, 'alice-a', { cwd: tempDir() })
    const { ws } = await attach(wsBase, id, 'alice-a')
    const res = await fetch(`${base}/sessions/${id}/shells/anything/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-a' },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('shell commands are not available on this session')
    ws.close()
  })

  it('kills the shell when the engine refuses the row', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startShellServer(harness, {
      profiles: [sandboxedProviderProfile('hosted', { id: 'openai-compatible', model: 'test-model' })],
      createEngineRunner: ({ config }) => {
        const runner = fakeRunner('r1', config)
        return {
          ...runner,
          info: () => ({ ...runner.info(), engine: 'provider', capabilities: { ...ENGINE_CAPABILITIES.provider, hostCwd: true } }),
          queueLocalCommand: () => {
            throw new Error('session is closed')
          },
        }
      },
    })
    const id = await createSession(base, 'operator', { profile: 'hosted', cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_command', command: 'sleep 30' }))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('session is closed')
    await vi.waitFor(async () => {
      const listed = (await (await get(base, `/sessions/${id}/shells`)).json()) as { shells: ShellInfo[] }
      expect(listed.shells).toHaveLength(1)
      expect(listed.shells[0]).toMatchObject({ status: 'exited', endReason: 'killed' })
    })
    ws.close()
  })
})
