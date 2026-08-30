import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { IMAGE_BOX_LINES, IMAGE_UNAVAILABLE, imagePlaceholder } from '../src/components/terminal/image-box.ts'
import { itemHeight, type CellMetrics } from '../src/components/terminal/height.ts'

/**
 * The image box's two claims, both of which are the same claim: **the constant
 * and the string have one spelling**, because in this theme a rendered string is
 * a row height and a reserved box is a promise the calculator made on the
 * renderer's behalf.
 *
 * The geometry itself — does the drawn box come out `IMAGE_BOX_LINES` lines —
 * belongs in `dev/height-audit.ts`, which measures against real browser layout.
 * jsdom has no layout, so a test here asserting pixels would be asserting its
 * author's assumptions.
 */

const m: CellMetrics = { width: 800, ch: 8, line: 18 }

const image = (partIndex: number, bytes = 344_064) => ({
  partIndex,
  mediaType: 'image/png',
  bytes,
  sourceSeq: 40 + partIndex,
})

const call = (images?: ReturnType<typeof image>[], text = ''): TranscriptItem => ({
  kind: 'tool_call',
  id: 'toolu_1',
  name: 'Read',
  input: { file_path: '/tmp/shot.png' },
  parentToolUseId: null,
  status: 'settled',
  result: { text, isError: false, ...(images ? { images } : {}) },
})

describe('imagePlaceholder', () => {
  it('spells the box label exactly', () => {
    // The corpus median, to the character. `bytes` is the *decoded* size the
    // gateway stamped on the reference — the client holds none of them.
    expect(imagePlaceholder({ bytes: 344_064 })).toBe('image · 336.0 KB')
    expect(imagePlaceholder({ bytes: 512 })).toBe('image · 512 B')
    expect(imagePlaceholder({ bytes: 2_202_009 })).toBe('image · 2.1 MB')
  })

  it('says what a failed fetch left behind', () => {
    // Said, not swallowed: unlike a host-path picture there is no path in the
    // result text for a reader to fall back on.
    expect(IMAGE_UNAVAILABLE).toBe('image unavailable')
  })
})

describe('the box in the height calculator', () => {
  it('adds a whole box of whole lines per image, and stays exact', () => {
    const bare = itemHeight(call(), m)
    const one = itemHeight(call([image(0)]), m)
    const three = itemHeight(call([image(0), image(1), image(2)]), m)
    expect(one.px).toBe(bare.px + IMAGE_BOX_LINES * m.line)
    expect(three.px).toBe(bare.px + 3 * IMAGE_BOX_LINES * m.line)
    // The whole reason the box is fixed: an image-bearing row is not an
    // estimate, so the scrollbar does not grow as rows mount.
    expect(one.exact).toBe(true)
    expect(three.exact).toBe(true)
  })

  it('reserves the box whatever else the row draws', () => {
    // Every branch of the tool row — a bare call, one carrying result text, one
    // carrying a diff instead — must reserve it, because the box is drawn in
    // all three and the early returns are where this is easy to lose.
    const withText = (images?: ReturnType<typeof image>[]) => itemHeight(call(images, 'first line\nsecond line'), m).px
    expect(withText([image(0)])).toBe(withText() + IMAGE_BOX_LINES * m.line)

    const patched = (images?: ReturnType<typeof image>[]): number => {
      const base = call(images) as Extract<TranscriptItem, { kind: 'tool_call' }>
      return itemHeight(
        {
          ...base,
          patch: {
            path: 'a.ts',
            hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
          },
        },
        m,
      ).px
    }
    expect(patched([image(0)])).toBe(patched() + IMAGE_BOX_LINES * m.line)
  })

  it('costs nothing when the replay delivered no references', () => {
    // `images` is absent on every item of a session with no pictures in it —
    // the reducer sets it only when refs arrived — and an absent one must not
    // move a single pixel.
    expect(itemHeight(call(), m).px).toBe(itemHeight(call([]), m).px)
  })
})

describe('one spelling', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('is what both the calculator and the renderer read', () => {
    // The drift this module exists to prevent is a literal in one file and a
    // constant in the other, which typechecks perfectly and puts every
    // image-bearing row a few lines off. Both sides import the constant, and
    // the renderer spells its CSS height *from* it.
    expect(source('../src/components/terminal/height.ts')).toContain("import { IMAGE_BOX_LINES } from './image-box.ts'")
    const items = source('../src/components/terminal/items.tsx')
    expect(items).toContain("from './image-box.ts'")
    expect(items).toContain('`calc(var(--term-line) * ${IMAGE_BOX_LINES})`')
  })

  it('is what the cards theme labels its frame with', () => {
    // Cards has no calculator, so it takes only the strings — but it takes them
    // from the same module rather than restating them.
    expect(source('../src/components/agent/ToolCallCard.tsx')).toContain("from '../terminal/image-box.ts'")
  })
})
