import { describe, expect, it } from 'vitest'
import { bunRuntime, createBunPty } from '../src/services/bun-pty.ts'

function fakeBun() {
  const calls: { cmd: string[]; options: any; writes: string[]; resizes: [number, number][]; kills: unknown[] }[] = []
  let finish: (code: number) => void = () => {}
  let signalCode: string | null = null
  let feed: (text: string) => void = () => {}
  const runtime = {
    spawn: (cmd: string[], options: any) => {
      const call = { cmd, options, writes: [] as string[], resizes: [] as [number, number][], kills: [] as unknown[] }
      calls.push(call)
      const terminal = {
        write: (d: string) => call.writes.push(d),
        resize: (c: number, r: number) => call.resizes.push([c, r]),
        close: () => {},
      }
      feed = (text) => options.terminal.data(terminal, new TextEncoder().encode(text))
      return {
        pid: 42,
        exited: new Promise<number>((resolve) => (finish = resolve)),
        get signalCode() {
          return signalCode
        },
        terminal,
        kill: (s: unknown) => call.kills.push(s),
      }
    },
  }
  return {
    runtime,
    calls,
    feed: (t: string) => feed(t),
    exit: (code: number, signal: string | null = null) => {
      signalCode = signal
      finish(code)
    },
  }
}

const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: '/tmp', env: { A: '1' } }

describe('createBunPty', () => {
  it('passes the command, size and env to Bun.spawn', () => {
    const bun = fakeBun()
    createBunPty(bun.runtime).spawn('/bin/echo', ['hi'], opts)
    expect(bun.calls[0]!.cmd).toEqual(['/bin/echo', 'hi'])
    expect(bun.calls[0]!.options).toMatchObject({ cwd: '/tmp', env: { A: '1' }, terminal: { cols: 100, rows: 30 } })
  })

  it('holds output that arrives before the first listener', () => {
    const bun = fakeBun()
    const child = createBunPty(bun.runtime).spawn('/bin/sh', [], opts)
    bun.feed('early ')
    const seen: string[] = []
    child.onData((d) => seen.push(d))
    bun.feed('late')
    expect(seen.join('')).toBe('early late')
  })

  it('reports exit with the signal number and stops writing after it', async () => {
    const bun = fakeBun()
    const child = createBunPty(bun.runtime).spawn('/bin/sh', [], opts)
    const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => child.onExit(resolve))
    child.write('x')
    child.resize(80, 24)
    child.kill()
    bun.exit(129, 'SIGHUP')
    expect(await exited).toEqual({ exitCode: 129, signal: 1 })
    child.write('y')
    expect(bun.calls[0]!.writes).toEqual(['x'])
    expect(bun.calls[0]!.resizes).toEqual([[80, 24]])
    expect(bun.calls[0]!.kills).toEqual(['SIGHUP'])
  })

  it('is not used under Node', () => {
    expect(bunRuntime()).toBeUndefined()
  })
})
