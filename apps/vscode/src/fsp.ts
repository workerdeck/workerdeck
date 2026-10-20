import * as vscode from 'vscode'
import type { WorkerDeckClient } from '@workerdeck/client'
import { WorkerDeckError } from '@workerdeck/client'
import type { HostDirEntry } from '@workerdeck/protocol'
import type { HostStore } from './hosts.ts'
import { clientFor } from './gateway.ts'

export class WorkerdeckFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly scheme = 'workerdeck'

  readonly #store: HostStore
  readonly #emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.#emitter.event
  readonly #hashes = new Map<string, string>()
  readonly #canWrite = new Map<string, boolean>()

  constructor(store: HostStore) {
    this.#store = store
  }

  async #client(uri: vscode.Uri): Promise<WorkerDeckClient> {
    const host = this.#store.get(uri.authority)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      throw vscode.FileSystemError.Unavailable(`unknown workerdeck gateway: ${uri.authority}`)
    }
    return client
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const client = await this.#client(uri)
    // A directory answers /fs/list; a file answers its parent's listing, and most stats are for files.
    const path = uri.path
    const parent = path.replace(/\/[^/]*$/, '') || '/'
    if (parent !== path) {
      try {
        const listing = await client.listHostDir(parent)
        const entry = listing.entries.find((e) => e.path === path || e.name === path.slice(parent.length + 1))
        if (entry) {
          return statOf(entry)
        }
      } catch {
        // Parent unlistable (e.g. path IS a root) - fall through.
      }
    }
    try {
      await client.listHostDir(path)
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 }
    } catch (err) {
      throw toFsError(err, uri)
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const client = await this.#client(uri)
    try {
      const listing = await client.listHostDir(uri.path)
      return listing.entries.map((e) => [e.name, fileType(e)])
    } catch (err) {
      throw toFsError(err, uri)
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const client = await this.#client(uri)
    try {
      const res = await client.readHostFile(uri.path)
      this.#hashes.set(uri.toString(), res.hash)
      return res.encoding === 'base64' ? Uint8Array.from(Buffer.from(res.content, 'base64')) : new TextEncoder().encode(res.content)
    } catch (err) {
      throw toFsError(err, uri)
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const client = await this.#client(uri)
    if (!(await this.#writable(uri, client))) {
      throw vscode.FileSystemError.NoPermissions('this gateway is read-only (hostFiles.write is a separate server opt-in)')
    }
    const key = uri.toString()
    const expectedHash = this.#hashes.get(key) ?? (options.overwrite ? await currentHash(client, uri.path) : undefined)
    if (!expectedHash && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    try {
      const res = await client.writeHostFile({
        path: uri.path,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
        // Absent for a brand-new file: the server treats "no hash" as create-only.
        expectedHash,
      })
      this.#hashes.set(key, res.hash)
      this.#emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
    } catch (err) {
      if (err instanceof WorkerDeckError && err.status === 409) {
        throw vscode.FileSystemError.NoPermissions(
          `${uri.path} changed on the gateway (likely the agent) - close and re-open the file to take that version, or copy your edits first`,
        )
      }
      throw toFsError(err, uri)
    }
  }

  async #writable(uri: vscode.Uri, client: WorkerDeckClient): Promise<boolean> {
    const cached = this.#canWrite.get(uri.authority)
    if (cached !== undefined) {
      return cached
    }
    try {
      const roots = await client.listHostRoots()
      const canWrite = roots.canWrite === true
      this.#canWrite.set(uri.authority, canWrite)
      return canWrite
    } catch {
      return false
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.#mutate(uri, (client) => client.makeHostDir(uri.path), [{ type: vscode.FileChangeType.Created, uri }])
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.#mutate(uri, (client) => client.deleteHostEntry(uri.path, options.recursive), [{ type: vscode.FileChangeType.Deleted, uri }])
    this.#hashes.delete(uri.toString())
  }

  // The gateway never renames over an existing entry, so `overwrite` surfaces as FileExists rather than a clobber.
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    await this.#mutate(oldUri, (client) => client.renameHostEntry(oldUri.path, newUri.path), [
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ])
    this.#hashes.delete(oldUri.toString())
  }

  async #mutate(uri: vscode.Uri, run: (client: WorkerDeckClient) => Promise<unknown>, events: vscode.FileChangeEvent[]): Promise<void> {
    const client = await this.#client(uri)
    if (!(await this.#writable(uri, client))) {
      throw vscode.FileSystemError.NoPermissions('this gateway is read-only (hostFiles.write is a separate server opt-in)')
    }
    try {
      await run(client)
    } catch (err) {
      throw toFsError(err, uri)
    }
    this.#emitter.fire(events)
  }

  refresh(uri: vscode.Uri): void {
    this.#emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
  }

  dispose(): void {
    this.#emitter.dispose()
  }
}

function fileType(entry: HostDirEntry): vscode.FileType {
  switch (entry.type) {
    case 'dir': {
      return vscode.FileType.Directory
    }
    case 'file': {
      return vscode.FileType.File
    }
    case 'symlink': {
      return vscode.FileType.SymbolicLink
    }
    default: {
      return vscode.FileType.Unknown
    }
  }
}

function statOf(entry: HostDirEntry): vscode.FileStat {
  return {
    type: fileType(entry),
    ctime: 0,
    mtime: entry.modifiedAt ?? 0,
    size: entry.bytes ?? 0,
  }
}

async function currentHash(client: WorkerDeckClient, path: string): Promise<string | undefined> {
  try {
    return (await client.readHostFile(path)).hash
  } catch {
    return undefined
  }
}

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof WorkerDeckError) {
    if (err.status === 409) {
      return vscode.FileSystemError.FileExists(uri)
    }
    if (err.status === 404) {
      return vscode.FileSystemError.FileNotFound(uri)
    }
    if (err.status === 403) {
      return vscode.FileSystemError.NoPermissions(uri)
    }
    if (err.status === 413) {
      return vscode.FileSystemError.Unavailable(`${uri.path}: too large for the gateway to serve`)
    }
  }
  return err instanceof Error ? err : new Error(String(err))
}
