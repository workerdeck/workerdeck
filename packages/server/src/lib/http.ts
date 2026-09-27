import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
}

// Headers for serving user-controlled bytes (attachments, produced files, sandbox VFS reads):
// force download and forbid MIME sniffing so a crafted HTML/SVG payload can never execute in the
// gateway's origin. Every byte-serving route must use this.
export function untrustedDownloadHeaders(filename: string, contentType: string, byteLength: number): Record<string, string | number> {
  return {
    'content-type': contentType,
    'content-length': byteLength,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'x-content-type-options': 'nosniff',
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export type Refusal = { status: number; error: string }

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function fail(status: number, message: string): never {
  throw new HttpError(status, message)
}

export function requireMethod(req: IncomingMessage, ...methods: string[]): void {
  if (!methods.includes(req.method ?? '')) {
    fail(405, 'method not allowed')
  }
}

export function sendUntrusted(res: ServerResponse, filename: string, contentType: string, bytes: Buffer | string): void {
  res.writeHead(200, untrustedDownloadHeaders(filename, contentType, Buffer.byteLength(bytes)))
  res.end(bytes)
}

export function httpErrorStatus(error: unknown): number {
  if (error instanceof HttpError) {
    return error.status
  }
  return error instanceof SyntaxError ? 400 : 500
}

// A cross-site page can send `text/plain` (or a typeless Blob) without a preflight, so a JSON route that parsed any
// body would be reachable by a drive-by form post. Only an empty body may omit the header.
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const mime = mediaTypeOf(req.headers['content-type'])
  if (mime !== undefined && !isJsonMediaType(mime)) {
    throw new HttpError(415, 'expected content-type application/json')
  }
  const body = await readRawBody(req, maxBytes)
  if (body.length === 0) {
    return {}
  }
  if (mime === undefined) {
    throw new HttpError(415, 'expected content-type application/json')
  }
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>
}

function mediaTypeOf(header: string | undefined): string | undefined {
  const mime = header?.split(';')[0].trim().toLowerCase()
  return mime === undefined || mime === '' ? undefined : mime
}

function isJsonMediaType(mime: string): boolean {
  return mime === 'application/json' || (mime.startsWith('application/') && mime.endsWith('+json'))
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) {
      throw new HttpError(413, 'request body too large')
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Decoding never fails in Node - invalid bytes become U+FFFD - so a round trip is the only honest test.
export function asUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

export function contentTypeFor(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8'
}

export function refuseUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}
