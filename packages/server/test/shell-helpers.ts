import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerFrame, SessionInfo, ShellInfo } from '@workerdeck/protocol'
import type { Runner } from '@workerdeck/core'
import { createWorkerServer, type WorkerServer, type WorkerServerOptions } from '../src/index.ts'
import type { ProcessSignal } from '../src/services/process-tree.ts'
import { createShellRegistry, type ShellRegistry, type ShellRegistryOptions } from '../src/services/shells.ts'
import type { PtyChild, PtyModule } from '../src/services/shell-types.ts'
import { fakeRunner, frameCollector, listenOn, type fakeHarness } from './helpers.ts'

type Harness = ReturnType<typeof fakeHarness>

export type Collector = ReturnType<typeof frameCollector>
export type AttachedFrame = Extract<ServerFrame, { type: 'shell_attached' }>
export type DetachedFrame = Extract<ServerFrame, { type: 'shell_detached' }>
export type PtySpawnOptions = Parameters<PtyModule['spawn']>[2]

// A PTY child a test drives by hand: `emit` is a chunk the master read, `exit` is node-pty's exit event, and
// `respond` (when set) answers every write, the way a program reading its input would.
export type ScriptedChild = PtyChild & {
  respond?: (data: string) => void
  readonly file: string
  readonly args: string[]
  readonly options: PtySpawnOptions
  readonly writes: string[]
  readonly sizes: Array<[number, number]>
  readonly kills: Array<string | undefined>
  emit: (data: string) => void
  exit: (exitCode?: number, signal?: number) => void
}

export type ScriptedPty = { module: PtyModule; children: ScriptedChild[]; last: () => ScriptedChild }

export type SentSignal = { pid: number; name: ProcessSignal }

// Far past any kernel's pid_max, so a scripted pid can never name a real process even if a signal escaped the seam.
const SCRIPTED_PID_BASE = 90_000_000

const PRINCIPALS: Record<string, unknown> = {
  operator: {},
  // A non-operator reaches a host (claude) profile only by name, which is what these shell-gating tests need.
  'alice-a': { scope: { space: 'a', user: 'alice' }, allowedProfiles: ['default'] },
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
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
  return { tempDir, startServer, startShellServer, cleanup, server: () => running! }
}

export function scriptedPty(): ScriptedPty {
  const children: ScriptedChild[] = []
  const module: PtyModule = {
    spawn: (file, args, options) => {
      const child = scriptedChild(SCRIPTED_PID_BASE + children.length, file, args, options)
      children.push(child)
      return child
    },
  }
  return { module, children, last: () => children.at(-1)! }
}

function scriptedChild(pid: number, file: string, args: string[], options: PtySpawnOptions): ScriptedChild {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  const writes: string[] = []
  const sizes: Array<[number, number]> = []
  const kills: Array<string | undefined> = []
  const child: ScriptedChild = {
    pid,
    file,
    args,
    options,
    writes,
    sizes,
    kills,
    onData: (listener) => void dataListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    write: (data) => {
      writes.push(data)
      child.respond?.(data)
    },
    resize: (cols, rows) => void sizes.push([cols, rows]),
    kill: (signal) => void kills.push(signal),
    emit: (data) => {
      for (const listener of dataListeners) {
        listener(data)
      }
    },
    exit: (exitCode = 0, signal) => {
      for (const listener of exitListeners) {
        listener(signal === undefined ? { exitCode } : { exitCode, signal })
      }
    },
  }
  return child
}

// The PTY suites are a release gate: on CI a missing native module fails the file instead of skipping it.
export function ptySuite(pty: PtyModule | null, file: string): ReturnType<typeof describe.skipIf> {
  if (pty === null) {
    if (process.env.CI) {
      throw new Error(`${file}: @lydell/node-pty did not load, and CI must not skip the PTY suites`)
    }
    console.warn(`${file}: @lydell/node-pty is not installed for this platform, skipping the PTY suites`)
  }
  return describe.skipIf(pty === null)
}

// Registries and temp dirs for the suites that drive a `ShellRegistry` directly, without a gateway around it.
// `makeScripted` builds one over `pty`, with an empty process table and every tree signal recorded in `signals`.
export function registryFixture(prefix: string) {
  const dirs: string[] = []
  const registries: ShellRegistry[] = []
  const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    dirs.push(dir)
    return dir
  }
  const track = (registry: ShellRegistry): ShellRegistry => {
    registries.push(registry)
    return registry
  }
  const makeRegistry = (overrides: Partial<ShellRegistryOptions> = {}): ShellRegistry =>
    track(createShellRegistry({ generation: 'gen-a', artifactDir: tempDir(), ...overrides }))
  const pty = scriptedPty()
  const signals: SentSignal[] = []
  const makeScripted = (overrides: Partial<ShellRegistryOptions> = {}): ShellRegistry =>
    makeRegistry({ pty: pty.module, processTable: () => [], signal: (pid, name) => void signals.push({ pid, name }), ...overrides })
  const runner = (id: string, cwd = tempDir()): Runner => fakeRunner(id, { cwd })
  const cleanup = async (): Promise<void> => {
    for (const registry of registries.splice(0)) {
      registry.killAll('server_stopped')
      await registry.flush()
    }
    pty.children.length = 0
    signals.length = 0
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
  return { tempDir, track, makeRegistry, makeScripted, pty, signals, runner, cleanup }
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
  ws.send(JSON.stringify({ generation: 1, type: 'shell_command', command }))
  const frame = await collector.waitFor((f) => shellRow(f)?.shell.command === command, 8000)
  return shellRow(frame)!.shell
}

export function sendAttach(ws: WebSocket, shellId: string, cols: number, rows: number): void {
  ws.send(JSON.stringify({ generation: 1, type: 'shell_attach', shellId, cols, rows }))
}

export function sendInput(ws: WebSocket, shellId: string, data: string): void {
  ws.send(JSON.stringify({ generation: 1, type: 'shell_input', shellId, data }))
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
