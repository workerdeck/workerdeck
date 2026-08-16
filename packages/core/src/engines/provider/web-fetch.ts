import { lookup } from 'node:dns/promises'

/**
 * `web_fetch` backend, close to Claude Code's original WebFetch: fetch a URL,
 * convert HTML to markdown, and (optionally) digest it with a model against the
 * caller's prompt. Server-side only — this runs with server egress, which is
 * exactly why it is an authoritative capability the operator grants explicitly.
 */

export type WebFetchResult = {
  /** The URL that was fetched (after same-host redirects). */
  url: string
  /** Model digest of the page against the prompt (when a digest fn is wired). */
  digest?: string
  /** Page content as markdown (when no digest fn is wired, or digesting failed). */
  markdown?: string
  /** True when the markdown was cut at the size cap. */
  truncated?: boolean
  /** Redirect-to-a-different-host notice: the redirect is surfaced, not followed
   * (the agent can decide to fetch `redirectUrl` itself). */
  notice?: string
  redirectUrl?: string
  error?: string
}

export type WebFetchFn = (url: string, prompt: string) => Promise<WebFetchResult>

/** Runs the digest pass over the fetched markdown. Wire the session's own model
 * here (see createEngineSession) so its tokens land in the turn's usage. */
export type WebFetchDigest = (markdown: string, prompt: string) => Promise<string>

export type WebFetchOptions = {
  fetchImpl?: typeof fetch
  /** Raw-body cap, enforced while streaming (before any conversion). Default 1 MiB. */
  maxContentBytes?: number
  /** Markdown cap handed to the model. Default 50 KB. */
  maxMarkdownBytes?: number
  /** Fetched-page cache TTL (keyed by URL; the digest is per-prompt and never
   * cached). Default 15 minutes. */
  cacheTtlMs?: number
  /** Optional hostname allowlist on top of the SSRF guard (exact or `*.example.com`).
   * Unset = any public host. */
  allowedHosts?: string[]
  /** Per-request timeout. Default 30000. */
  timeoutMs?: number
  digest?: WebFetchDigest
}

const MAX_CACHE_ENTRIES = 64
const MAX_REDIRECTS = 5

type CacheEntry = { expiresAt: number; page: WebFetchResult }

export function createWebFetch(options: WebFetchOptions = {}): WebFetchFn {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxContentBytes = options.maxContentBytes ?? 1024 * 1024
  const maxMarkdownBytes = options.maxMarkdownBytes ?? 50 * 1024
  const cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000
  const cache = new Map<string, CacheEntry>()

  const fetchPage = async (rawUrl: string): Promise<WebFetchResult> => {
    const cached = cache.get(rawUrl)
    if (cached && cached.expiresAt > Date.now()) return cached.page

    let url = parseUrl(rawUrl)
    if (!url) return { url: rawUrl, error: 'only absolute http(s) URLs are supported' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
    try {
      let response: Response
      for (let hop = 0; ; hop++) {
        const denied = await denyReason(url, options.allowedHosts)
        if (denied) return { url: url.href, error: denied }
        response = await fetchImpl(url.href, {
          redirect: 'manual',
          signal: controller.signal,
        })
        if (response.status < 300 || response.status >= 400) break
        const location = response.headers.get('location')
        if (!location) return { url: url.href, error: `redirect (${response.status}) without a location` }
        const target = parseUrl(new URL(location, url).href)
        if (!target) return { url: url.href, error: `redirect to unsupported URL: ${location}` }
        if (target.host !== url.host) {
          // Like the original: surface a cross-host redirect instead of silently
          // following it — the agent may fetch the new URL explicitly.
          return {
            url: url.href,
            redirectUrl: target.href,
            notice: `redirected to a different host (${target.host}); not followed automatically`,
          }
        }
        if (hop >= MAX_REDIRECTS) return { url: url.href, error: 'too many redirects' }
        url = target
      }
      if (!response.ok) {
        return { url: url.href, error: `request failed: ${response.status}` }
      }
      const declared = Number(response.headers.get('content-length') ?? '')
      if (declared > maxContentBytes) {
        return { url: url.href, error: `response too large (${declared} bytes)` }
      }
      const body = await readCapped(response, maxContentBytes)
      if (body === undefined) {
        return { url: url.href, error: `response too large (> ${maxContentBytes} bytes)` }
      }
      const contentType = response.headers.get('content-type') ?? ''
      const text =
        contentType.includes('html') || looksLikeHtml(body) ? htmlToMarkdown(body) : body
      const truncated = text.length > maxMarkdownBytes
      const page: WebFetchResult = {
        url: url.href,
        markdown: truncated ? text.slice(0, maxMarkdownBytes) : text,
        truncated: truncated || undefined,
      }
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(rawUrl, { expiresAt: Date.now() + cacheTtlMs, page })
      return page
    } catch (error) {
      const message = controller.signal.aborted
        ? 'request timed out'
        : error instanceof Error
          ? error.message
          : String(error)
      return { url: url.href, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  return async (rawUrl, prompt) => {
    const page = await fetchPage(rawUrl)
    if (page.error || page.notice || !options.digest || page.markdown === undefined) return page
    try {
      const digest = await options.digest(page.markdown, prompt)
      return { url: page.url, digest, truncated: page.truncated }
    } catch {
      // Digest is best-effort sugar over the fetch: fall back to the markdown.
      return page
    }
  }
}

function parseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** SSRF guard: resolve the hostname and refuse private, loopback, and link-local
 * destinations. Checked per redirect hop. Resolution happens once here and again
 * inside fetch (a DNS-rebinding TOCTOU); this tier accepts that — operators who
 * need pinning can supply `fetchImpl` with a pinned agent. */
async function denyReason(url: URL, allowedHosts: string[] | undefined): Promise<string | null> {
  const host = url.hostname.toLowerCase()
  if (allowedHosts && allowedHosts.length > 0 && !hostMatches(host, allowedHosts)) {
    return `host not allowed: ${host}`
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return `host not allowed: ${host}`
  const literal = host.replace(/^\[|\]$/g, '')
  if (isPrivateAddress(literal)) return `address not allowed: ${literal}`
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) return null // public literal IP
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(literal, { all: true })
  } catch {
    return `cannot resolve host: ${host}`
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) return `host resolves to a private address: ${host}`
  }
  return null
}

function hostMatches(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    if (!pattern) return false
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1))
    return host === pattern
  })
}

/** Private / loopback / link-local / unspecified, IPv4 and IPv6 (incl. v4-mapped). */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase()
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip)
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && b === 168) return true
  return a >= 224 // multicast + reserved
}

async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) {
    const text = await response.text()
    return text.length > maxBytes ? undefined : text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
    if (out.length > maxBytes) {
      await reader.cancel().catch(() => {})
      return undefined
    }
  }
  return out + decoder.decode()
}

function looksLikeHtml(body: string): boolean {
  return /<(!doctype|html|head|body)[\s>]/i.test(body.slice(0, 1024))
}

/**
 * Dependency-free HTML → markdown, tuned for "give the model readable text":
 * drops non-content subtrees, keeps headings/lists/links/emphasis/code, strips
 * everything else. Not a spec-grade converter on purpose — a small predictable
 * transform beats dragging a DOM into core.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(head)\b[\s\S]*?<\/\1>/gi, '')
  text = text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${stripTags(body).trim()}\n\n`
    })
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
      return `\n\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, ''))}\n\`\`\`\n\n`
    })
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, body: string) => {
      const label = stripTags(body).trim()
      // Skip anchors/scripts and empty labels; keep the label when it IS the URL.
      if (!label || href.startsWith('#') || href.startsWith('javascript:')) return label
      return label === href ? label : `[${label}](${href})`
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|figure)>/gi, '\n\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  text = decodeEntities(text.replace(/<[^>]+>/g, ''))
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
