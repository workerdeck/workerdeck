import { describe, expect, it, vi } from 'vitest'
import { createWebFetch, htmlToMarkdown, isPrivateAddress } from '../src/engines/provider/web-fetch.ts'

// Literal public IPs (TEST-NET) so the SSRF guard never touches real DNS.
const PAGE = 'http://203.0.113.5/page'

const htmlResponse = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })

describe('createWebFetch', () => {
  it('fetches a page and returns it as markdown', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>'))
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await webFetch(PAGE, 'what is this?')
    expect(result.markdown).toContain('# Title')
    expect(result.markdown).toContain('**world**')
    expect(result.error).toBeUndefined()
  })

  it('caches the fetched page by URL', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<p>cached</p>'))
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await webFetch(PAGE, 'a')
    await webFetch(PAGE, 'b')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses non-http schemes and private/link-local destinations', async () => {
    const fetchImpl = vi.fn()
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    for (const url of [
      'file:///etc/passwd',
      'http://127.0.0.1/admin',
      'http://10.0.0.8/meta',
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://localhost:8787/v1/sessions',
    ]) {
      const result = await webFetch(url, 'x')
      expect(result.error, url).toBeDefined()
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces a cross-host redirect instead of following it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://198.51.100.7/moved' } }))
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await webFetch(PAGE, 'x')
    expect(result.notice).toMatch(/different host/)
    expect(result.redirectUrl).toBe('http://198.51.100.7/moved')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows same-host redirects and re-checks each hop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/final' } }))
      .mockResolvedValueOnce(htmlResponse('<p>landed</p>'))
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await webFetch(PAGE, 'x')
    expect(result.markdown).toBe('landed')
    expect(result.url).toBe('http://203.0.113.5/final')
  })

  it('caps the body size before conversion', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('x'.repeat(4096)))
    const webFetch = createWebFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxContentBytes: 1024,
    })
    const result = await webFetch(PAGE, 'x')
    expect(result.error).toMatch(/too large/)
  })

  it('truncates the markdown at the cap and says so', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(`<p>${'y'.repeat(2000)}</p>`))
    const webFetch = createWebFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxMarkdownBytes: 100,
    })
    const result = await webFetch(PAGE, 'x')
    expect(result.markdown).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('enforces an operator host allowlist on top of the SSRF guard', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<p>ok</p>'))
    const webFetch = createWebFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowedHosts: ['198.51.100.7'],
    })
    expect((await webFetch(PAGE, 'x')).error).toMatch(/not allowed/)
    expect((await webFetch('http://198.51.100.7/', 'x')).markdown).toBe('ok')
  })

  it('runs the digest pass over the markdown and returns its answer', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<h1>Pricing</h1><p>$10/mo</p>'))
    const digest = vi.fn(async (markdown: string, prompt: string) => {
      expect(markdown).toContain('# Pricing')
      expect(prompt).toBe('how much?')
      return 'It costs $10/mo.'
    })
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, digest })
    const result = await webFetch(PAGE, 'how much?')
    expect(result.digest).toBe('It costs $10/mo.')
    expect(result.markdown).toBeUndefined()
  })

  it('falls back to the markdown when the digest pass fails', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<p>content</p>'))
    const webFetch = createWebFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      digest: async () => {
        throw new Error('model unavailable')
      },
    })
    const result = await webFetch(PAGE, 'x')
    expect(result.markdown).toBe('content')
    expect(result.error).toBeUndefined()
  })

  it('turns a network failure into data, not a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const webFetch = createWebFetch({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await webFetch(PAGE, 'x')
    expect(result.error).toBe('ECONNREFUSED')
  })
})

describe('htmlToMarkdown', () => {
  it('keeps structure, drops chrome', () => {
    const markdown = htmlToMarkdown(`
      <html><head><title>t</title><style>.x{}</style></head><body>
        <script>alert(1)</script>
        <h2>Docs</h2>
        <ul><li>One</li><li>Two</li></ul>
        <a href="https://x.test/guide">the guide</a>
        <pre>const a = 1 &amp;&amp; 2</pre>
        AT&amp;T &lt;3
      </body></html>`)
    expect(markdown).toContain('## Docs')
    expect(markdown).toContain('- One')
    expect(markdown).toContain('[the guide](https://x.test/guide)')
    expect(markdown).toContain('const a = 1 && 2')
    expect(markdown).toContain('AT&T <3')
    expect(markdown).not.toContain('alert(1)')
    expect(markdown).not.toContain('.x{}')
  })
})

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['203.0.113.5', false],
    ['::1', true],
    ['::', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['2606:4700::1111', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})
