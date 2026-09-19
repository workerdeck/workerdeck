import { describe, expect, it, vi } from 'vitest'
import type { SkillInfo, SlashCommandInfo } from '@workerdeck/protocol'
import {
  composerCommandRows,
  matchClientCommand,
  mergeComposerRows,
  rankComposerRows,
  skillPrompt,
  skillToken,
  skillTrailingText,
  type ClientCommand,
} from '../src/components/agent/composer-commands.ts'

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'pdf', enabled: true, ...over }
}
function command(over: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
  return { name: 'compact', ...over }
}
function client(over: Partial<ClientCommand> = {}): ClientCommand {
  return { name: 'mcp', description: 'MCP servers', run: () => true, ...over }
}

describe('mergeComposerRows', () => {
  it('suppresses a client command the engine already provides', () => {
    const rows = mergeComposerRows({
      commands: [command({ name: 'model' })],
      clientCommands: [client({ name: 'model' }), client({ name: 'mcp' })],
    })
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ['command', 'model'],
      ['client', 'mcp'],
    ])
  })

  it('suppresses a client command an engine alias covers', () => {
    const rows = mergeComposerRows({
      commands: [command({ name: 'usage', aliases: ['cost'] })],
      clientCommands: [client({ name: 'cost' })],
    })
    expect(rows).toHaveLength(1)
  })

  it('keeps a skill that collides with a command, so both stay reachable', () => {
    const rows = mergeComposerRows({ commands: [command({ name: 'pdf' })], skills: [skill()] })
    expect(rows.map((r) => r.kind)).toEqual(['command', 'skill'])
  })

  it('drops a duplicate command name and strips the MCP suffix', () => {
    const rows = mergeComposerRows({ commands: [command({ name: 'deploy (MCP)' }), command({ name: 'deploy' })] })
    expect(rows.map((r) => r.name)).toEqual(['deploy'])
  })
})

describe('rankComposerRows', () => {
  const rows = mergeComposerRows({
    commands: [command({ name: 'compact' })],
    clientCommands: [client({ name: 'context' })],
    skills: [skill({ name: 'compose' }), skill({ name: 'off', enabled: false })],
  })

  it('prefixes outrank substrings', () => {
    expect(rankComposerRows('com', rows).map((r) => r.name)).toEqual(['compact', 'compose'])
  })

  it('breaks a score tie by kind, engine command first', () => {
    expect(rankComposerRows('co', rows).map((r) => [r.kind, r.name])).toEqual([
      ['command', 'compact'],
      ['client', 'context'],
      ['skill', 'compose'],
    ])
  })

  it('never offers a disabled skill', () => {
    expect(rankComposerRows('off', rows)).toEqual([])
  })

  it('returns everything on an empty query', () => {
    expect(rankComposerRows('', rows)).toHaveLength(3)
  })
})

describe('matchClientCommand', () => {
  const commands = [client({ name: 'model' }), client({ name: 'mcp' })]

  it('matches a bare command', () => {
    expect(matchClientCommand('/mcp', commands)?.command.name).toBe('mcp')
  })

  it('splits the argument off', () => {
    expect(matchClientCommand('  /model  opus-5 ', commands)).toMatchObject({ args: 'opus-5' })
  })

  it('does not match a prefix of another command', () => {
    expect(matchClientCommand('/mc', commands)).toBeUndefined()
  })

  it('ignores a slash that is not the first character', () => {
    expect(matchClientCommand('see /mcp for that', commands)).toBeUndefined()
  })

  it('ignores an unknown command so it reaches the engine', () => {
    expect(matchClientCommand('/compact', commands)).toBeUndefined()
  })

  it('hands the text back when run declines it', () => {
    const run = vi.fn(() => false)
    const match = matchClientCommand('/model', [client({ name: 'model', run })])
    expect(match?.command.run(match.args)).toBe(false)
    expect(run).toHaveBeenCalledWith('')
  })
})

describe('skillPrompt', () => {
  it('is the $name token followed by the default prompt, space-terminated', () => {
    expect(skillPrompt(skill({ defaultPrompt: 'Inspect this PDF' }))).toBe('$pdf Inspect this PDF ')
  })

  it('falls back to the bare token, never prose, when there is no default prompt', () => {
    expect(skillPrompt(skill({ displayName: 'PDF tools' }))).toBe('$pdf ')
  })

  it('does not repeat a token the default prompt already carries', () => {
    expect(skillPrompt(skill({ defaultPrompt: '$pdf inspect this' }))).toBe('$pdf inspect this ')
    expect(skillPrompt(skill({ defaultPrompt: 'Run $pdf on  $pdf ' }))).toBe('$pdf Run on ')
  })

  it('is exactly what the chip and its trailing text serialise to', () => {
    const s = skill({ defaultPrompt: 'Turn these notes into a document:' })
    expect(skillToken(s) + skillTrailingText(s)).toBe(skillPrompt(s))
    expect(skillTrailingText(s)).toBe(' Turn these notes into a document: ')
    expect(skillTrailingText(skill())).toBe(' ')
  })
})

describe('composerCommandRows', () => {
  it('resolves insert text per kind and keeps disabled skills visible', () => {
    const rows = composerCommandRows(
      mergeComposerRows({
        commands: [command({ name: 'compact' })],
        skills: [skill({ name: 'pdf', enabled: false, scope: 'project' })],
      }),
    )
    expect(rows).toEqual([
      { kind: 'command', name: 'compact', label: '/compact', description: undefined, enabled: true, insertText: '/compact ' },
      {
        kind: 'skill',
        name: 'pdf',
        label: 'pdf',
        description: undefined,
        scope: 'project',
        enabled: false,
        insertText: '$pdf ',
      },
    ])
  })
})
