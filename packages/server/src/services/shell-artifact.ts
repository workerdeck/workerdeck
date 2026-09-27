import { mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { ttyText } from '@workerdeck/core'
import { isMissing, writeFileAtomic } from '../lib/atomic-file.ts'

export { isMissing }

export type ArtifactLimits = { spill: number; cap: number; ring: number }

export type ArtifactPaths = { dir: string; raw: string; tail: string; rel: string }

export type StoredOutput = { output?: string; artifact?: string }

export type ShellArtifact = LiveArtifact | StoredArtifact

export function artifactPaths(base: string, sessionId: string, shellId: string): ArtifactPaths {
  const encoded = encodeURIComponent(sessionId)
  const sessionDir = join(base, encoded)
  return {
    dir: sessionDir,
    raw: join(sessionDir, `${shellId}.raw`),
    tail: join(sessionDir, `${shellId}.tail.raw`),
    rel: `${encoded}/${shellId}.raw`,
  }
}

export class LiveArtifact {
  readonly #paths: ArtifactPaths
  readonly #limits: ArtifactLimits
  readonly #onError: (error: unknown) => void
  readonly #ring: Buffer
  #ringAt = 0
  #ringLen = 0
  #chunks: Buffer[] = []
  #chunkBytes = 0
  #bytes = 0
  #spilled = false
  #capped = false
  #closed = false
  #broken = false
  #io: Promise<void> = Promise.resolve()
  #handle: FileHandle | undefined
  #done = ''
  #pending = ''
  #textCache: string | undefined

  constructor(paths: ArtifactPaths, limits: ArtifactLimits, onError: (error: unknown) => void) {
    this.#paths = paths
    this.#limits = limits
    this.#onError = onError
    this.#ring = Buffer.alloc(Math.max(0, limits.ring))
  }

  get bytes(): number {
    return this.#bytes
  }

  get capped(): boolean {
    return this.#capped
  }

  append(data: string): boolean {
    const chunk = Buffer.from(data, 'utf8')
    const before = this.#bytes
    this.#bytes += chunk.length
    this.#ringPush(chunk)
    this.#textCache = undefined
    if (this.#capped) {
      return false
    }
    const room = Math.max(0, this.#limits.cap - before)
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room)
    this.#textAppend(kept === chunk ? data : kept.toString('utf8'))
    let changed = false
    if (this.#spilled) {
      this.#write(kept)
    } else {
      this.#chunks.push(kept)
      this.#chunkBytes += kept.length
      if (this.#chunkBytes > this.#limits.spill) {
        this.#spill()
        changed = true
      }
    }
    if (this.#bytes > this.#limits.cap) {
      this.#capped = true
      changed = true
    }
    return changed
  }

  text(): string {
    if (this.#textCache === undefined) {
      let text = this.#done + ttyText(this.#pending)
      if (this.#capped) {
        const after = this.#bytes - this.#limits.cap
        const kept = Math.min(after, this.#ringLen)
        if (kept > 0) {
          text += (after > kept ? '\n' : '') + ttyText(this.tail(kept).toString('utf8'))
        }
      }
      this.#textCache = text
    }
    return this.#textCache
  }

  textView(): Promise<string> {
    return Promise.resolve(this.text())
  }

  tail(n: number = this.#ringLen): Buffer {
    const size = this.#ring.length
    const take = Math.max(0, Math.min(n, this.#ringLen))
    const out = Buffer.allocUnsafe(take)
    if (take === 0) {
      return out
    }
    const start = (this.#ringAt - take + size) % size
    const first = Math.min(take, size - start)
    this.#ring.copy(out, 0, start, start + first)
    if (first < take) {
      this.#ring.copy(out, first, 0, take - first)
    }
    return out
  }

  replay(max: number): Promise<Buffer> {
    const want = Math.max(0, Math.floor(max))
    if (!this.#spilled) {
      const all = Buffer.concat(this.#chunks, this.#chunkBytes)
      return Promise.resolve(all.subarray(Math.max(0, all.length - want)))
    }
    if (this.#capped || want <= this.#ringLen) {
      return Promise.resolve(this.tail(want))
    }
    const end = this.#bytes
    return this.#io.then(() => readRange(this.#paths.raw, Math.max(0, end - want), end))
  }

  async read(tail?: number): Promise<Buffer> {
    if (tail !== undefined) {
      return this.replay(tail)
    }
    if (!this.#spilled) {
      return Buffer.concat(this.#chunks, this.#chunkBytes)
    }
    await this.#io
    return readWhole(this.#paths.raw)
  }

  stored(): StoredOutput {
    return this.#spilled ? { artifact: this.#paths.rel } : { output: Buffer.concat(this.#chunks, this.#chunkBytes).toString('utf8') }
  }

  writeTail(): void {
    const tail = this.tail()
    this.#queue(() => writeFileAtomic(this.#paths.tail, tail))
  }

  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    if (this.#capped) {
      this.writeTail()
    }
    this.#io = this.#io.then(async () => {
      const handle = this.#handle
      this.#handle = undefined
      await handle?.close().catch(() => {})
    })
  }

  idle(): Promise<void> {
    return this.#io
  }

  async remove(): Promise<void> {
    this.close()
    await this.#io
    await rm(this.#paths.raw, { force: true })
    await rm(this.#paths.tail, { force: true })
  }

  // Only the new chunk is searched: `#pending` holds no newline by construction, and scanning it again per chunk
  // made one long line quadratic.
  #textAppend(data: string): void {
    const newline = data.lastIndexOf('\n')
    if (newline === -1) {
      this.#pending += data
      return
    }
    this.#done += ttyText(this.#pending + data.slice(0, newline + 1))
    this.#pending = data.slice(newline + 1)
  }

  #ringPush(chunk: Buffer): void {
    const size = this.#ring.length
    if (size === 0 || chunk.length === 0) {
      return
    }
    if (chunk.length >= size) {
      chunk.copy(this.#ring, 0, chunk.length - size)
      this.#ringAt = 0
      this.#ringLen = size
      return
    }
    const first = Math.min(chunk.length, size - this.#ringAt)
    chunk.copy(this.#ring, this.#ringAt, 0, first)
    if (first < chunk.length) {
      chunk.copy(this.#ring, 0, first)
    }
    this.#ringAt = (this.#ringAt + chunk.length) % size
    this.#ringLen = Math.min(size, this.#ringLen + chunk.length)
  }

  #spill(): void {
    this.#spilled = true
    const buffered = Buffer.concat(this.#chunks, this.#chunkBytes)
    this.#chunks = []
    this.#chunkBytes = 0
    this.#queue(async () => {
      await mkdir(this.#paths.dir, { recursive: true, mode: 0o700 })
      this.#handle = await open(this.#paths.raw, 'w', 0o600)
      await this.#handle.write(buffered)
    })
  }

  #write(chunk: Buffer): void {
    if (chunk.length === 0) {
      return
    }
    this.#queue(async () => {
      await this.#handle?.write(chunk)
    })
  }

  #queue(task: () => Promise<void>): void {
    this.#io = this.#io.then(async () => {
      if (this.#broken) {
        return
      }
      try {
        await task()
      } catch (error) {
        this.#broken = true
        this.#onError(error)
      }
    })
  }
}

export class StoredArtifact {
  readonly #paths: ArtifactPaths
  readonly #bytes: number
  readonly #capped: boolean
  readonly #stored: StoredOutput

  constructor(paths: ArtifactPaths, info: { bytes: number; capped?: boolean }, stored: StoredOutput) {
    this.#paths = paths
    this.#bytes = info.bytes
    this.#capped = info.capped === true
    this.#stored = stored.artifact !== undefined ? { artifact: stored.artifact } : { output: stored.output ?? '' }
  }

  async read(tail?: number): Promise<Buffer> {
    if (tail !== undefined) {
      return this.replay(tail)
    }
    return this.#head()
  }

  async replay(max: number): Promise<Buffer> {
    const want = Math.max(0, Math.floor(max))
    if (this.#capped) {
      const ring = await readWhole(this.#paths.tail)
      return ring.subarray(Math.max(0, ring.length - want))
    }
    if (this.#stored.output !== undefined) {
      const all = Buffer.from(this.#stored.output, 'utf8')
      return all.subarray(Math.max(0, all.length - want))
    }
    const size = await stat(this.#paths.raw).then(
      (s) => s.size,
      () => 0,
    )
    return readRange(this.#paths.raw, Math.max(0, size - want), size)
  }

  async textView(): Promise<string> {
    const head = await this.#head()
    let text = ttyText(head.toString('utf8'))
    if (this.#capped) {
      const ring = await readWhole(this.#paths.tail)
      const after = this.#bytes - head.length
      const kept = Math.min(after, ring.length)
      if (kept > 0) {
        text += (after > kept ? '\n' : '') + ttyText(ring.subarray(ring.length - kept).toString('utf8'))
      }
    }
    return text
  }

  stored(): StoredOutput {
    return this.#stored
  }

  idle(): Promise<void> {
    return Promise.resolve()
  }

  async remove(): Promise<void> {
    await rm(this.#paths.raw, { force: true })
    await rm(this.#paths.tail, { force: true })
  }

  #head(): Promise<Buffer> {
    return this.#stored.output !== undefined ? Promise.resolve(Buffer.from(this.#stored.output, 'utf8')) : readWhole(this.#paths.raw)
  }
}

async function readWhole(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) {
      return Buffer.alloc(0)
    }
    throw error
  }
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start)
  if (length === 0) {
    return Buffer.alloc(0)
  }
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isMissing(error)) {
      return Buffer.alloc(0)
    }
    throw error
  }
  try {
    const out = Buffer.allocUnsafe(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await handle.read(out, got, length - got, start + got)
      if (bytesRead === 0) {
        break
      }
      got += bytesRead
    }
    return got === length ? out : out.subarray(0, got)
  } finally {
    await handle.close()
  }
}
