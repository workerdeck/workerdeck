import { describe, expect, it } from 'vitest'
import {
  shellProposalInput,
  shellProposalOf,
  shellRequestLines,
  shellRequestPayload,
  shellRequestTitle,
  shellToolOf,
  visibleControls,
} from '../src/lib/shell-request.ts'

describe('shellRequestPayload', () => {
  it('recognises the three write tools under their bare names and under the claude MCP prefix, nothing else', () => {
    expect(shellToolOf('shell_run')).toBe('shell_run')
    expect(shellToolOf('mcp__workerdeck__shell_write')).toBe('shell_write')
    expect(shellToolOf('mcp__workerdeck__shell_kill')).toBe('shell_kill')
    expect(shellToolOf('shell_read')).toBeUndefined()
    expect(shellToolOf('Bash')).toBeUndefined()
    expect(shellToolOf(undefined)).toBeUndefined()
    expect(shellRequestPayload({ toolName: 'Bash', input: { command: 'ls' } })).toBeUndefined()
    expect(shellRequestPayload(null)).toBeUndefined()
  })

  it('draws the command of a run verbatim, first line prompted, the rest indented', () => {
    const payload = shellRequestPayload({ toolName: 'mcp__workerdeck__shell_run', input: { command: 'npm run dev\n  --port 5173' } })!
    expect(payload).toEqual({ kind: 'run', command: 'npm run dev\n  --port 5173' })
    expect(shellRequestTitle(payload)).toBe('Agent wants to start a shell')
    expect(shellRequestLines(payload)).toEqual(['$ npm run dev', '    --port 5173'])
  })

  it('draws typed text and pressed keys as separate lines, naming hidden control characters', () => {
    const payload = shellRequestPayload({
      toolName: 'shell_write',
      input: { shellId: 'sh_a', data: 'rm -rf build\r', keys: ['enter', 'ctrl-c'] },
    })!
    expect(payload).toEqual({ kind: 'write', shellId: 'sh_a', data: 'rm -rf build\r', keys: ['enter', 'ctrl-c'] })
    expect(shellRequestTitle(payload)).toBe('Agent wants to type into shell sh_a')
    expect(shellRequestLines(payload)).toEqual(['types: rm -rf build[enter]', 'presses: [enter] [ctrl-c]'])
    expect(shellRequestLines(shellRequestPayload({ toolName: 'shell_write', input: { shellId: 'sh_a', keys: ['r'] } })!)).toEqual([
      'presses: [r]',
    ])
    expect(shellRequestLines(shellRequestPayload({ toolName: 'shell_write', input: { shellId: 'sh_a', keys: [] } })!)).toEqual([])
  })

  it('names the shell a kill targets', () => {
    const payload = shellRequestPayload({ toolName: 'shell_kill', input: { shellId: 'sh_b' } })!
    expect(shellRequestTitle(payload)).toBe('Agent wants to kill shell sh_b')
    expect(shellRequestLines(payload)).toEqual(['kill sh_b'])
  })

  it('makes every control character visible by name', () => {
    expect(visibleControls('a\tb\nc\x1bd\x7fe\x03f')).toBe('a[tab]b[newline]c[escape]d[backspace]e[ctrl-c]f')
    expect(visibleControls('plain text')).toBe('plain text')
  })
})

describe('shell_request_write on the card', () => {
  it('names the shell and shows the reason verbatim, with the grant spelled out', () => {
    const payload = shellRequestPayload({
      toolName: 'mcp__workerdeck__shell_request_write',
      input: { shellId: 'sh_a', reason: 'answer "y" to the\nprompt' },
    })
    expect(payload).toEqual({ kind: 'grant', shellId: 'sh_a', reason: 'answer "y" to the\nprompt' })
    expect(shellRequestTitle(payload!)).toBe('Agent asks to type into your shell sh_a')
    expect(shellRequestLines(payload!)).toEqual(['why: answer "y" to the[newline]prompt', 'until the shell ends or you revoke it'])
  })
})

describe('shell proposals', () => {
  it('reads a proposal under either name and draws the command with the secret note', () => {
    const proposal = shellProposalOf({ toolName: 'mcp__workerdeck__shell_propose', input: { command: 'a\nb', description: 'why', secret: true } })
    expect(proposal).toEqual({ kind: 'propose', command: 'a\nb', description: 'why', secret: true, noInput: false })
    expect(shellRequestLines(proposal!)).toEqual(['$ a', '  b', 'reads a secret on stdin'])
    const quiet = shellProposalOf({ toolName: 'shell_propose', input: { command: 'git log', description: 'why', interactive: false } })
    expect(shellRequestLines(quiet!)).toEqual(['$ git log', 'takes no input: stdin is empty'])
    expect(shellProposalOf({ toolName: 'shell_run', input: { command: 'x' } })).toBeUndefined()
  })

  it('hands back only what the user changed or typed', () => {
    expect(shellProposalInput('make deploy', 'make deploy', '')).toBeUndefined()
    expect(shellProposalInput('make deploy', '   ', '')).toBeUndefined()
    expect(shellProposalInput('make deploy', 'make ship', '')).toEqual({ command: 'make ship' })
    expect(shellProposalInput('make deploy', 'make deploy', 'k3y')).toEqual({ stdin: 'k3y' })
  })
})

