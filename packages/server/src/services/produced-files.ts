import type { Runner } from '@workerdeck/core'

export type ProducedFile = {
  fileId: string
  path: string
  mediaType?: string
  bytes?: number
  sessionId: string
}

export class ProducedFileStore {
  #bySession = new Map<string, Map<string, ProducedFile>>()

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

  list(sessionId: string): ProducedFile[] {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])]
  }

  drop(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }
}
