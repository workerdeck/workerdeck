import { describe, expect, it, vi } from 'vitest'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import { buildClientCommands, type ClientCommandSources } from '../src/components/agent/composer-commands.ts'

function sources(over: Partial<ClientCommandSources> = {}): ClientCommandSources {
  return {
    capabilities: ENGINE_CAPABILITIES.claude,
    hasModels: true,
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    clearContext: vi.fn(),
    openPanel: vi.fn(),
    ...over,
  }
}

function named(built: ReturnType<typeof buildClientCommands>, name: string) {
  const command = built.find((candidate) => candidate.name === name)
  expect(command, name).toBeDefined()
  return command!
}

describe('buildClientCommands', () => {
  it('always offers /status and gates the rest on capabilities', () => {
    const none = buildClientCommands(
      sources({
        hasModels: false,
        capabilities: {
          permissionModes: [],
          clearContext: false,
          mcpStatus: false,
          contextUsage: false,
          rateLimits: false,
          skillsList: false,
        },
      }),
    )
    expect(none.map((command) => command.name)).toEqual(['status'])
  })

  it('routes /model and /permissions, handing back an argument it cannot use', () => {
    const input = sources()
    const built = buildClientCommands(input)
    expect(named(built, 'model').run('')).toBe(false)
    expect(named(built, 'model').run('opus extra')).toBe(true)
    expect(input.setModel).toHaveBeenCalledWith('opus')
    expect(named(built, 'permissions').run('nonsense')).toBe(false)
    const mode = input.capabilities.permissionModes[0]!
    expect(named(built, 'permissions').run(mode)).toBe(true)
    expect(input.setPermissionMode).toHaveBeenCalledWith(mode)
  })

  it('opens panels without reaching the engine', () => {
    const input = sources()
    expect(named(buildClientCommands(input), 'status').run('')).toBe(true)
    expect(input.openPanel).toHaveBeenCalledWith('info')
  })
})

describe('/effort', () => {
  it('is offered only with levels to pick, takes a listed level or default, and refuses the rest', () => {
    expect(buildClientCommands(sources()).some((command) => command.name === 'effort')).toBe(false)
    const setEffort = vi.fn()
    const effort = named(buildClientCommands(sources({ efforts: ['low', 'high'], setEffort })), 'effort')
    expect(effort.run('high')).toBe(true)
    expect(effort.run('default')).toBe(true)
    expect(effort.run('max')).toBe(false)
    expect(setEffort.mock.calls).toEqual([['high'], [undefined]])
  })
})
