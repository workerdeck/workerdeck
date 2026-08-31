import type { Runner } from '@workerdeck/core'

/** One host file an engine reported writing, as the store holds it. */
export type ProducedFile = {
  fileId: string
  /** Absolute host path, exactly as the runner reported it. */
  path: string
  mediaType?: string
  /** Size when the runner announced it — advisory, and re-read at serve time. */
  bytes?: number
  sessionId: string
}

/**
 * The paths `GET /sessions/:id/produced/:fileId` will serve, and the whole access-control model
 * for that route: an allowlist built from `file_produced` events and nothing else, so no request,
 * config or agent path claim can add to it. Paths only, for the session's lifetime.
 * See `docs/GOTCHAS.md` §Produced files.
 */
export class ProducedFileStore {
  #bySession = new Map<string, Map<string, ProducedFile>>()

  /**
   * Register a runner's produced files for its lifetime.
   *
   * Subscribes from seq 0, which is the opposite of what `SessionNotifier` wants
   * and correct for the same reason: registration is idempotent (a `fileId` is
   * derived from its path, so re-registering overwrites with itself), and a
   * session rebuilt from a park must re-learn every file it produced before the
   * park — otherwise a client's transcript keeps rendering image cards whose
   * bytes have quietly become unreachable.
   */
  watch(runner: Runner): void {
    runner.subscribe((event) => {
      if (event.type !== 'file_produced') {
        return
      }
      const held = this.#bySession.get(runner.id) ?? new Map<string, ProducedFile>()
      held.set(event.fileId, {
        fileId: event.fileId,
        path: event.path,
        ...(event.mediaType ? { mediaType: event.mediaType } : {}),
        ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
        sessionId: runner.id,
      })
      this.#bySession.set(runner.id, held)
    }, 0)
  }

  get(sessionId: string, fileId: string): ProducedFile | undefined {
    return this.#bySession.get(sessionId)?.get(fileId)
  }

  /** Everything one session has produced, newest registration last. */
  list(sessionId: string): ProducedFile[] {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])]
  }

  drop(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }
}
