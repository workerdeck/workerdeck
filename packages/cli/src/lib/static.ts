import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'

/**
 * Static file serving for the bundled dashboard. Deliberately policy-free: what
 * counts as a document, and whether an unauthenticated visitor gets the app or a
 * login page, is decided by the caller (see `instance.ts`). This module only
 * answers "is there such a file, and what headers does it want".
 */

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
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[pathname.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/** A request for a file rather than an app route: anything with a known extension. */
export function looksLikeAsset(pathname: string): boolean {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) return false
  return pathname.slice(dot).toLowerCase() in CONTENT_TYPES
}

/**
 * Resolve `pathname` inside `root`, or null if it escapes. Vite emits every
 * asset under a content-hashed name, so the only paths that ever reach here are
 * ones the app itself generated — but this server is reachable by anything that
 * can open a socket, and `..` in a URL is the oldest trick there is.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null
  // Joined *without* normalising `decoded` first: normalising an absolute
  // pathname collapses its leading `..` segments, which quietly rebases an
  // escape attempt inside the root and leaves the containment check below with
  // nothing to catch. Let `join` resolve the traversal for real, then reject it.
  const candidate = resolve(join(root, decoded))
  const base = resolve(root)
  if (candidate !== base && !candidate.startsWith(base + sep)) return null
  return candidate
}

export function sendHtml(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  html: string,
  cache: string,
): void {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': cache,
    // The dashboard is same-origin with the API and holds an ambient session
    // cookie; framing it elsewhere is only ever clickjacking.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export type ServeResult = 'served' | 'not-found' | 'method-not-allowed'

/**
 * Stream a file out of `root`. `immutable` is the caller's call, because it is a
 * promise about the URL, not the file: Vite's hashed assets can be cached
 * forever, but index.html must be revalidated every time or a deployed update
 * never reaches a browser that already has the old one.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: { immutable?: boolean } = {},
): Promise<ServeResult> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return 'method-not-allowed'

  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return 'not-found'
    size = info.size
  } catch {
    return 'not-found'
  }

  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': size,
    'cache-control': options.immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, must-revalidate',
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
