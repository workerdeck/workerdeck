import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) {
    return 'application/octet-stream'
  }
  return CONTENT_TYPES[pathname.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

export function looksLikeAsset(pathname: string): boolean {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) {
    return false
  }
  return pathname.slice(dot).toLowerCase() in CONTENT_TYPES
}

export function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  // Never normalise `decoded` first: that collapses an absolute pathname's leading `..` segments and rebases the
  // escape attempt inside the root, leaving the containment check below with nothing to catch.
  const candidate = resolve(join(root, decoded))
  const base = resolve(root)
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    return null
  }
  return candidate
}

// Images stay on this origin (plus loopback gateways, which a page cannot exfiltrate to), so markdown in a transcript
// cannot beacon anywhere; `connect-src` stays open because the dashboard talks to other gateways by design. Inline
// scripts are admitted by hash, computed from the document actually served.
export function dashboardCsp(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]!, 'utf8').digest('base64')}'`,
  )
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function htmlHeaders(html: string): Record<string, string> {
  return {
    'content-security-policy': dashboardCsp(html),
    // The dashboard holds an ambient session cookie, so framing it elsewhere is only ever clickjacking.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
}

export function sendHtml(req: IncomingMessage, res: ServerResponse, status: number, html: string, cache: string): void {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': cache,
    ...htmlHeaders(html),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export type ServeResult = 'served' | 'not-found' | 'method-not-allowed'

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: { immutable?: boolean } = {},
): Promise<ServeResult> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return 'method-not-allowed'
  }

  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return 'not-found'
    }
    size = info.size
  } catch {
    return 'not-found'
  }

  const contentType = contentTypeFor(filePath)
  if (contentType.startsWith('text/html')) {
    const html = await readFile(filePath, 'utf8').catch(() => undefined)
    if (html === undefined) {
      return 'not-found'
    }
    sendHtml(req, res, 200, html, options.immutable ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate')
    return 'served'
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': options.immutable ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return 'served'
  }
  await new Promise<void>((resolvePromise) => {
    const stream = createReadStream(filePath)
    stream.on('error', () => {
      res.destroy()
      resolvePromise()
    })
    stream.on('end', () => resolvePromise())
    stream.pipe(res)
  })
  return 'served'
}
