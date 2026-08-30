/**
 * `{basePath}/sessions/:id/project/icon` — the bytes behind a `ProjectIcon.image` reference.
 *
 * Session-scoped on purpose: the caller's `/sessions/:id/*` `canSee` gate is the whole
 * authorization story, and the request carries **no path and no client input at all** beyond
 * the session id — the file served is whatever the gateway's own discovery resolved for this
 * session's cwd. Re-read at serve time through `readContained` and re-capped, because
 * resolve-time guarantees hold at resolve time only.
 *
 * "No icon" is one answer whatever the reason (no project, glyph-only, a refused declaration):
 * distinguishing them would tell a caller *why* a path outside the root was refused.
 *
 * `ETag` is the icon's own content hash — the value the wire's `ProjectIcon.image.hash`
 * carries — so a client that cached bytes by hash revalidates for free. `nosniff` + attachment
 * disposition because the bytes come out of a repo: an SVG must never render as a document on
 * the gateway's origin, and `<img src>` is unaffected by disposition.
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
