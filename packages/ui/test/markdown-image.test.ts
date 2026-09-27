import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Streamdown, type Components } from 'streamdown'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MarkdownImage,
  REMOTE_IMAGE_NOTICE,
  localImagePath,
  remoteImageHost,
} from '../src/components/agent/markdown-image.tsx'

function imageSources(markdown: string): (string | undefined)[] {
  const seen: (string | undefined)[] = []
  const components: Components = {
    img: ({ src }) => {
      seen.push(typeof src === 'string' ? src : undefined)
      return null
    },
  }
  renderToString(createElement(Streamdown, { mode: 'static', components, rehypePlugins: MARKDOWN_REHYPE_PLUGINS }, markdown))
  return seen
}

describe('markdown images', () => {
  it('carries every host path through sanitize and harden unchanged', () => {
    const sources = imageSources('![a](/Users/me/shot.png)\n\n![b](shot.png)\n\n![c](./out/c.png)\n\n![d](file:///tmp/d.png)')
    expect(sources.map(localImagePath)).toEqual(['/Users/me/shot.png', 'shot.png', './out/c.png', 'file:///tmp/d.png'])
  })

  it('leaves a web source alone', () => {
    expect(imageSources('![a](https://example.com/a.png)')).toEqual(['https://example.com/a.png'])
  })
})

describe('remote markdown images', () => {
  it('are recognised by scheme, never for a shielded host path or an inline source', () => {
    expect(remoteImageHost('https://evil.example/p.png?leak=1')).toBe('evil.example')
    expect(remoteImageHost('HTTP://evil.example:8080/p.png')).toBe('evil.example:8080')
    expect(remoteImageHost('https://local-image.invalid/%2Ftmp%2Fa.png')).toBeUndefined()
    expect(remoteImageHost('data:image/png;base64,AAAA')).toBeUndefined()
    expect(remoteImageHost('blob:http://127.0.0.1/abc')).toBeUndefined()
  })

  it('render as a link and never as an img, in both variants', () => {
    for (const terminal of [false, true]) {
      const html = renderToString(createElement(MarkdownImage, { src: 'https://evil.example/p.png', alt: 'chart', terminal }))
      expect(html).not.toContain('<img')
      expect(html).toContain('href="https://evil.example/p.png"')
      expect(html).toContain(REMOTE_IMAGE_NOTICE)
    }
  })

  it('still load an inline data source', () => {
    const html = renderToString(createElement(MarkdownImage, { src: 'data:image/png;base64,AAAA', alt: 'x' }))
    expect(html).toContain('<img')
  })
})
