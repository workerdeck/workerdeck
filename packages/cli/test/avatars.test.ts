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
})
