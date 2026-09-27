import { lstatSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WriteHostFileRequest } from '@workerdeck/protocol'
import { asUtf8, fail, hashBytes, json, readJsonBody, requireMethod } from '../lib/http.ts'
import { searchFiles } from '../services/host-file-search.ts'
import { entryKind, readContained, resolveExisting, resolveForWrite, writeContained, type HostFileRoots } from '../services/host-files.ts'
import type { ServerContext } from '../context.ts'

type FsCall = { ctx: ServerContext; hostFiles: HostFileRoots; req: IncomingMessage; res: ServerResponse; url: URL }

type ExistingKind = 'file' | 'dir'

const KIND_REFUSAL: Record<ExistingKind, string> = { dir: 'not a directory', file: 'not a regular file' }

const FS_ROUTES = new Map<string, (call: FsCall) => Promise<void> | void>([
  ['roots', handleRoots],
  ['find', handleFind],
  ['list', handleList],
  ['read', handleRead],
  ['write', handleWrite],
])

function kindRank(type: string): number {
  return type === 'dir' ? 0 : 1
}

export async function handleHostFiles(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { basePath, hostFiles } = ctx
  if (!hostFiles) {
    fail(404, 'host file access is not configured on this server')
  }
  const handler = FS_ROUTES.get(pathname.slice((basePath + '/fs/').length))
  if (!handler) {
    fail(404, 'not found')
  }
  await handler({ ctx, hostFiles, req, res, url: new URL(req.url ?? '/', 'http://internal') })
}

function requireExisting(hostFiles: HostFileRoots, url: URL, kind: ExistingKind): string {
  const requested = url.searchParams.get('path')
  if (!requested) {
    fail(400, 'path is required')
  }
  const resolved = resolveExisting(hostFiles, requested)
  if (!resolved.ok) {
    fail(resolved.status, resolved.error)
  }
  if (resolved.kind !== kind) {
    fail(400, KIND_REFUSAL[kind])
  }
  return resolved.path
}

function handleRoots({ ctx, hostFiles, req, res }: FsCall): void {
  requireMethod(req, 'GET')
  // The canonical spelling, not the operator's: a client round-tripping a root it was given must land on the same tree.
  json(res, 200, {
    roots: hostFiles.roots.map(({ canonical }) => ({
      path: canonical,
      name: basename(canonical) || canonical,
    })),
    canWrite: ctx.hostFilesWritable,
  })
}

function handleFind({ ctx, hostFiles, req, res, url }: FsCall): void {
  requireMethod(req, 'GET')
  const base = requireExisting(hostFiles, url, 'dir')
  // Clamped, not validated: this runs per keystroke from a phone.
  const asked = Number(url.searchParams.get('limit') ?? '')
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50
  const result = searchFiles(base, {
    query: url.searchParams.get('q') ?? '',
    limit,
    ignore: ctx.options.hostFiles?.ignore,
  })
  json(res, 200, { base, ...result })
}

function handleList({ ctx, hostFiles, req, res, url }: FsCall): void {
  requireMethod(req, 'GET')
  const dir = requireExisting(hostFiles, url, 'dir')
  const { maxHostDirEntries } = ctx
  let names: Dirent[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    fail(403, 'directory is not readable')
  }
  const truncated = names.length > maxHostDirEntries
  const entries = names.slice(0, maxHostDirEntries).map((entry) => {
    const path = join(dir, entry.name)
    const type = entryKind(entry)
    // Never stat *through* a link: a directory holding a link to a fifo would become unlistable.
    let bytes: number | undefined
    let modifiedAt: number | undefined
    if (type === 'file') {
      try {
        const s = lstatSync(path)
        bytes = s.size
        modifiedAt = s.mtimeMs
      } catch {}
    }
    return { name: entry.name, path, type, bytes, modifiedAt }
  })
  entries.sort((a, b) => kindRank(a.type) - kindRank(b.type) || a.name.localeCompare(b.name))
  json(res, 200, { path: dir, entries, ...(truncated ? { truncated } : {}) })
}

function handleRead({ ctx, hostFiles, req, res, url }: FsCall): void {
  requireMethod(req, 'GET')
  const path = requireExisting(hostFiles, url, 'file')
  const { maxHostFileBytes } = ctx
  const tooLarge = `file is larger than ${maxHostFileBytes} bytes`
  // Advisory pre-check only - the authoritative cap is on the bytes actually read, since the file can grow before the open.
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail(404, 'not found')
  }
  if (stats.size > maxHostFileBytes) {
    fail(413, tooLarge)
  }
  const read = readContained(path)
  if (!read.ok) {
    fail(read.status, read.error)
  }
  if (read.data.length > maxHostFileBytes) {
    fail(413, tooLarge)
  }
  const text = asUtf8(read.data)
  json(res, 200, {
    path,
    content: text ?? read.data.toString('base64'),
    encoding: text === null ? 'base64' : 'utf8',
    bytes: read.data.length,
    hash: hashBytes(read.data),
    modifiedAt: stats.mtimeMs,
  })
}

async function handleWrite({ ctx, hostFiles, req, res }: FsCall): Promise<void> {
  const { maxHostFileBytes } = ctx
  requireMethod(req, 'PUT')
  if (!ctx.hostFilesWritable) {
    fail(403, 'host file writes are not enabled on this server')
  }
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as WriteHostFileRequest
  if (!body.path || typeof body.path !== 'string') {
    fail(400, 'path is required')
  }
  if (typeof body.content !== 'string') {
    fail(400, 'content is required')
  }
  if (body.encoding !== undefined && body.encoding !== 'utf8' && body.encoding !== 'base64') {
    fail(400, "encoding must be 'utf8' or 'base64'")
  }
  const resolved = resolveForWrite(hostFiles, body.path)
  if (!resolved.ok) {
    fail(resolved.status, resolved.error)
  }
  const next = Buffer.from(body.content, body.encoding ?? 'utf8')
  if (next.length > maxHostFileBytes) {
    fail(413, `content is larger than ${maxHostFileBytes} bytes`)
  }
  // Existence is decided by the read, not a stat: only ENOENT is 404, so anything else refuses rather than being clobbered as a create.
  const current = readContained(resolved.path)
  if (!current.ok && current.status !== 404) {
    fail(current.status, current.error)
  }
  const existing = current.ok ? current.data : null
  if (existing && !body.expectedHash) {
    fail(409, 'file exists - pass expectedHash to overwrite it')
  }
  if (existing && hashBytes(existing) !== body.expectedHash) {
    fail(409, 'file changed on disk since it was read')
  }
  if (!existing && body.expectedHash) {
    fail(409, 'file no longer exists')
  }
  const written = writeContained(resolved.path, next)
  if (!written.ok) {
    fail(written.status, written.error)
  }
  let writtenAt = 0
  try {
    writtenAt = lstatSync(resolved.path).mtimeMs
  } catch {}
  json(res, 200, {
    path: resolved.path,
    bytes: next.length,
    hash: hashBytes(next),
    modifiedAt: writtenAt,
  })
}
