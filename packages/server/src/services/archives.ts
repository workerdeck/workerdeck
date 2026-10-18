import type { SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'
import type { HistoryReader } from './history-reader.ts'
import type { ArchivedSessionRecord } from './session-store.ts'

export type ArchiveView = { info: SessionInfo; events: SessionEvent[] | undefined }

// The archive is a log of its own (an engine read is renumbered from 1), so it carries an epoch derived from the record
// alone: stable across reads, never the live session's, and a viewer holding a live cursor resets on it.
export async function viewArchive(reader: HistoryReader, record: ArchivedSessionRecord, signal?: AbortSignal): Promise<ArchiveView> {
  const archived = { ...record.info, epoch: archiveEpoch(record) }
  if (record.snapshot) {
    const { events } = record.snapshot
    return { info: { ...archived, lastSeq: events.at(-1)?.seq ?? 0 }, events }
  }
  const read = await reader.read(
    {
      sessionId: record.id,
      engine: engineOf(archived),
      engineSessionId: record.engineSessionId,
      profile: record.profile,
      ...(record.home ? { home: record.home } : {}),
      cwd: archived.cwd,
    },
    signal,
  )
  switch (read.kind) {
    case 'ok': {
      const ts = archived.lastActivityAt ?? record.archivedAt
      return {
        info: { ...archived, lastSeq: read.events.length },
        events: read.events.map((body, index) => ({ ...body, seq: index + 1, ts }) as SessionEvent),
      }
    }
    case 'missing': {
      return { info: { ...archived, lastSeq: 0, transcript: 'unavailable' }, events: [] }
    }
    default: {
      return { info: archived, events: undefined }
    }
  }
}

export function archiveEpoch(record: ArchivedSessionRecord): number {
  let hash = 0x811c9dc5
  for (const char of `archive:${record.id}:${record.archivedAt}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  }
  const epoch = (hash >>> 1) + 1
  return epoch === record.info.epoch ? epoch + 1 : epoch
}
