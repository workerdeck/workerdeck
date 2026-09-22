import { describe, expect, it } from 'vitest'
import { SHELL_READ_DEFAULT_LINES, SHELL_READ_MAX_LINES, type ShellInfo } from '@workerdeck/protocol'
import {
  installShellDirectory,
  runShellTool,
  shellDirectoryHandle,
  shellSummary,
  shellTail,
  shellToolSpecs,
  type ShellDirectory,
} from '../src/index.ts'

function info(overrides: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id: 'sh_a',
    sessionId: 'a',
    ordinal: 3,
    command: 'npm run dev',
    label: 'npm run dev',
    cwd: '/repo',
    owner: 'user',
    status: 'running',
    startedAt: 1,
    bytes: 120,
    cols: 120,
    rows: 40,
    ...overrides,
  }
}

// One shell, owned by session `a`: a read from any other session must fall through the scope check.
function directory(text = 'one\ntwo\nthree\n'): ShellDirectory & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    list: async (from) => {
      calls.push(['list', from])
      return from === 'a' ? [shellSummary(info())] : []
    },
    read: async (from, shellId, options) => {
      calls.push(['read', from, shellId, options])
      if (from !== 'a' || shellId !== 'sh_a') {
        return undefined
      }
      return { shell: shellSummary(info()), ...shellTail(text, options?.tail ?? SHELL_READ_DEFAULT_LINES) }
    },
  }
}

describe('shell tool specs', () => {
  it('describes the two read tools with JSON schemas an engine can declare', () => {
    const specs = shellToolSpecs()
    expect(specs.map((s) => s.name)).toEqual(['shell_list', 'shell_read'])
    const read = specs.find((s) => s.name === 'shell_read')!
    expect(read.inputSchema).toMatchObject({ type: 'object', required: ['shellId'] })
    expect((read.inputSchema.properties as Record<string, unknown>).tail).toMatchObject({ type: 'integer' })
  })
})

describe('runShellTool', () => {
  it('routes each tool to the directory with the caller first', async () => {
    const shells = directory()
    await runShellTool(shells, 'a', 'shell_list', {})
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', tail: 2 })
    expect(shells.calls).toEqual([
      ['list', 'a'],
      ['read', 'a', 'sh_a', { tail: 2 }],
    ])
  })

  it('clamps tail to the default when it is absent and to the max when it is absurd', async () => {
    const shells = directory()
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a' })
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', tail: 100_000 })
    expect(shells.calls).toEqual([
      ['read', 'a', 'sh_a', { tail: SHELL_READ_DEFAULT_LINES }],
      ['read', 'a', 'sh_a', { tail: SHELL_READ_MAX_LINES }],
    ])
  })

  it('names the shell and what it is showing above the tail', async () => {
    const shells = directory('one\ntwo\nthree\n')
    const all = await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a' })
    expect(all.isError).toBe(false)
    expect(all.text).toBe('[shell #3 sh_a: $ npm run dev, still running, showing all 3 lines]\none\ntwo\nthree')
    const some = await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', tail: 2 })
    expect(some.text).toBe('[shell #3 sh_a: $ npm run dev, still running, showing the last 2 of 3 lines]\ntwo\nthree')
  })

  it("reads another session's shell id as missing, never as a refusal that would name it", async () => {
    const shells = directory()
    const mine = await runShellTool(shells, 'b', 'shell_read', { shellId: 'sh_a' })
    expect(mine).toEqual({ text: 'no such shell: sh_a', isError: true })
    const listed = await runShellTool(shells, 'b', 'shell_list', {})
    expect(listed).toEqual({ text: 'No shell commands have run in this session.', isError: false })
  })

  it('refuses an unknown tool name and invalid arguments without reaching the directory', async () => {
    const shells = directory()
    expect(await runShellTool(shells, 'a', 'shell_write', { data: 'y' })).toEqual({
      text: 'unknown shell tool: shell_write',
      isError: true,
    })
    const bad = await runShellTool(shells, 'a', 'shell_read', {})
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('invalid arguments for shell_read')
    expect(shells.calls).toEqual([])
  })

  it('returns a thrown directory error as the tool result', async () => {
    const shells: ShellDirectory = {
      list: async () => {
        throw new Error('shell commands are not available on this session')
      },
      read: async () => undefined,
    }
    expect(await runShellTool(shells, 'a', 'shell_list', {})).toEqual({
      text: 'shell commands are not available on this session',
      isError: true,
    })
  })
})

describe('shellTail', () => {
  it('counts the text view in lines, ignoring the trailing newline', () => {
    expect(shellTail('a\nb\nc\n', 2)).toEqual({ text: 'b\nc', lines: 2, totalLines: 3, truncated: true })
    expect(shellTail('a\nb\nc', 9)).toEqual({ text: 'a\nb\nc', lines: 3, totalLines: 3, truncated: false })
    expect(shellTail('', 9)).toEqual({ text: '', lines: 0, totalLines: 0, truncated: false })
  })
})

describe('shellDirectoryHandle', () => {
  it('resolves the installed directory per call and refuses with one string when there is none', async () => {
    const handle = shellDirectoryHandle()
    installShellDirectory(undefined)
    await expect(handle.list('a')).rejects.toThrow('shell commands are not available on this session')
    installShellDirectory(directory())
    await expect(handle.list('a')).resolves.toHaveLength(1)
    installShellDirectory(undefined)
  })
})
