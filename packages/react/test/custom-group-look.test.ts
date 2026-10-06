import { describe, expect, it } from 'vitest'
import { CUSTOM_GROUP_ICON_MAX, PROJECT_ACCENTS, customGroupColor, styleCustomGroup } from '@workerdeck/protocol'

const groups = [{ id: 'focus', name: 'Focus', members: [] }]

describe('custom group look', () => {
  it('derives a stable palette colour until one is chosen', () => {
    expect(PROJECT_ACCENTS).toContain(customGroupColor(groups[0]!))
    expect(customGroupColor(groups[0]!)).toBe(customGroupColor({ id: 'focus' }))
    expect(customGroupColor({ id: 'focus', color: '#123456' })).toBe('#123456')
  })

  it('sets and clears colour and image, refusing an image that is not a small data URL', () => {
    const coloured = styleCustomGroup(groups, 'focus', { color: '#4f8f96' })
    expect(coloured[0]).toMatchObject({ color: '#4f8f96' })
    const iconed = styleCustomGroup(coloured, 'focus', { icon: 'data:image/png;base64,AAAA' })
    expect(iconed[0]).toMatchObject({ icon: 'data:image/png;base64,AAAA' })
    expect(styleCustomGroup(iconed, 'focus', { icon: 'https://example.com/x.png' })[0]!.icon).toBe('data:image/png;base64,AAAA')
    expect(styleCustomGroup(groups, 'focus', { icon: `data:image/png;base64,${'A'.repeat(CUSTOM_GROUP_ICON_MAX)}` })[0]).not.toHaveProperty('icon')
    expect(styleCustomGroup(iconed, 'focus', { icon: null, color: null })[0]).toEqual(groups[0])
  })
})
