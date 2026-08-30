/**
 * `{basePath}/sessions/:id/produced[/:fileId]` — files this session's ENGINE wrote on the
 * host (codex's generated images), listed and served.
 *
 * The one route with no root allowlist and no byte cap: the allowlist is the exact set of
 * paths this session's own runner announced producing. NOT a hole in `/fs/*` — a path the
 * *agent* named is not a produced file and never enters this store.
 *
 * `nosniff` + attachment disposition like the attachment download, because these bytes are
 * model-authored and must not render as a document on the gateway's origin.
 */
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { contentTypeFor, json } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export const handleProducedFiles = async (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  fileId?: string,
): Promise<void> => {
  const { producedFiles } = ctx
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  if (fileId === undefined) {
    json(res, 200, {
      files: producedFiles.list(sessionId).map(({ fileId: id, path, mediaType, bytes }) => ({
        fileId: id,
        path,
        ...(mediaType ? { mediaType } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
      })),
    })
    return
  }
  const found = producedFiles.get(sessionId, fileId)
  if (!found) {
    json(res, 404, { error: 'no such produced file' })
    return
  }
  // Re-checked at serve time: the file may have been moved, replaced or turned into a
  // directory since it was announced. `statSync` follows symlinks deliberately — a link the
  // engine itself created is part of what it produced, and there is no containment root here
  // for a realpath check to compare against.
  let stat
  try {
    stat = statSync(found.path)
  } catch {
    json(res, 404, { error: 'produced file is no longer on disk' })
    return
  }
  if (!stat.isFile()) {
    json(res, 404, { error: 'produced file is not a regular file' })
    return
  }
  const filename = basename(found.path) || 'file'
  res.writeHead(200, {
    'content-type': found.mediaType ?? contentTypeFor(filename),
    'content-length': stat.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'x-content-type-options': 'nosniff',
  })
  // Streamed rather than read whole: there is no cap on this route, so buffering would put
  // the file size straight into the gateway's heap.
  await new Promise<void>((done) => {
    const stream = createReadStream(found.path)
    stream.on('error', () => {
      // Headers are already out; a truncated response is the only honest signal left.
      res.destroy()
      done()
    })
    stream.on('close', () => done())
    stream.pipe(res)
  })
}
