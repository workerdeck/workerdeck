import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import {
  IMAGE_BOX_LINES,
  IMAGE_UNAVAILABLE,
  hostImagePathOf,
  imagePlaceholder,
  resultImageName,
} from '../src/components/terminal/image-box.ts'
import { itemHeight, markdownHeight, type CellMetrics } from '../src/components/terminal/height.ts'

const m: CellMetrics = { width: 800, ch: 8, line: 18 }

function image(partIndex: number, bytes = 344_064) {
  return {
    partIndex,
    mediaType: 'image/png',
    bytes,
    sourceSeq: 40 + partIndex,
  }
}

function call(images?: ReturnType<typeof image>[], text = ''): TranscriptItem {
  return {
    kind: 'tool_call',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: '/tmp/shot.png' },
    parentToolUseId: null,
    status: 'settled',
    result: { text, isError: false, ...(images ? { images } : {}) },
  }
}

describe('imagePlaceholder', () => {
  it('spells the box label exactly', () => {
    expect(imagePlaceholder({ bytes: 344_064 })).toBe('image · 336.0 KB')
    expect(imagePlaceholder({ bytes: 512 })).toBe('image · 512 B')
    expect(imagePlaceholder({ bytes: 2_202_009 })).toBe('image · 2.1 MB')
  })

  it('says what a failed fetch left behind', () => {
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
    expect(one.exact).toBe(true)
    expect(three.exact).toBe(true)
  })

  it('reserves the box whatever else the row draws', () => {
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

  it('reserves one box for a codex image the tool left on the host', () => {
    const generated = (name: string): TranscriptItem => ({ ...call(), name, input: { savedPath: '/tmp/g.png' } }) as TranscriptItem
    expect(itemHeight(generated('CodexImageGeneration'), m).px).toBe(itemHeight(generated('Other'), m).px + IMAGE_BOX_LINES * m.line)
  })

  it('costs nothing when the replay delivered no references', () => {
    expect(itemHeight(call(), m).px).toBe(itemHeight(call([]), m).px)
  })
})

describe('one spelling', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('is what both the calculator and the renderer read', () => {
    expect(source('../src/components/terminal/height.ts')).toMatch(/import \{ IMAGE_BOX_LINES\b[^}]*\} from '\.\/image-box\.ts'/)
    const items = source('../src/components/terminal/items.tsx')
    expect(items).toContain("from './image-box.ts'")
    expect(items).toContain('`calc(var(--term-line) * ${IMAGE_BOX_LINES})`')
  })

  it('is what the cards theme labels its frame with', () => {
    expect(source('../src/components/agent/ToolCallCard.tsx')).toContain("from '../terminal/image-box.ts'")
  })
})

describe('a markdown image', () => {
  it('costs one box when it stands alone on its line', () => {
    const md = (body: string) => markdownHeight(`intro\n\n${body}`, m)
    expect(md('![shot](/tmp/a.png)')).toEqual({ px: md('x').px - m.line + IMAGE_BOX_LINES * m.line, exact: true })
  })

  it('flags a line that mixes text and an image', () => {
    expect(markdownHeight('see ![shot](/tmp/a.png) here', m).exact).toBe(false)
  })
})

describe('image names', () => {
  it('names a tool result image by tool, part and media type', () => {
    expect(resultImageName('Read', { partIndex: 0, mediaType: 'image/jpeg' })).toBe('read-1.jpg')
  })

  it('reads the host path of codex image tools only', () => {
    const item = { ...call(), name: 'CodexImageView', input: { path: '/tmp/v.png' } } as Extract<TranscriptItem, { kind: 'tool_call' }>
    expect(hostImagePathOf(item)).toBe('/tmp/v.png')
    expect(hostImagePathOf({ ...item, name: 'Read' })).toBeUndefined()
  })
})
