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
  if (!read.ok || read.data.length > MAX_PROJECT_ICON_BYTES) {
    json(res, 404, { error: 'no project icon' })
    return
  }
  res.writeHead(200, {
    'content-type': icon.mediaType,
    'content-length': read.data.length,
    etag,
    'cache-control': 'private, max-age=300',
    'content-disposition': 'attachment; filename="project-icon"',
    'x-content-type-options': 'nosniff',
  })
  res.end(read.data)
}
