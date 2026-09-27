import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, writeJsonAtomic } from '../lib/atomic-file.ts'
import { artifactPaths, StoredArtifact } from './shell-artifact.ts'
import type { SessionShells, ShellEntry, ShellErrorReporter, StoredShellIndex, StoredShellRecord } from './shell-types.ts'

const INDEX_SUFFIX = '.json'
const INDEX_VERSION = 1

export type ShellIndexDeps = { dir: string | null; generation: string; report: ShellErrorReporter }

export function freshSession(sessionId: string): SessionShells {
  return { sessionId, nextOrdinal: 1, entries: new Map(), chain: Promise.resolve(), pending: false }
}

export function runningIn(state: SessionShells): ShellEntry[] {
  return [...state.entries.values()].filter((entry) => entry.info.status === 'running')
}

export function persistIndex(dir: string | null, state: SessionShells, report: ShellErrorReporter): void {
  if (!dir || state.pending) {
    return
  }
  state.pending = true
  state.chain = state.chain
    .then(async () => {
      state.pending = false
      await writeJsonAtomic(indexPath(dir, state.sessionId), serializeIndex(state))
    })
    .catch((error: unknown) => report(error, { op: 'index', sessionId: state.sessionId }))
}

export async function readIndex(deps: ShellIndexDeps, sessionId: string): Promise<SessionShells> {
  const { dir, report } = deps
  const state = freshSession(sessionId)
  if (!dir) {
    return state
  }
  const index = await loadIndexFile(dir, sessionId, report)
  if (!index) {
    return state
  }
  state.nextOrdinal = index.nextOrdinal
  if (restoreEntries(state, index, dir, deps.generation)) {
    persistIndex(dir, state, report)
  }
  return state
}

export async function indexedSessions(dir: string, report: ShellErrorReporter): Promise<string[]> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (!isMissing(error)) {
      report(error, { op: 'index' })
    }
  }
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith(INDEX_SUFFIX)) {
      continue
    }
    try {
      ids.push(decodeURIComponent(name.slice(0, -INDEX_SUFFIX.length)))
    } catch {
      continue
    }
  }
  return ids
}

export function serializeIndex(state: SessionShells): StoredShellIndex {
  return {
    version: INDEX_VERSION,
    sessionId: state.sessionId,
    nextOrdinal: state.nextOrdinal,
    shells: [...state.entries.values()].map((entry) => ({ ...entry.info, generation: entry.generation, ...entry.artifact.stored() })),
  }
}

export function parseIndex(value: unknown): StoredShellIndex {
  const index = value as Partial<StoredShellIndex> | null
  if (!index || index.version !== INDEX_VERSION || typeof index.sessionId !== 'string' || !Array.isArray(index.shells)) {
    throw new Error('unrecognised shell index')
  }
  const shells = index.shells.filter(
    (record): record is StoredShellRecord =>
      typeof record === 'object' && record !== null && typeof (record as StoredShellRecord).id === 'string',
  )
  const nextOrdinal = typeof index.nextOrdinal === 'number' && index.nextOrdinal > 0 ? index.nextOrdinal : 1
  return { version: INDEX_VERSION, sessionId: index.sessionId, nextOrdinal, shells }
}

function indexPath(dir: string, sessionId: string): string {
  return join(dir, `${encodeURIComponent(sessionId)}${INDEX_SUFFIX}`)
}

async function loadIndexFile(dir: string, sessionId: string, report: ShellErrorReporter): Promise<StoredShellIndex | undefined> {
  let raw: string
  try {
    raw = await readFile(indexPath(dir, sessionId), 'utf8')
  } catch (error) {
    if (!isMissing(error)) {
      report(error, { op: 'index', sessionId })
    }
    return undefined
  }
  try {
    return parseIndex(JSON.parse(raw))
  } catch (error) {
    report(error, { op: 'index', sessionId })
    return undefined
  }
}

function restoreEntries(state: SessionShells, index: StoredShellIndex, base: string, generation: string): boolean {
  const now = Date.now()
  let dirty = false
  for (const record of index.shells) {
    const { generation: recordGeneration, output, artifact, ...info } = record
    if (info.status === 'running' && recordGeneration !== generation) {
      info.status = 'exited'
      info.endReason = 'server_restarted'
      info.endedAt = now
      delete info.exitCode
      delete info.signal
      dirty = true
    }
    state.entries.set(info.id, {
      info,
      generation: recordGeneration,
      artifact: new StoredArtifact(artifactPaths(base, state.sessionId, info.id), info, { output, artifact }),
      sinks: new Set(),
      listeners: new Set(),
    })
  }
  return dirty
}
