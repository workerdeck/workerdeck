import { describe, expect, it } from 'vitest'
import { modelLine, modelMenu } from '@workerdeck/protocol'
import { CLAUDE_CATALOG } from '../src/engines/claude/catalog.ts'
import { CODEX_CATALOG } from '../src/engines/codex/catalog.ts'

function names(rows: { displayName: string }[]): string[] {
  return rows.map((m) => m.displayName)
}

describe('modelMenu', () => {
  it('opens on the default, then the newest of every other line', () => {
    const menu = modelMenu(CLAUDE_CATALOG.models, 'claude-opus-5-5')
    expect(names(menu.main)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(menu.defaultRow?.value).toBe('opus')
    expect(menu.more).toHaveLength(CLAUDE_CATALOG.models.length)
  })

  it('puts an older default on top beside its line newest', () => {
    const menu = modelMenu(CLAUDE_CATALOG.models, 'claude-fable-5[1m]')
    expect(names(menu.main)).toEqual(['Fable 5', 'Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  })

  it('marks nothing when the default is unknown', () => {
    const menu = modelMenu(CLAUDE_CATALOG.models)
    expect(menu.defaultRow).toBeUndefined()
    expect(names(menu.main)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  })

  it('groups codex by tier across generations', () => {
    expect(modelLine({ value: 'a', displayName: 'GPT-6 Astra' })).toBe(modelLine({ value: 'b', displayName: 'GPT-5.6 Astra' }))
    const menu = modelMenu(CODEX_CATALOG.models)
    expect(new Set(menu.main.map(modelLine)).size).toBe(menu.main.length)
    expect(menu.main.length).toBeLessThan(CODEX_CATALOG.models.length)
  })

  it('drops a default sentinel row', () => {
    const menu = modelMenu([{ value: 'default', displayName: 'Default' }, ...CLAUDE_CATALOG.models])
    expect(menu.more.some((m) => m.value === 'default')).toBe(false)
  })
})
