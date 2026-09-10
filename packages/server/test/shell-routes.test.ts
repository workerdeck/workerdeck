import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ENGINE_CAPABILITIES, SHELL_COMMAND_MAX, type ServerFrame, type SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, sandboxedProviderProfile, type WorkerServer, type WorkerServerOptions } from '../src/index.ts'
import { fakeHarness, fakeRunner, frameCollector, listenOn } from './helpers.ts'

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

function localOutput(frame: ServerFrame): string | undefined {
  if (frame.type !== 'event' || frame.event.type !== 'user_message' || !frame.event.synthetic) {
    return undefined
  }
  const content = frame.event.message.content
  return typeof content === 'string' ? content : undefined
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

  it('runs in the session cwd for an operator, lands in the transcript, and rides the next message into the model', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness, { shell: { enabled: true } })
    const cwd = tempDir()
    const id = await createSession(base, 'operator', { cwd })
    const { ws, collector, attached } = await attach(wsBase, id, 'operator')
    expect(attached.shell).toBe(true)

    ws.send(JSON.stringify({ type: 'shell_command', command: 'pwd; echo done' }))
    const output = await collector.waitFor((f) => localOutput(f) !== undefined)
    expect(localOutput(output)).toBe(`<local-command-stdout>$ pwd; echo done\n${cwd}\ndone</local-command-stdout>`)
    expect(harness.captured.inputs).toHaveLength(0)

    ws.send(JSON.stringify({ type: 'user_message', text: 'what did it print?' }))
    await vi.waitFor(() => expect(harness.captured.inputs).toHaveLength(1))
    const content = harness.captured.inputs[0]!.message.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.text.startsWith('<local-command-caveat>')).toBe(true)
    expect(content[0]!.text.endsWith(`<local-command-stdout>$ pwd; echo done\n${cwd}\ndone</local-command-stdout>`)).toBe(true)
    expect(content[1]).toEqual({ type: 'text', text: 'what did it print?' })
    const typed = await collector.waitFor((f) => f.type === 'event' && f.event.type === 'user_message' && !f.event.synthetic)
    expect(typed.type === 'event' && typed.event.type === 'user_message' && typed.event.message.content).toBe('what did it print?')
    ws.close()
  })

  it('frames a failing command as stderr with its exit code', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness, { shell: { enabled: true } })
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_command', command: 'echo bad >&2; exit 2' }))
    const output = await collector.waitFor((f) => localOutput(f) !== undefined)
    expect(localOutput(output)).toBe('<local-command-stderr>$ echo bad >&2; exit 2\nbad\n[exit 2]</local-command-stderr>')
    ws.close()
  })

  it('refuses a scoped principal even with the shell enabled', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness, { shell: { enabled: true } })
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
    const { base, wsBase } = await startServer(harness, {
      shell: { enabled: true },
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
    const { base, wsBase } = await startServer(harness, { shell: { enabled: true } })
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

  it('enforces the output cap and the timeout from the server options', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness, { shell: { enabled: true, timeoutMs: 200, maxOutputBytes: 50 } })
    const id = await createSession(base, 'operator', { cwd: tempDir() })
    const { ws, collector } = await attach(wsBase, id, 'operator')

    ws.send(JSON.stringify({ type: 'shell_command', command: 'head -c 200 /dev/zero | tr "\\0" a' }))
    const capped = await collector.waitFor((f) => localOutput(f) !== undefined)
    expect(localOutput(capped)).toBe(
      `<local-command-stdout>$ head -c 200 /dev/zero | tr "\\0" a\n${'a'.repeat(50)}\n[output truncated: 150 more bytes dropped]</local-command-stdout>`,
    )

    ws.send(JSON.stringify({ type: 'shell_command', command: 'sleep 5' }))
    const timedOut = await collector.waitFor((f) => localOutput(f)?.includes('sleep 5') === true)
    expect(localOutput(timedOut)).toBe('<local-command-stderr>$ sleep 5\n[killed: timed out after 0s]\n[exit 124]</local-command-stderr>')
    ws.close()
  })
})
