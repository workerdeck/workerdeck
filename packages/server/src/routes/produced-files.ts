import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { contentTypeFor, fail, json, requireMethod, untrustedDownloadHeaders } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export async function handleProducedFiles(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  fileId?: string,
): Promise<void> {
  const { producedFiles } = ctx
  requireMethod(req, 'GET')
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
    fail(404, 'no such produced file')
  }
  // statSync follows symlinks deliberately: a link the engine created is part of what it produced, and there is no root to realpath against.
  let stat
  try {
    stat = statSync(found.path)
  } catch {
    fail(404, 'produced file is no longer on disk')
  }
  if (!stat.isFile()) {
    fail(404, 'produced file is not a regular file')
  }
  const filename = basename(found.path) || 'file'
  res.writeHead(200, untrustedDownloadHeaders(filename, found.mediaType ?? contentTypeFor(filename), stat.size))
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
