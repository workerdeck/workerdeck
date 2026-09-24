import { describe, expect, it } from 'vitest'
import { SHELL_READ_DEFAULT_LINES, SHELL_READ_MAX_LINES, type ShellInfo } from '@workerdeck/protocol'
import {
  SHELL_WRITE_REFUSAL,
  agentMayWrite,
  encodeShellKey,
  encodeShellKeys,
  installShellDirectory,
  runShellTool,
  shellDirectoryHandle,
  shellOwnershipRefusal,
  shellSummary,
  shellTail,
  shellToolNames,
  shellToolNeedsCard,
  shellToolSpecs,
  shellWriteToolOf,
  type ShellDirectory,
  type ShellReadResult,
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

function readResult(text: string, tail = SHELL_READ_DEFAULT_LINES, overrides: Partial<ShellInfo> = {}): ShellReadResult {
  return { shell: shellSummary(info(overrides)), ...shellTail(text, tail) }
}

// One shell, owned by session `a`: a read from any other session must fall through the scope check. Every write
// method records its call and answers as the server would for an agent-owned shell.
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
      return readResult(text, options?.tail ?? SHELL_READ_DEFAULT_LINES)
    },
    run: async (from, options) => {
      calls.push(['run', from, options])
      return {
        ...readResult('starting\n', SHELL_READ_DEFAULT_LINES, { id: 'sh_new', ordinal: 4, owner: 'agent', command: options.command }),
        ...(options.waitFor ? { wait: { outcome: 'matched' as const, match: options.waitFor[0], ms: 800 } } : {}),
      }
    },
    write: async (from, shellId, options) => {
      calls.push(['write', from, shellId, options])
      if (from !== 'a' || shellId !== 'sh_a') {
        return undefined
      }
      return readResult('one\ntwo\nthree\nreloaded\n', SHELL_READ_DEFAULT_LINES, { owner: 'agent' })
    },
    kill: async (from, shellId) => {
      calls.push(['kill', from, shellId])
      if (from !== 'a' || shellId !== 'sh_a') {
        return undefined
      }
      return { shell: shellSummary(info({ owner: 'agent', status: 'exited', endReason: 'killed' })), killed: true }
    },
    grant: async (from, shellId) => {
      calls.push(['grant', from, shellId])
      if (from !== 'a' || shellId !== 'sh_a') {
        return undefined
      }
      return shellSummary(info({ agentWrite: true }))
    },
  }
}

describe('shell tool specs', () => {
  it('describes the two read tools by default and all six when the agent may write', () => {
    expect(shellToolSpecs().map((s) => s.name)).toEqual(['shell_list', 'shell_read'])
    expect(shellToolNames(false)).toEqual(['shell_list', 'shell_read'])
    expect(shellToolNames(true)).toEqual(['shell_list', 'shell_read', 'shell_run', 'shell_write', 'shell_kill', 'shell_request_write'])
    const specs = shellToolSpecs(true)
    expect(specs.map((s) => s.name)).toEqual(['shell_list', 'shell_read', 'shell_run', 'shell_write', 'shell_kill', 'shell_request_write'])
    const read = specs.find((s) => s.name === 'shell_read')!
    expect(read.inputSchema).toMatchObject({ type: 'object', required: ['shellId'] })
    expect((read.inputSchema.properties as Record<string, unknown>).tail).toMatchObject({ type: 'integer' })
    const run = specs.find((s) => s.name === 'shell_run')!
    expect(run.inputSchema).toMatchObject({ type: 'object', required: ['command'] })
    const write = specs.find((s) => s.name === 'shell_write')!
    expect(write.inputSchema).toMatchObject({ type: 'object', required: ['shellId'] })
    expect(Object.keys(write.inputSchema.properties as Record<string, unknown>)).toEqual([
      'shellId',
      'data',
      'keys',
      'waitFor',
      'timeoutMs',
    ])
  })

  it('recognises a write tool under its bare name and under the claude MCP prefix', () => {
    expect(shellWriteToolOf('shell_run')).toBe('shell_run')
    expect(shellWriteToolOf('mcp__workerdeck__shell_write')).toBe('shell_write')
    expect(shellWriteToolOf('mcp__workerdeck__shell_read')).toBeUndefined()
    expect(shellWriteToolOf('Bash')).toBeUndefined()
  })
})

describe('encodeShellKeys', () => {
  it('encodes the named keys to what a terminal sends, and a single character to itself', () => {
    expect(encodeShellKeys(['enter', 'tab', 'escape', 'backspace', 'space'])).toBe('\r\t\x1b\x7f ')
    expect(encodeShellKeys(['up', 'down', 'right', 'left', 'home', 'end'])).toBe('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F')
    expect(encodeShellKeys(['pageup', 'pagedown', 'delete', 'insert', 'shift-tab'])).toBe('\x1b[5~\x1b[6~\x1b[3~\x1b[2~\x1b[Z')
    expect(encodeShellKeys(['f1', 'f5', 'f12'])).toBe('\x1bOP\x1b[15~\x1b[24~')
    expect(encodeShellKeys(['ctrl-a', 'ctrl-c', 'ctrl-z', 'Ctrl+D', 'control-l', 'C-x'])).toBe('\x01\x03\x1a\x04\x0c\x18')
    expect(encodeShellKeys(['r', 'R', 'q', '?', 'é', '中'])).toBe('rRq?é中')
    expect(encodeShellKeys(['Enter', 'RETURN', 'Esc'])).toBe('\r\r\x1b')
  })

  it('switches the cursor keys to SS3 under application cursor mode and leaves the rest alone', () => {
    expect(encodeShellKeys(['up', 'left', 'home', 'end'], { applicationCursorKeys: true })).toBe('\x1bOA\x1bOD\x1bOH\x1bOF')
    expect(encodeShellKeys(['enter', 'pageup', 'f1'], { applicationCursorKeys: true })).toBe('\r\x1b[5~\x1bOP')
  })

  it('refuses a name it does not know, a control character and ctrl with more than a letter', () => {
    expect(encodeShellKey('shrug')).toBeUndefined()
    expect(encodeShellKey('\x03')).toBeUndefined()
    expect(encodeShellKey('ctrl-shift-c')).toBeUndefined()
    expect(encodeShellKey('ctrl-1')).toBeUndefined()
    expect(() => encodeShellKeys(['enter', 'shrug'])).toThrow(/unknown key "shrug"; use one of enter, tab/)
  })
})

describe('agentMayWrite', () => {
  it('lets the agent drive its own shell or one the user granted, in its own session only', () => {
    expect(agentMayWrite(info({ owner: 'agent' }), 'a')).toBe(true)
    expect(agentMayWrite(info({ owner: 'user' }), 'a')).toBe(false)
    expect(agentMayWrite(info({ owner: 'user', agentWrite: true }), 'a')).toBe(true)
    expect(agentMayWrite(info({ owner: 'agent' }), 'b')).toBe(false)
    expect(shellOwnershipRefusal('sh_a')).toBe(
      'shell sh_a was started by the user; the agent may only type into or kill shells it started, or one the user granted through shell_request_write',
    )
  })
})

describe('runShellTool', () => {
  it('routes each tool to the directory with the caller first', async () => {
    const shells = directory()
    await runShellTool(shells, 'a', 'shell_list', {})
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', tail: 2 })
    await runShellTool(shells, 'a', 'shell_run', { command: 'npm run dev', waitFor: 'ready in', timeoutMs: 5000 }, { write: true })
    await runShellTool(shells, 'a', 'shell_write', { shellId: 'sh_a', data: 'hello', keys: ['enter'] }, { write: true })
    await runShellTool(shells, 'a', 'shell_kill', { shellId: 'sh_a' }, { write: true })
    expect(shells.calls).toEqual([
      ['list', 'a'],
      ['read', 'a', 'sh_a', { tail: 2 }],
      ['run', 'a', { command: 'npm run dev', waitFor: ['ready in'], timeoutMs: 5000 }],
      ['write', 'a', 'sh_a', { data: 'hello', keys: ['enter'] }],
      ['kill', 'a', 'sh_a'],
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

  it('passes the view and the wait through, a single waitFor as a list of one', async () => {
    const shells = directory()
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', view: 'screen', waitFor: 'ready', timeoutMs: 500 })
    await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', waitFor: ['ready', 'error'] })
    expect(shells.calls).toEqual([
      ['read', 'a', 'sh_a', { tail: SHELL_READ_DEFAULT_LINES, view: 'screen', waitFor: ['ready'], timeoutMs: 500 }],
      ['read', 'a', 'sh_a', { tail: SHELL_READ_DEFAULT_LINES, waitFor: ['ready', 'error'] }],
    ])
    const bad = await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', waitFor: '', timeoutMs: 10_000_000 })
    expect(bad.isError).toBe(true)
  })

  it('names a screen read, an interactive shell and the outcome of a wait in the header', async () => {
    const shells: ShellDirectory = {
      ...directory(),
      read: async (_from, _id, options) => ({
        shell: shellSummary(info({ interactive: true })),
        view: 'screen',
        text: 'VITE ready',
        lines: 1,
        totalLines: 1,
        truncated: false,
        wait: options?.waitFor ? { outcome: 'matched', match: 'ready', ms: 1234 } : undefined,
      }),
    }
    const read = await runShellTool(shells, 'a', 'shell_read', { shellId: 'sh_a', waitFor: 'ready' })
    expect(read.text).toBe(
      '[shell #3 sh_a: $ npm run dev, still running, interactive, the current screen, found "ready" after 1.2s]\nVITE ready',
    )
  })

  it('names the new shell in the header of a run, and what was typed in the header of a write', async () => {
    const shells = directory()
    const started = await runShellTool(shells, 'a', 'shell_run', { command: 'vite', waitFor: 'ready in' }, { write: true })
    expect(started).toEqual({
      text: '[shell #4 sh_new: $ vite, started, still running, showing all 1 lines, found "ready in" after 0.8s]\nstarting',
      isError: false,
    })
    const typed = await runShellTool(shells, 'a', 'shell_write', { shellId: 'sh_a', keys: ['r'] }, { write: true })
    expect(typed.text).toBe('[shell #3 sh_a: $ npm run dev, typed, still running, showing all 4 lines]\none\ntwo\nthree\nreloaded')
    const killed = await runShellTool(shells, 'a', 'shell_kill', { shellId: 'sh_a' }, { write: true })
    expect(killed).toEqual({ text: 'killed shell #3 sh_a ($ npm run dev)', isError: false })
  })

  it('reports a kill of a shell that had already ended without calling it a kill', async () => {
    const shells: ShellDirectory = {
      ...directory(),
      kill: async () => ({ shell: shellSummary(info({ owner: 'agent', status: 'exited', exitCode: 0 })), killed: false }),
    }
    expect(await runShellTool(shells, 'a', 'shell_kill', { shellId: 'sh_a' }, { write: true })).toEqual({
      text: 'shell #3 sh_a ($ npm run dev) had already ended (exited 0)',
      isError: false,
    })
  })

  it('refuses the write tools unless the caller was told the agent may write, before reaching the directory', async () => {
    const shells = directory()
    for (const [name, args] of [
      ['shell_run', { command: 'vite' }],
      ['shell_write', { shellId: 'sh_a', data: 'x' }],
      ['shell_kill', { shellId: 'sh_a' }],
    ] as const) {
      expect(await runShellTool(shells, 'a', name, args)).toEqual({ text: SHELL_WRITE_REFUSAL, isError: true })
      expect(await runShellTool(shells, 'a', name, args, { write: false })).toEqual({ text: SHELL_WRITE_REFUSAL, isError: true })
    }
    expect(shells.calls).toEqual([])
  })

  it('validates a write before it reaches the directory: something to type, known keys, a non-empty command', async () => {
    const shells = directory()
    const nothing = await runShellTool(shells, 'a', 'shell_write', { shellId: 'sh_a' }, { write: true })
    expect(nothing).toEqual({ text: 'invalid arguments for shell_write: give data, keys or both', isError: true })
    const unknown = await runShellTool(shells, 'a', 'shell_write', { shellId: 'sh_a', keys: ['enter', 'hyperspace'] }, { write: true })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('invalid arguments for shell_write: unknown key "hyperspace"')
    const blank = await runShellTool(shells, 'a', 'shell_run', { command: '   ' }, { write: true })
    expect(blank.isError).toBe(true)
    expect(blank.text).toContain('invalid arguments for shell_run')
    const tooMany = await runShellTool(
      shells,
      'a',
      'shell_write',
      { shellId: 'sh_a', keys: Array.from({ length: 65 }, () => 'a') },
      { write: true },
    )
    expect(tooMany.isError).toBe(true)
    expect(shells.calls).toEqual([])
  })

  it("reads another session's shell id as missing, never as a refusal that would name it", async () => {
    const shells = directory()
    const mine = await runShellTool(shells, 'b', 'shell_read', { shellId: 'sh_a' })
    expect(mine).toEqual({ text: 'no such shell: sh_a', isError: true })
    expect(await runShellTool(shells, 'b', 'shell_write', { shellId: 'sh_a', keys: ['q'] }, { write: true })).toEqual({
      text: 'no such shell: sh_a',
      isError: true,
    })
    expect(await runShellTool(shells, 'b', 'shell_kill', { shellId: 'sh_a' }, { write: true })).toEqual({
      text: 'no such shell: sh_a',
      isError: true,
    })
    const listed = await runShellTool(shells, 'b', 'shell_list', {})
    expect(listed).toEqual({ text: 'No shell commands have run in this session.', isError: false })
  })

  it('refuses an unknown tool name and invalid arguments without reaching the directory', async () => {
    const shells = directory()
    expect(await runShellTool(shells, 'a', 'shell_open', { data: 'y' })).toEqual({
      text: 'unknown shell tool: shell_open',
      isError: true,
    })
    const bad = await runShellTool(shells, 'a', 'shell_read', {})
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('invalid arguments for shell_read')
    expect(shells.calls).toEqual([])
  })

  it('returns a thrown directory error as the tool result, which is how an ownership refusal reaches the model', async () => {
    const shells: ShellDirectory = {
      ...directory(),
      list: async () => {
        throw new Error('shell commands are not available on this session')
      },
      write: async (_from, shellId) => {
        throw new Error(shellOwnershipRefusal(shellId))
      },
    }
    expect(await runShellTool(shells, 'a', 'shell_list', {})).toEqual({
      text: 'shell commands are not available on this session',
      isError: true,
    })
    expect(await runShellTool(shells, 'a', 'shell_write', { shellId: 'sh_a', keys: ['q'] }, { write: true })).toEqual({
      text: 'shell sh_a was started by the user; the agent may only type into or kill shells it started, or one the user granted through shell_request_write',
      isError: true,
    })
  })
})

describe('shellTail', () => {
  it('counts the text view in lines, ignoring the trailing newline', () => {
    expect(shellTail('a\nb\nc\n', 2)).toEqual({ view: 'lines', text: 'b\nc', lines: 2, totalLines: 3, truncated: true })
    expect(shellTail('a\nb\nc', 9)).toEqual({ view: 'lines', text: 'a\nb\nc', lines: 3, totalLines: 3, truncated: false })
    expect(shellTail('', 9)).toEqual({ view: 'lines', text: '', lines: 0, totalLines: 0, truncated: false })
  })
})

describe('shellDirectoryHandle', () => {
  it('resolves the installed directory per call and refuses with one string when there is none', async () => {
    const handle = shellDirectoryHandle()
    installShellDirectory(undefined)
    await expect(handle.list('a')).rejects.toThrow('shell commands are not available on this session')
    await expect(handle.run('a', { command: 'x' })).rejects.toThrow('shell commands are not available on this session')
    installShellDirectory(directory())
    await expect(handle.list('a')).resolves.toHaveLength(1)
    await expect(handle.kill('a', 'sh_a')).resolves.toMatchObject({ killed: true })
    installShellDirectory(undefined)
  })
})

describe('shell_request_write', () => {
  it('cards a grant request under both write modes, and every other write tool only under gated', () => {
    expect(shellToolNeedsCard('shell_request_write', 'allow')).toBe(true)
    expect(shellToolNeedsCard('mcp__workerdeck__shell_request_write', 'gated')).toBe(true)
    expect(shellToolNeedsCard('shell_write', 'gated')).toBe(true)
    expect(shellToolNeedsCard('shell_write', 'allow')).toBe(false)
    expect(shellToolNeedsCard('shell_read', 'gated')).toBe(false)
    expect(shellToolNeedsCard('shell_request_write', undefined)).toBe(false)
  })

  it('grants through the directory as the caller, and refuses when the session holds no write tools', async () => {
    const shells = directory()
    const granted = await runShellTool(
      shells,
      'a',
      'shell_request_write',
      { shellId: 'sh_a', reason: 'answer the prompt' },
      { write: true },
    )
    expect(granted).toEqual({
      text: 'granted: you may now type into and kill shell #3 sh_a ($ npm run dev) until it ends or the user revokes it',
      isError: false,
    })
    expect(shells.calls).toEqual([['grant', 'a', 'sh_a']])
    expect((await runShellTool(shells, 'b', 'shell_request_write', { shellId: 'sh_a', reason: 'x' }, { write: true })).text).toBe(
      'no such shell: sh_a',
    )
    expect(await runShellTool(shells, 'a', 'shell_request_write', { shellId: 'sh_a', reason: 'x' })).toEqual({
      text: SHELL_WRITE_REFUSAL,
      isError: true,
    })
    expect((await runShellTool(shells, 'a', 'shell_request_write', { shellId: 'sh_a' }, { write: true })).text).toMatch(
      /^invalid arguments for shell_request_write: reason/,
    )
  })
})
