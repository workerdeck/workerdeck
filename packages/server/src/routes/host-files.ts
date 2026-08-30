/**
 * `{basePath}/fs/*` — the operator's real tree. Authorized by the auth key alone and
 * deliberately outside the agent permission flow: the caller is the operator.
 *
 * Every path here goes through `services/host-files.ts` first, which canonicalizes and *then*
 * re-checks containment. The naive prefix compare `cwdAllowed` does would be wrong at this
 * door — the agent writes into these trees, and a symlink it created is a path the operator
 * never typed.
 */
import { lstatSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WriteHostFileRequest } from '@workerdeck/protocol'
import { asUtf8, hashBytes, json, readJsonBody } from '../lib/http.ts'
import { searchFiles } from '../services/host-file-search.ts'
import { entryKind, readContained, resolveExisting, resolveForWrite, writeContained } from '../services/host-files.ts'
import type { ServerContext } from '../context.ts'

/** Directories sort before everything else. */
const kindRank = (type: string): number => (type === 'dir' ? 0 : 1)

export const handleHostFiles = async (ctx: ServerContext, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
  const { basePath, hostFiles, hostFilesWritable, maxHostFileBytes, maxHostDirEntries } = ctx
  if (!hostFiles) {
    json(res, 404, { error: 'host file access is not configured on this server' })
    return
  }
  const route = pathname.slice((basePath + '/fs/').length)
  const url = new URL(req.url ?? '/', 'http://internal')
  const requested = url.searchParams.get('path')

  if (route === 'roots') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    // The canonical spelling, not the operator's: every other route answers in canonical
    // paths, and a client that round-trips a root it was given must land on the same tree.
    json(res, 200, {
      roots: hostFiles.roots.map(({ canonical }) => ({
        path: canonical,
        name: basename(canonical) || canonical,
      })),
      canWrite: hostFilesWritable,
    })
    return
  }

  if (route === 'find') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requested) {
      json(res, 400, { error: 'path is required' })
      return
    }
    const resolved = resolveExisting(hostFiles, requested)
    if (!resolved.ok) {
      json(res, resolved.status, { error: resolved.error })
      return
    }
    if (resolved.kind !== 'dir') {
      json(res, 400, { error: 'not a directory' })
      return
    }
    // Clamped, not validated: this runs per keystroke from a phone.
    const asked = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50
    const result = searchFiles(resolved.path, {
      query: url.searchParams.get('q') ?? '',
      limit,
      ignore: ctx.options.hostFiles?.ignore,
    })
    json(res, 200, { base: resolved.path, ...result })
    return
  }

  if (route === 'list' || route === 'read') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requested) {
      json(res, 400, { error: 'path is required' })
      return
    }
    const resolved = resolveExisting(hostFiles, requested)
    if (!resolved.ok) {
      json(res, resolved.status, { error: resolved.error })
      return
    }
    if (route === 'list') {
      if (resolved.kind !== 'dir') {
        json(res, 400, { error: 'not a directory' })
        return
      }
      let names: Dirent[]
      try {
        names = readdirSync(resolved.path, { withFileTypes: true })
      } catch {
        json(res, 403, { error: 'directory is not readable' })
        return
      }
      const truncated = names.length > maxHostDirEntries
      const entries = names.slice(0, maxHostDirEntries).map((entry) => {
        const path = join(resolved.path, entry.name)
        const type = entryKind(entry)
        // Size/mtime for regular files only, and via lstat — a listing must never stat
        // *through* a link, or a directory holding a link to a fifo becomes unlistable.
        let bytes: number | undefined
        let modifiedAt: number | undefined
        if (type === 'file') {
          try {
            const s = lstatSync(path)
            bytes = s.size
            modifiedAt = s.mtimeMs
          } catch {
            // Raced with a delete, or unreadable — the entry still lists.
          }
        }
        return { name: entry.name, path, type, bytes, modifiedAt }
      })
      entries.sort((a, b) => kindRank(a.type) - kindRank(b.type) || a.name.localeCompare(b.name))
      json(res, 200, { path: resolved.path, entries, ...(truncated ? { truncated } : {}) })
      return
    }

    if (resolved.kind !== 'file') {
      json(res, 400, { error: 'not a regular file' })
      return
    }
    // Cheap pre-check so a gigabyte is refused rather than buffered. Advisory only — the
    // authoritative cap is on the bytes actually read, since the file can grow between the
    // stat and the open.
    let modifiedAt = 0
    try {
      const stats = lstatSync(resolved.path)
      if (stats.size > maxHostFileBytes) {
        json(res, 413, { error: `file is larger than ${maxHostFileBytes} bytes` })
        return
      }
      modifiedAt = stats.mtimeMs
    } catch {
      json(res, 404, { error: 'not found' })
      return
    }
    // Opens the canonical path with O_NOFOLLOW and gates on fstat, so a component swapped
    // for a symlink or a fifo after the resolve is refused rather than followed or blocked on.
    const read = readContained(resolved.path)
    if (!read.ok) {
      json(res, read.status, { error: read.error })
      return
    }
    if (read.data.length > maxHostFileBytes) {
      json(res, 413, { error: `file is larger than ${maxHostFileBytes} bytes` })
      return
    }
    const text = asUtf8(read.data)
    json(res, 200, {
      path: resolved.path,
      content: text ?? read.data.toString('base64'),
      encoding: text === null ? 'base64' : 'utf8',
      bytes: read.data.length,
      hash: hashBytes(read.data),
      modifiedAt,
    })
    return
  }

  if (route === 'write') {
    if (req.method !== 'PUT') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostFilesWritable) {
      json(res, 403, { error: 'host file writes are not enabled on this server' })
      return
    }
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as WriteHostFileRequest
    if (!body.path || typeof body.path !== 'string') {
      json(res, 400, { error: 'path is required' })
      return
    }
    if (typeof body.content !== 'string') {
      json(res, 400, { error: 'content is required' })
      return
    }
    if (body.encoding !== undefined && body.encoding !== 'utf8' && body.encoding !== 'base64') {
      json(res, 400, { error: "encoding must be 'utf8' or 'base64'" })
      return
    }
    const resolved = resolveForWrite(hostFiles, body.path)
    if (!resolved.ok) {
      json(res, resolved.status, { error: resolved.error })
      return
    }
    const next = Buffer.from(body.content, body.encoding ?? 'utf8')
    if (next.length > maxHostFileBytes) {
      json(res, 413, { error: `content is larger than ${maxHostFileBytes} bytes` })
      return
    }
    // The agent is editing this same tree, so every write is conditional: it either creates
    // a file that does not exist or names the hash it is replacing. Existence is decided by
    // the read, not by a stat — `readContained` answers 404 only for ENOENT, so anything else
    // refuses here instead of being mistaken for "not there yet" and clobbered as a create.
    const current = readContained(resolved.path)
    if (!current.ok && current.status !== 404) {
      json(res, current.status, { error: current.error })
      return
    }
    const existing = current.ok ? current.data : null
    if (existing && !body.expectedHash) {
      json(res, 409, { error: 'file exists — pass expectedHash to overwrite it' })
      return
    }
    if (existing && hashBytes(existing) !== body.expectedHash) {
      json(res, 409, { error: 'file changed on disk since it was read' })
      return
    }
    if (!existing && body.expectedHash) {
      json(res, 409, { error: 'file no longer exists' })
      return
    }
    const written = writeContained(resolved.path, next)
    if (!written.ok) {
      json(res, written.status, { error: written.error })
      return
    }
    let writtenAt = 0
    try {
      writtenAt = lstatSync(resolved.path).mtimeMs
    } catch {
      // The write landed; a stat that loses a race with a delete is not a failure.
    }
    json(res, 200, {
      path: resolved.path,
      bytes: next.length,
      hash: hashBytes(next),
      modifiedAt: writtenAt,
    })
    return
  }

  json(res, 404, { error: 'not found' })
}
