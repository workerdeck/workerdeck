import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHELL_INPUT_MAX, SHELL_MAX_COLS, SHELL_MIN_ROWS } from '@workerdeck/protocol'
import { SHELL_DETACHED_BACKPRESSURE, SHELL_SOCKET_BUFFERED_MAX } from '../src/routes/ws.ts'
import { loadPty, SHELL_REFUSAL } from '../src/services/shells.ts'
import { fakeHarness } from './helpers.ts'
import {
  attachedFrames,
  attachSocket,
  createSession,
  detachedFrames,
  isError,
  outputOf,
  sendAttach,
  sendInput,
  shellFixture,
  shellFrames,
  sleep,
  spawnShell,
  waitForAttached,
  waitForDetached,
  waitForExit,
  waitForOutput,
} from './shell-helpers.ts'

const pty = await loadPty()
if (pty === null) {
  console.warn('shell-attach.test: @lydell/node-pty is not installed for this platform, skipping the PTY suites')
}
const withPty = describe.skipIf(pty === null)

const fx = shellFixture('wd-shell-attach-')
const serverSockets: Socket[] = []
afterEach(async () => {
  serverSockets.length = 0
  await fx.cleanup()
})

// The gateway's end of the client's TCP connection. Corking it keeps every write in the socket's own buffer, which is
// what ws reports as bufferedAmount, so a stalled peer can be staged without depending on the kernel's buffer sizes.
function serverSocketOf(localPort: number): Socket {
  const match = serverSockets.find((socket) => socket.remotePort === localPort)
  if (!match) {
    throw new Error('server socket not found')
  }
  return match
}

async function operatorSession() {
  const { base, wsBase } = await fx.startShellServer(fakeHarness())
  fx.server().server.on('connection', (socket: Socket) => serverSockets.push(socket))
  const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
  const socket = await attachSocket(wsBase, id, 'operator')
  return { base, wsBase, id, ...socket }
}

describe('shell_attach gating', () => {
  it('refuses attach, input and resize to a scoped principal with the one string', async () => {
    const { base, wsBase } = await fx.startShellServer(fakeHarness())
    const id = await createSession(base, 'alice-a', { cwd: fx.tempDir() })
    const { ws, collector } = await attachSocket(wsBase, id, 'alice-a')
    sendAttach(ws, 'sh_x', 80, 24)
    sendInput(ws, 'sh_x', 'x')
    ws.send(JSON.stringify({ type: 'shell_resize', shellId: 'sh_x', cols: 80, rows: 24 }))
    await vi.waitFor(() => expect(collector.frames.filter(isError)).toHaveLength(3))
    expect(collector.frames.filter(isError).map((f) => f.message)).toEqual([SHELL_REFUSAL, SHELL_REFUSAL, SHELL_REFUSAL])
    expect(collector.frames.some((f) => f.type === 'shell_attached')).toBe(false)
    ws.close()
  })

  it('refuses them the same way when the server has no shell', async () => {
    const { base, wsBase } = await fx.startServer(fakeHarness())
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    const { ws, collector } = await attachSocket(wsBase, id, 'operator')
    sendAttach(ws, 'sh_x', 80, 24)
    sendInput(ws, 'sh_x', 'x')
    await vi.waitFor(() => expect(collector.frames.filter(isError)).toHaveLength(2))
    expect(collector.frames.filter(isError).map((f) => f.message)).toEqual([SHELL_REFUSAL, SHELL_REFUSAL])
    ws.close()
  })

  it('ignores a detach for a shell the socket never attached', async () => {
    const { base, wsBase } = await fx.startServer(fakeHarness())
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    const { ws, collector } = await attachSocket(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'shell_detach', shellId: 'sh_x' }))
    ws.send(JSON.stringify({ type: 'nonsense' }))
    await collector.waitFor(isError)
    expect(collector.frames.filter(isError).map((f) => f.message)).toEqual(['unknown command: nonsense'])
    ws.close()
  })
})

withPty('shell_attach', () => {
  it('replays the scrollback, streams what follows, reports the exit, and logs none of it', async () => {
    const { wsBase, id, ws, collector } = await operatorSession()
    const command = 'echo first; sleep 0.5; echo second'
    const shell = await spawnShell(ws, collector, command)
    await vi.waitFor(async () => {
      await expect(fx.server().shells!.output(id, shell.id, { view: 'raw' })).resolves.toContain('first')
    })
    sendAttach(ws, shell.id, 100, 30)
    const attached = await waitForAttached(collector, shell.id)
    expect(attached.scrollback).toBe('first\r\n')
    expect(attached.shell).toMatchObject({ id: shell.id, status: 'running', cols: 100, rows: 30 })
    expect(attached).toMatchObject({ cols: 100, rows: 30 })

    const detached = await waitForDetached(collector, shell.id)
    expect(detached.reason).toBe('exit')
    expect(outputOf(collector, shell.id)).toBe('second\r\n')
    const types = shellFrames(collector, shell.id).map((f) => f.type)
    expect(types[0]).toBe('shell_attached')
    expect(types.at(-1)).toBe('shell_detached')
    expect(types.filter((t) => t === 'shell_detached')).toHaveLength(1)
    const row = await waitForExit(collector, command)
    expect(row.text).toContain('first\nsecond')

    const fresh = await attachSocket(wsBase, id, 'operator')
    await waitForExit(fresh.collector, command)
    expect(fresh.collector.frames.every((f) => f.type === 'attached' || f.type === 'event')).toBe(true)
    expect(JSON.stringify(fresh.collector.frames)).not.toContain('shell_output')
    fresh.ws.close()
    ws.close()
  })

  it('attaches to an exited shell with its scrollback and record, sends no detach, and refuses input', async () => {
    const { ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'echo done; exit 3')
    await waitForExit(collector, 'echo done; exit 3')
    sendAttach(ws, shell.id, 80, 24)
    const attached = await waitForAttached(collector, shell.id)
    expect(attached.scrollback).toContain('done\r\n')
    expect(attached.shell).toMatchObject({ status: 'exited', exitCode: 3, endReason: 'exit', cols: 120, rows: 40 })
    expect(attached).toMatchObject({ cols: 120, rows: 40 })
    sendInput(ws, shell.id, 'x')
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe('the shell has exited')
    await sleep(150)
    expect(shellFrames(collector, shell.id).map((f) => f.type)).toEqual(['shell_attached'])
    ws.close()
  })

  it('carries input to the PTY and echoes it to every attached socket', async () => {
    const { wsBase, id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'read -r name; echo "hi $name"')
    const other = await attachSocket(wsBase, id, 'operator')
    sendAttach(ws, shell.id, 80, 24)
    sendAttach(other.ws, shell.id, 80, 24)
    await waitForAttached(collector, shell.id)
    await waitForAttached(other.collector, shell.id)

    sendInput(ws, shell.id, 'bob\r')
    const mine = await waitForOutput(collector, shell.id, 'hi bob')
    const theirs = await waitForOutput(other.collector, shell.id, 'hi bob')
    expect(mine).toBe('bob\r\nhi bob\r\n')
    expect(theirs).toBe(mine)
    expect((await waitForDetached(collector, shell.id)).reason).toBe('exit')
    expect((await waitForDetached(other.collector, shell.id)).reason).toBe('exit')
    other.ws.close()
    ws.close()
  })

  it('bounds input at SHELL_INPUT_MAX without touching the shell', async () => {
    const { id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'read -r line; echo "got $line"')
    sendAttach(ws, shell.id, 80, 24)
    await waitForAttached(collector, shell.id)
    sendInput(ws, shell.id, 'x'.repeat(SHELL_INPUT_MAX + 1))
    const error = await collector.waitFor(isError)
    expect(isError(error) && error.message).toBe(`shell input must be a string of at most ${SHELL_INPUT_MAX} characters`)
    expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ status: 'running' })
    sendInput(ws, shell.id, 'ok\r')
    await waitForOutput(collector, shell.id, 'got ok')
    expect((await waitForDetached(collector, shell.id)).reason).toBe('exit')
    ws.close()
  })

  it('clamps the size, lets the last attach win it, and applies a resize to the PTY', async () => {
    const { wsBase, id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'read -r a; stty size; read -r b; stty size')
    const other = await attachSocket(wsBase, id, 'operator')
    sendAttach(ws, shell.id, 5000, 0)
    const first = await waitForAttached(collector, shell.id)
    expect(first).toMatchObject({ cols: SHELL_MAX_COLS, rows: SHELL_MIN_ROWS })
    expect(first.shell).toMatchObject({ cols: SHELL_MAX_COLS, rows: SHELL_MIN_ROWS })

    sendAttach(other.ws, shell.id, 80, 24)
    const second = await waitForAttached(other.collector, shell.id)
    expect(second).toMatchObject({ cols: 80, rows: 24 })
    expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ cols: 80, rows: 24 })
    sendInput(ws, shell.id, 'x\r')
    await waitForOutput(collector, shell.id, '24 80')
    await waitForOutput(other.collector, shell.id, '24 80')

    ws.send(JSON.stringify({ type: 'shell_resize', shellId: shell.id, cols: 100, rows: 30 }))
    await vi.waitFor(() => expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ cols: 100, rows: 30 }))
    sendInput(other.ws, shell.id, 'y\r')
    await waitForOutput(collector, shell.id, '30 100')
    await waitForOutput(other.collector, shell.id, '30 100')
    expect(outputOf(other.collector, shell.id)).toBe(outputOf(collector, shell.id))
    await waitForDetached(collector, shell.id)
    await waitForDetached(other.collector, shell.id)
    other.ws.close()
    ws.close()
  })

  it('detaches on socket close and leaves the shell running', async () => {
    const { wsBase, id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'read -r a; echo "after $a"')
    const other = await attachSocket(wsBase, id, 'operator')
    sendAttach(ws, shell.id, 80, 24)
    sendAttach(other.ws, shell.id, 80, 24)
    await waitForAttached(collector, shell.id)
    await waitForAttached(other.collector, shell.id)

    ws.close()
    await new Promise<void>((resolve) => ws.once('close', () => resolve()))
    await sleep(100)
    expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ status: 'running' })

    sendInput(other.ws, shell.id, 'close\r')
    await waitForOutput(other.collector, shell.id, 'after close')
    expect((await waitForDetached(other.collector, shell.id)).reason).toBe('exit')
    expect(detachedFrames(collector, shell.id)).toHaveLength(0)
    other.ws.close()
  })

  it('reports a kill to every attached socket as its reason', async () => {
    const { wsBase, id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'sleep 30')
    const other = await attachSocket(wsBase, id, 'operator')
    sendAttach(ws, shell.id, 80, 24)
    sendAttach(other.ws, shell.id, 80, 24)
    await waitForAttached(collector, shell.id)
    await waitForAttached(other.collector, shell.id)
    other.ws.close()
    await new Promise<void>((resolve) => other.ws.once('close', () => resolve()))
    await sleep(50)
    expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ status: 'running' })

    expect(fx.server().shells!.kill(id, shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect((await waitForDetached(collector, shell.id)).reason).toBe('killed')
    expect(detachedFrames(other.collector, shell.id)).toHaveLength(0)
    ws.close()
  })

  it('stops streaming on detach, and a second attach on one socket replaces the first', async () => {
    const { id, ws, collector } = await operatorSession()
    const shell = await spawnShell(ws, collector, 'read -r a; echo one; read -r b; echo two')
    sendAttach(ws, shell.id, 80, 24)
    expect(await waitForAttached(collector, shell.id)).toMatchObject({ cols: 80, rows: 24 })
    sendAttach(ws, shell.id, 90, 25)
    expect(await waitForAttached(collector, shell.id, 1)).toMatchObject({ cols: 90, rows: 25 })
    expect(attachedFrames(collector, shell.id)).toHaveLength(2)
    sendInput(ws, shell.id, 'x\r')
    const seen = await waitForOutput(collector, shell.id, 'one')
    expect(seen.split('one')).toHaveLength(2)

    ws.send(JSON.stringify({ type: 'shell_detach', shellId: shell.id }))
    ws.send(JSON.stringify({ type: 'shell_detach', shellId: shell.id }))
    await sleep(50)
    sendInput(ws, shell.id, 'y\r')
    await waitForExit(collector, 'read -r a; echo one; read -r b; echo two')
    await expect(fx.server().shells!.output(id, shell.id, { view: 'text' })).resolves.toContain('two')
    expect(outputOf(collector, shell.id)).not.toContain('two')
    expect(detachedFrames(collector, shell.id)).toHaveLength(0)
    ws.close()
  })

  it('detaches a socket whose outbound buffer passes the bound instead of growing the heap', async () => {
    const { id, ws, collector, localPort } = await operatorSession()
    const serverSide = serverSocketOf(localPort)
    const total = 2 * SHELL_SOCKET_BUFFERED_MAX
    const shell = await spawnShell(ws, collector, `read -r go; head -c ${total} /dev/zero | tr "\\0" a | fold -w 100`)
    sendAttach(ws, shell.id, 80, 24)
    await waitForAttached(collector, shell.id)

    serverSide.cork()
    sendInput(ws, shell.id, 'go\r')
    await vi.waitFor(() => expect(fx.server().shells!.get(id, shell.id)?.status).toBe('exited'), { timeout: 20_000, interval: 100 })
    serverSide.uncork()

    const detached = await waitForDetached(collector, shell.id, 20_000)
    expect(detached.reason).toBe(SHELL_DETACHED_BACKPRESSURE)
    expect(fx.server().shells!.get(id, shell.id)).toMatchObject({ status: 'exited', endReason: 'exit', exitCode: 0 })
    expect(fx.server().shells!.get(id, shell.id)!.bytes).toBeGreaterThanOrEqual(total)
    const received = outputOf(collector, shell.id).length
    expect(received).toBeGreaterThan(SHELL_SOCKET_BUFFERED_MAX / 2)
    expect(received).toBeLessThan(total)
    const frames = shellFrames(collector, shell.id)
    expect(frames.at(-1)).toBe(detached)
    expect(frames.filter((f) => f.type === 'shell_detached')).toHaveLength(1)
    ws.close()
  }, 30_000)
})
