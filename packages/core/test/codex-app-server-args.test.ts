import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

const { connectAppServer } = await import('../src/engines/codex/process.ts')

function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  return proc
}

describe('connectAppServer: the app-server gates', () => {
  beforeEach(() => {
    spawn.mockReset()
    spawn.mockImplementation(() => child())
  })

  it('opens request_user_input with both of its gates, so AskUserQuestion reaches the model', () => {
    connectAppServer({ executable: '/usr/local/bin/codex', env: { PATH: '/usr/bin' } })
    const [executable, args] = spawn.mock.calls[0] as [string, string[]]
    expect(executable).toBe('/usr/local/bin/codex')
    expect(args[0]).toBe('app-server')
    expect(args).toContain('tools.experimental_request_user_input.enabled=true')
    expect(args).toContain('features.default_mode_request_user_input=true')
    // Every override is introduced by its own `-c`; a bare key would be read as a subcommand.
    for (const [index, arg] of args.entries()) {
      if (arg.includes('=')) {
        expect(args[index - 1]).toBe('-c')
      }
    }
  })

  it('never passes --strict-config, so an older codex that knows neither gate still starts', () => {
    connectAppServer({ executable: 'codex', env: {} })
    expect(spawn.mock.calls[0]![1]).not.toContain('--strict-config')
  })
})
