/**
 * `{basePath}/sessions/:id/project/icon` — the bytes behind a `ProjectIcon.image` reference.
 *
 * The request carries **no path and no client input at all** beyond the session id, so the
 * `/sessions/:id/*` `canSee` gate is the whole authorization story; the bytes are re-read at
 * serve time through `readContained` and re-capped, because resolve-time guarantees hold at
 * resolve time only. "No icon" is one 404 whatever the reason. See `docs/PACKAGES.md`
 * §`packages/server`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../lib/http.ts'
import { readContained } from '../services/host-files.ts'
import { MAX_PROJECT_ICON_BYTES, type ProjectInfoService } from '../services/project-info.ts'

export const handleProjectIcon = (projects: ProjectInfoService, req: IncomingMessage, res: ServerResponse, cwd: string): void => {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const icon = projects.iconFor(cwd)
  if (!icon) {
    json(res, 404, { error: 'no project icon' })
    return
  }
  const etag = `"${icon.hash}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const read = readContained(icon.path)
  // Refused between resolve and open (swapped for a symlink, replaced by a fifo, grown past
  // the cap): the same single answer as "no icon".
  if (!read.ok || read.data.length > MAX_PROJECT_ICON_BYTES) {
    json(res, 404, { error: 'no project icon' })
    return
  }
  res.writeHead(200, {
    'content-type': icon.mediaType,
    'content-length': read.data.length,
    etag,
    // Short and private: the wire's hash tells a client when to refetch, so the browser cache
    // only has to bridge one poll interval.
    'cache-control': 'private, max-age=300',
    'content-disposition': 'attachment; filename="project-icon"',
    'x-content-type-options': 'nosniff',
  })
  res.end(read.data)
}
