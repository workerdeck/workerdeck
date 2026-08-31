import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { contentTypeFor, json } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export async function handleProducedFiles(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  fileId?: string,
): Promise<void> {
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
  // statSync follows symlinks deliberately: a link the engine created is part of what it produced, and there is no root to realpath against.
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
  await new Promise<void>((done) => {
    const stream = createReadStream(found.path)
    stream.on('error', () => {
      res.destroy()
      done()
    })
    stream.on('close', () => done())
    stream.pipe(res)
  })
}
