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
 * The paths this gateway will serve from `GET /sessions/:id/produced/:fileId`.
 *
 * **This is the whole access-control model, so it is worth being precise about
 * what it is.** The store is an allowlist built from one source and one only:
 * `file_produced` events, which a runner emits about a file its own engine just
 * wrote. It is not a directory grant. Nothing else can add to it — not a
 * request, not a config, and in particular not the agent, whose own path claims
 * go through `/fs/*` and that route's root allowlist.
 *
 * That is why the route needs neither `hostFiles.roots` nor `maxFileBytes`:
 * "somewhere under a root the operator declared" is a guess about which paths
 * are safe, while "the exact path this session's runner reported producing" is
 * a fact about one file. A 2 MB generated PNG is the common case, and making
 * the operator raise a byte cap to see their own picture was the bug this
 * replaces.
 *
 * Lifetime is the session's, like `AttachmentStore`'s: in memory, dropped when
 * the session is removed. The bytes are never held here — only the path, so a
 * gateway serving a long session accumulates a few hundred bytes per picture
 * rather than the pictures.
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
