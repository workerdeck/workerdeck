import type { SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'
import type { HistoryReader } from './history-reader.ts'
import type { ArchivedSessionRecord } from './session-store.ts'

export type ArchiveView = { info: SessionInfo; events: SessionEvent[] | undefined }

// Cursors are positions in the engine's transcript, so a reconnect with `afterSeq` never repeats a row.
export async function viewArchive(reader: HistoryReader, record: ArchivedSessionRecord, signal?: AbortSignal): Promise<ArchiveView> {
  const { info } = record
  if (record.snapshot) {
    return { info, events: record.snapshot.events }
  }
  const read = await reader.read(
    { sessionId: record.id, engine: engineOf(info), engineSessionId: record.engineSessionId, profile: record.profile, cwd: info.cwd },
    signal,
  )
  switch (read.kind) {
    case 'ok': {
      const ts = info.lastActivityAt ?? record.archivedAt
      return { info, events: read.events.map((body, index) => ({ ...body, seq: index + 1, ts }) as SessionEvent) }
    }
    case 'missing': {
      return { info: { ...info, transcript: 'unavailable' }, events: [] }
    }
    default: {
      return { info, events: undefined }
    }
  }
}
