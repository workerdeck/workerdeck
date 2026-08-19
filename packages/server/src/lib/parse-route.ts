/** The `/sessions` route family, parsed. Pattern:
 * {basePath}/sessions[/:id[/ws | /permissions/:requestId | /files[/<path>] |
 *   /attachments[/:attachmentId] | /mcp[/:serverName] | /produced[/:fileId] |
 *   /events/:seq/result]]
 */
export type SessionRoute = {
  id?: string
  ws?: boolean
  permissionId?: string
  files?: boolean
  filePath?: string
  attachments?: boolean
  attachmentId?: string
  mcp?: boolean
  mcpServer?: string
  produced?: boolean
  producedFileId?: string
  /** `/events/:seq/result` — the untruncated tool result in that event. */
  resultSeq?: number
}

export function parseSessionRoute(basePath: string, url: string): SessionRoute | null {
  const pathname = new URL(url, 'http://internal').pathname
  if (!pathname.startsWith(basePath + '/sessions')) return null
  const rest = pathname.slice((basePath + '/sessions').length)
  if (rest === '' || rest === '/') return {}
  const parts = rest.replace(/^\//, '').split('/')
  if (parts.length === 1) return { id: decodeURIComponent(parts[0]!) }
  if (parts.length === 2 && parts[1] === 'ws') {
    return { id: decodeURIComponent(parts[0]!), ws: true }
  }
  if (parts.length === 3 && parts[1] === 'permissions') {
    return { id: decodeURIComponent(parts[0]!), permissionId: decodeURIComponent(parts[2]!) }
  }
  if (parts.length <= 3 && parts[1] === 'attachments') {
    return {
      id: decodeURIComponent(parts[0]!),
      attachments: true,
      attachmentId: parts[2] === undefined ? undefined : decodeURIComponent(parts[2]),
    }
  }
  if (parts.length <= 3 && parts[1] === 'produced') {
    return {
      id: decodeURIComponent(parts[0]!),
      produced: true,
      producedFileId: parts[2] === undefined ? undefined : decodeURIComponent(parts[2]),
    }
  }
  if (parts.length === 4 && parts[1] === 'events' && parts[3] === 'result') {
    const seq = Number(parts[2])
    if (!Number.isInteger(seq) || seq < 0) return null
    return { id: decodeURIComponent(parts[0]!), resultSeq: seq }
  }
  if (parts.length <= 3 && parts[1] === 'mcp') {
    // Server names are opaque and may contain ':' (plugin:gtm:gtm) — one segment,
    // decoded whole.
    return {
      id: decodeURIComponent(parts[0]!),
      mcp: true,
      mcpServer: parts[2] === undefined ? undefined : decodeURIComponent(parts[2]),
    }
  }
  if (parts.length >= 2 && parts[1] === 'files') {
    // The remainder is a VFS path — slashes are its separators, so segments
    // are decoded individually and rejoined.
    const filePath = parts.slice(2).map(decodeURIComponent).join('/')
    return {
      id: decodeURIComponent(parts[0]!),
      files: true,
      filePath: filePath === '' ? undefined : '/' + filePath,
    }
  }
  return null
}
