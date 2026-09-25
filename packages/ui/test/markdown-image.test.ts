import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Streamdown, type Components } from 'streamdown'
import { MARKDOWN_REHYPE_PLUGINS, localImagePath } from '../src/components/agent/markdown-image.tsx'

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
