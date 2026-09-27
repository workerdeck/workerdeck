import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from 'node:dns'
import { lookup as dnsLookupAll } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export type WebFetchResult = {
  url: string
  digest?: string
  markdown?: string
  truncated?: boolean
  notice?: string
  redirectUrl?: string
  error?: string
}

export type WebFetchFn = (url: string, prompt: string) => Promise<WebFetchResult>

export type WebFetchDigest = (markdown: string, prompt: string) => Promise<string>

export type WebFetchOptions = {
  fetchImpl?: typeof fetch
  maxContentBytes?: number
  maxMarkdownBytes?: number
  cacheTtlMs?: number
  allowedHosts?: string[]
  timeoutMs?: number
  digest?: WebFetchDigest
}

const MAX_CACHE_ENTRIES = 64
const MAX_REDIRECTS = 5

type CacheEntry = { expiresAt: number; page: WebFetchResult }

type GuardedLookupCallback = (error: NodeJS.ErrnoException | null, address: string, family: number) => void

export function createWebFetch(options: WebFetchOptions = {}): WebFetchFn {
  const fetchImpl = options.fetchImpl ?? (guardedFetch as unknown as typeof fetch)
  const maxContentBytes = options.maxContentBytes ?? 1024 * 1024
  const maxMarkdownBytes = options.maxMarkdownBytes ?? 50 * 1024
  const cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000
  const cache = new Map<string, CacheEntry>()

  const fetchPage = async (rawUrl: string): Promise<WebFetchResult> => {
    const cached = cache.get(rawUrl)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.page
    }

    let url = parseUrl(rawUrl)
    if (!url) {
      return { url: rawUrl, error: 'only absolute http(s) URLs are supported' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
    try {
      let response: Response
      for (let hop = 0; ; hop++) {
        const denied = await urlDenyReason(url, options.allowedHosts)
        if (denied) {
          return { url: url.href, error: denied }
        }
        response = await fetchImpl(url.href, {
          redirect: 'manual',
          signal: controller.signal,
        })
        if (response.status < 300 || response.status >= 400) {
          break
        }
        const location = response.headers.get('location')
        if (!location) {
          return { url: url.href, error: `redirect (${response.status}) without a location` }
        }
        const target = parseUrl(new URL(location, url).href)
        if (!target) {
          return { url: url.href, error: `redirect to unsupported URL: ${location}` }
        }
        if (target.host !== url.host) {
          return {
            url: url.href,
            redirectUrl: target.href,
            notice: `redirected to a different host (${target.host}); not followed automatically`,
          }
        }
        if (hop >= MAX_REDIRECTS) {
          return { url: url.href, error: 'too many redirects' }
        }
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
      const text = contentType.includes('html') || looksLikeHtml(body) ? htmlToMarkdown(body) : body
      const truncated = text.length > maxMarkdownBytes
      const page: WebFetchResult = {
        url: url.href,
        markdown: truncated ? text.slice(0, maxMarkdownBytes) : text,
        truncated: truncated || undefined,
      }
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) {
          cache.delete(oldest)
        }
      }
      cache.set(rawUrl, { expiresAt: Date.now() + cacheTtlMs, page })
      return page
    } catch (error) {
      const message = controller.signal.aborted ? 'request timed out' : error instanceof Error ? error.message : String(error)
      return { url: url.href, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  return async (rawUrl, prompt) => {
    const page = await fetchPage(rawUrl)
    if (page.error || page.notice || !options.digest || page.markdown === undefined) {
      return page
    }
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

// Checked before the request and again at connect time by `guardedFetch`'s lookup, which closes the rebinding window a
// resolve-then-fetch check leaves open. A host-supplied `fetchImpl` gets the pre-check only.
export async function urlDenyReason(url: URL, allowedHosts: string[] | undefined): Promise<string | null> {
  const host = url.hostname.toLowerCase()
  if (allowedHosts && allowedHosts.length > 0 && !hostMatches(host, allowedHosts)) {
    return `host not allowed: ${host}`
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `host not allowed: ${host}`
  }
  const literal = host.replace(/^\[|\]$/g, '')
  if (isIP(literal) !== 0) {
    return isPrivateAddress(literal) ? `address not allowed: ${literal}` : null
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await dnsLookupAll(literal, { all: true })
  } catch {
    return `cannot resolve host: ${host}`
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return `host resolves to a private address: ${host}`
    }
  }
  return null
}

export function hostMatches(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    if (!pattern) {
      return false
    }
    if (pattern.startsWith('*.')) {
      return host.endsWith(pattern.slice(1))
    }
    return host === pattern
  })
}

// Anything that is not a parseable IP literal is not an address, so it answers false; hostnames are the caller's to resolve.
export function isPrivateAddress(address: string): boolean {
  const ip = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
  const family = isIP(ip)
  if (family === 4) {
    return isPrivateIpv4(ip.split('.').map(Number))
  }
  if (family === 6) {
    return isPrivateIpv6(parseIpv6(ip))
  }
  return false
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) {
    return true
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true
  }
  if (a === 169 && b === 254) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  if (a === 192 && (b === 168 || (b === 0 && c === 0))) {
    return true
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true
  }
  return a >= 224
}

// Every range that embeds or routes to an IPv4 address is judged by that address; the rest of the special-purpose
// space (loopback, unspecified, ULA, link- and site-local, multicast, Teredo, discard) is refused outright.
function isPrivateIpv6(words: number[]): boolean {
  const embedded = [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff]
  const zeroTo = (n: number): boolean => words.slice(0, n).every((w) => w === 0)
  if (zeroTo(6)) {
    return true
  }
  if (zeroTo(5) && words[5] === 0xffff) {
    return isPrivateIpv4(embedded)
  }
  if (zeroTo(4) && words[4] === 0xffff && words[5] === 0) {
    return isPrivateIpv4(embedded)
  }
  if (words[0] === 0x64 && words[1] === 0xff9b) {
    return words[2] !== 0 || words[3] !== 0 || words[4] !== 0 || words[5] !== 0 || isPrivateIpv4(embedded)
  }
  if (words[0] === 0x2002) {
    return isPrivateIpv4([words[1]! >> 8, words[1]! & 0xff, words[2]! >> 8, words[2]! & 0xff])
  }
  if (words[0] === 0x2001 && words[1] === 0) {
    return true
  }
  if (words[0] === 0x100 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    return true
  }
  const first = words[0]!
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
}

function parseIpv6(ip: string): number[] {
  const text = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a: string, b: string, c: string, d: string) => {
    const word = (hi: string, lo: string): string => ((Number(hi) << 8) | Number(lo)).toString(16)
    return `${word(a, b)}:${word(c, d)}`
  })
  const [head, rest] = text.split('::') as [string, string | undefined]
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16)))
  const front = parse(head)
  const back = parse(rest ?? '')
  const fill = rest === undefined ? [] : Array.from({ length: Math.max(0, 8 - front.length - back.length) }, () => 0)
  return [...front, ...fill, ...back]
}

// Refuses at connect time, after the socket's own resolution: the one check a rebinding DNS answer cannot race.
export function guardedLookup(hostname: string, options: LookupOptions, callback: GuardedLookupCallback): void {
  dnsLookupCb(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0)
      return
    }
    const list = addresses as LookupAddress[]
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      callback(Object.assign(new Error(`host resolves to a private address: ${hostname}`), { code: 'EPRIVATEADDR' }), '', 0)
      return
    }
    if (options.all === true) {
      ;(callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list)
    } else {
      callback(null, list[0]!.address, list[0]!.family)
    }
  })
}

// `fetch` on node:http(s) with `guardedLookup` pinned, never following a redirect: the caller vets every hop.
export function guardedFetch(
  input: string,
  init: { method?: string; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(input)
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) !== 0 && isPrivateAddress(literal)) {
    return Promise.reject(new Error(`address not allowed: ${literal}`))
  }
  const send = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : undefined
  if (send === undefined) {
    return Promise.reject(new Error(`unsupported protocol: ${url.protocol}`))
  }
  const method = init.method ?? 'GET'
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method,
        signal: init.signal,
        lookup: guardedLookup as unknown as LookupFunction,
        headers: { 'user-agent': 'node', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...init.headers },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            headers.append(name, item)
          }
        }
        if (method === 'HEAD' || status === 204 || status === 304 || status < 200) {
          res.resume()
          resolve(new Response(null, { status: status < 200 ? 502 : status, headers }))
          return
        }
        const body = decodedBody(res, headers)
        resolve(new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function decodedBody(res: IncomingMessage, headers: Headers): Readable {
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined
  if (decoder === undefined) {
    return res
  }
  headers.delete('content-encoding')
  headers.delete('content-length')
  return res.pipe(decoder)
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
    if (done) {
      break
    }
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
      if (!label || href.startsWith('#') || href.startsWith('javascript:')) {
        return label
      }
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
