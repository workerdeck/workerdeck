/**
 * `{basePath}/sessions/:id/project/icon` — the bytes behind a
 * `ProjectIcon.image` reference.
 *
 * Session-scoped on purpose, like `/events/:seq/result`: the caller's
 * `/sessions/:id/*` `canSee` gate runs before this does, which is the whole
 * authorization story — a scoped principal's miss is the uniform 404 before
 * any filesystem is consulted, and no second policy exists to drift. A
 * project-keyed route would have needed the project root in its URL, and a
 * route addressed by host paths is an existence oracle for the gateway's
 * filesystem.
 *
 * The request carries **no path and no client input at all** beyond the
 * session id: the file served is whatever the gateway's own discovery resolved
 * for this session's cwd (realpath-contained in the project root, png/svg,
 * size-capped — see `ProjectInfoService`). Re-read at serve time through
 * `readContained` and re-capped, because resolve-time guarantees hold at
 * resolve time only.
 *
 * "No icon" is one answer whatever the reason — no project, a glyph-only
 * project, or a declared icon the resolver refused (escaping, oversized,
 * malformed): distinguishing them would tell a caller *why* a path outside the
 * root was refused, which is the disclosure the uniform answer withholds.
 *
 * `ETag` is the icon's own content hash — the same value the wire's
 * `ProjectIcon.image.hash` carries — so a client that cached bytes by hash
 * revalidates for free and two sessions in one project share one cache entry.
 * `nosniff` + attachment disposition because the bytes come out of a repo
 * (cloned from anywhere, writable by the agent): an SVG must never render as a
 * document on the gateway's origin, and `<img src>` is unaffected by
 * disposition, which is the point (produced-files' rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../lib/http.ts'
import { readContained } from '../services/host-files.ts'
import { MAX_PROJECT_ICON_BYTES, type ProjectInfoService } from '../services/project-info.ts'

export function handleProjectIcon(projects: ProjectInfoService, req: IncomingMessage, res: ServerResponse, cwd: string): void {
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
  // Refused between resolve and open (swapped for a symlink, replaced by a
  // fifo, grown past the cap): the same single answer as "no icon".
  if (!read.ok || read.data.length > MAX_PROJECT_ICON_BYTES) {
    json(res, 404, { error: 'no project icon' })
    return
  }
  res.writeHead(200, {
    'content-type': icon.mediaType,
    'content-length': read.data.length,
    etag,
    // Short and private: the wire's hash tells a client exactly when to
    // refetch, so the browser cache only has to bridge one poll interval —
    // and a project icon swap should not take an hour to reach a dashboard.
    'cache-control': 'private, max-age=300',
    'content-disposition': 'attachment; filename="project-icon"',
    'x-content-type-options': 'nosniff',
  })
  res.end(read.data)
}
