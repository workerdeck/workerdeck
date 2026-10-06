import { describe, expect, it } from 'vitest'
import { MonkeyartAvatars } from '../src/lib/avatars.ts'

describe('MonkeyartAvatars', () => {
  it('draws a still PNG with a stable etag for a rolled recipe', async () => {
    const avatars = new MonkeyartAvatars()
    const recipe = await avatars.roll('agent-1', 'codex', '/tmp/project')
    const first = await avatars.still(recipe)
    expect(String.fromCharCode(...first.png.subarray(1, 4))).toBe('PNG')
    expect((await avatars.still(structuredClone(recipe))).etag).toBe(first.etag)
  })

  it('draws the busy animation as one strip with its frame durations', async () => {
    const avatars = new MonkeyartAvatars()
    const busy = await avatars.busy(await avatars.roll('agent-1', undefined, undefined))
    expect(String.fromCharCode(...busy!.png.subarray(1, 4))).toBe('PNG')
    expect(busy!.durations).toEqual([160, 160, 160, 160])
  })

  it('spreads random seeds across the enabled packs, and a pack prefix picks one', async () => {
    const avatars = new MonkeyartAvatars(['monkey', 'toad', 'steampunk-bulldogs'])
    const packs = new Set<string>()
    for (let i = 0; i < 24; i++) {
      packs.add(((await avatars.roll(`seed-${i}`, 'claude', undefined)) as { pack: string }).pack)
    }
    expect([...packs].sort()).toEqual(['monkey', 'steampunk-bulldogs', 'toad'])
    expect(((await avatars.roll('toad:hop', 'claude', undefined)) as { pack: string }).pack).toBe('toad')
    expect(((await avatars.roll('panda:x', 'claude', undefined)) as { pack: string }).pack).toBe('panda')
  })

  it('still draws a bare recipe stored before packs as a monkey', async () => {
    const avatars = new MonkeyartAvatars()
    const { recipe } = (await avatars.roll('monkey:old', 'claude', undefined)) as { recipe: unknown }
    expect((await avatars.still(recipe)).etag).toBe((await avatars.still({ pack: 'monkey', recipe })).etag)
  })

  it('has no busy strip for a pack without the animation', async () => {
    const avatars = new MonkeyartAvatars()
    expect(await avatars.busy(await avatars.roll('steampunk-bulldogs:a', 'claude', undefined))).toBeUndefined()
  })
})
