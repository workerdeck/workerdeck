import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Conservative content types for VFS downloads: text formats the agent actually
 * produces; anything unrecognized ships as plain text (the VFS is string-backed). */
const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
}

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export const readJsonBody = async (req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> => {
  const body = await readRawBody(req, maxBytes)
  if (body.length === 0) {
    return {}
  }
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>
}

/** Body as bytes, refusing anything over `maxBytes`. Attachments are the one
 * thing this server takes that isn't JSON. */
export const readRawBody = async (req: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) {
      throw new Error('request body too large')
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** sha256 hex — the currency of the conditional-write protocol on `/fs/write`. */
export const hashBytes = (bytes: Buffer): string => {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The file's text, or null if it isn't text. Decoding never fails in Node — invalid
 * bytes become U+FFFD — so the only honest test is a round trip: if re-encoding the
 * decoded string reproduces the original bytes, nothing was lost and the client can
 * safely edit and send it back. Anything else ships base64, which an editor can
 * refuse to open rather than silently corrupt on save.
 */
export const asUtf8 = (bytes: Buffer): string | null => {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

export const contentTypeFor = (filename: string): string => {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8'
}
