import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerFrame, SessionInfo, ShellInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer, type WorkerServerOptions } from '../src/index.ts'
import { frameCollector, listenOn, type fakeHarness } from './helpers.ts'

type Harness = ReturnType<typeof fakeHarness>

export type Collector = ReturnType<typeof frameCollector>
export type AttachedFrame = Extract<ServerFrame, { type: 'shell_attached' }>
export type DetachedFrame = Extract<ServerFrame, { type: 'shell_detached' }>

const PRINCIPALS: Record<string, unknown> = {
  operator: {},
  'alice-a': { scope: { space: 'a', user: 'alice' } },
}

// One gateway per test, torn down by `cleanup`. `server()` reaches the live instance so a test can read the shell
// record behind the socket it is exercising.
export function shellFixture(prefix: string) {
  let running: WorkerServer | undefined
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    dirs.push(dir)
    return dir
  }
  const startServer = async (harness: Harness, extra: Partial<WorkerServerOptions> = {}) => {
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
  const startShellServer = (harness: Harness, extra: Partial<WorkerServerOptions> = {}) =>
    startServer(harness, { shell: { enabled: true, artifactDir: tempDir() }, ...extra })
  const cleanup = async () => {
    await running?.close()
    running = undefined
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  }
  return { tempDir, startServer, startShellServer, cleanup, server: () => running! }
}

export async function createSession(base: string, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session.id
}

export async function attachSocket(wsBase: string, id: string, token: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?key=${token}`)
  const upgraded = new Promise<number>((resolve) => ws.once('upgrade', (res) => resolve(res.socket.localPort ?? 0)))
  const collector = frameCollector(ws)
  const attached = (await collector.waitFor((f) => f.type === 'attached')) as Extract<ServerFrame, { type: 'attached' }>
  return { ws, collector, attached, localPort: await upgraded }
}

export async function get(base: string, path: string, token = 'operator') {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

export function isError(frame: ServerFrame): frame is Extract<ServerFrame, { type: 'protocol_error' }> {
  return frame.type === 'protocol_error'
}

export function shellRow(frame: ServerFrame): { text: string; shell: ShellInfo } | undefined {
  if (frame.type !== 'event' || frame.event.type !== 'user_message' || !frame.event.synthetic || !frame.event.shell) {
    return undefined
  }
  const content = frame.event.message.content
  return typeof content === 'string' ? { text: content, shell: frame.event.shell } : undefined
}

export async function waitForExit(collector: Collector, command: string) {
  const frame = await collector.waitFor((f) => {
    const row = shellRow(f)
    return row?.shell.command === command && row.shell.status === 'exited'
  }, 8000)
  return shellRow(frame)!
}

export async function spawnShell(ws: WebSocket, collector: Collector, command: string): Promise<ShellInfo> {
  ws.send(JSON.stringify({ type: 'shell_command', command }))
  const frame = await collector.waitFor((f) => shellRow(f)?.shell.command === command, 8000)
  return shellRow(frame)!.shell
}

export function sendAttach(ws: WebSocket, shellId: string, cols: number, rows: number): void {
  ws.send(JSON.stringify({ type: 'shell_attach', shellId, cols, rows }))
}

export function sendInput(ws: WebSocket, shellId: string, data: string): void {
  ws.send(JSON.stringify({ type: 'shell_input', shellId, data }))
}

export function shellFrames(collector: Collector, shellId: string): ServerFrame[] {
  return collector.frames.filter((f) => 'shellId' in f && f.shellId === shellId)
}

export function outputOf(collector: Collector, shellId: string): string {
  return collector.frames
    .filter((f) => f.type === 'shell_output' && f.shellId === shellId)
    .map((f) => (f as Extract<ServerFrame, { type: 'shell_output' }>).data)
    .join('')
}

export async function waitForAttached(collector: Collector, shellId: string, after = 0): Promise<AttachedFrame> {
  await vi.waitFor(() => expect(attachedFrames(collector, shellId).length).toBeGreaterThan(after), { timeout: 4000 })
  return attachedFrames(collector, shellId)[after]!
}

export function attachedFrames(collector: Collector, shellId: string): AttachedFrame[] {
  return collector.frames.filter((f): f is AttachedFrame => f.type === 'shell_attached' && f.shellId === shellId)
}

export function detachedFrames(collector: Collector, shellId: string): DetachedFrame[] {
  return collector.frames.filter((f): f is DetachedFrame => f.type === 'shell_detached' && f.shellId === shellId)
}

export async function waitForDetached(collector: Collector, shellId: string, timeout = 8000): Promise<DetachedFrame> {
  const frame = await collector.waitFor((f) => f.type === 'shell_detached' && f.shellId === shellId, timeout)
  return frame as DetachedFrame
}

export async function waitForOutput(collector: Collector, shellId: string, needle: string, timeout = 4000): Promise<string> {
  await vi.waitFor(() => expect(outputOf(collector, shellId)).toContain(needle), { timeout })
  return outputOf(collector, shellId)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
