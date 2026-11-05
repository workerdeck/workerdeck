import type { HostSearchEvent, HostSearchRequest } from '@workerdeck/protocol'
import type { Bridge } from '../bridge.ts'

let nextRun = 1

export async function* runOverBridge(bridge: Bridge, request: HostSearchRequest, signal: AbortSignal): AsyncGenerator<HostSearchEvent> {
  const id = nextRun++
  const queue: HostSearchEvent[] = []
  let ended = false
  let failure: string | undefined
  let wake: (() => void) | undefined
  const off = bridge.onHostMessage((msg) => {
    if (msg.kind !== 'wd-search-events' || msg.id !== id) {
      return
    }
    queue.push(...msg.events)
    if (msg.end) {
      ended = true
      failure = msg.failure
    }
    wake?.()
  })
  const abort = () => {
    bridge.post({ kind: 'wd-search-cancel', id })
    ended = true
    wake?.()
  }
  signal.addEventListener('abort', abort, { once: true })
  bridge.post({ kind: 'wd-search-run', id, request })
  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (ended) {
        break
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = undefined
    }
    if (failure && !signal.aborted) {
      throw new Error(failure)
    }
  } finally {
    off()
    signal.removeEventListener('abort', abort)
  }
}
