import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'

export type HeldSend = { text: string; attachmentIds: string[] }

export type HeldSends = {
  held: HeldSend[]
  submit: (text: string, attachmentIds: string[]) => void
  flush: () => void
}

// Catch-up mode is the engine's behaviour, not ours: a message sent mid-turn is folded into the
// running turn. Holding it here is the only way to turn that off, and it is a client preference,
// so nothing about it travels on the wire.
export function useHeldSends(options: { hold: boolean; busy: boolean; send: (text: string, attachmentIds: string[]) => void }): HeldSends {
  const [held, setHeld] = useState<HeldSend[]>([])
  // The queue is a ref and the state is its shadow: flushing sends, and a state updater that
  // sends would fire twice under StrictMode.
  const queue = useRef<HeldSend[]>([])
  const sendRef = useRef(options.send)
  sendRef.current = options.send

  const flush = useCallback(() => {
    const queued = queue.current
    if (queued.length === 0) {
      return
    }
    queue.current = []
    setHeld([])
    for (const item of queued) {
      sendRef.current(item.text, item.attachmentIds)
    }
  }, [])

  useEffect(() => {
    if (!options.busy) {
      flush()
    }
  }, [options.busy, flush])

  const submit = useCallback(
    (text: string, attachmentIds: string[]) => {
      if (!options.hold || !options.busy) {
        sendRef.current(text, attachmentIds)
        return
      }
      queue.current = [...queue.current, { text, attachmentIds }]
      setHeld(queue.current)
    },
    [options.hold, options.busy],
  )

  return { held, submit, flush }
}

export function HeldSendsBar({ held, onSendNow }: { held: HeldSend[]; onSendNow: () => void }) {
  if (held.length === 0) {
    return null
  }
  return (
    <div className="px-3 pt-2">
      <div className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-label text-fg-3">
        <Clock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {held.length === 1 ? '1 message' : `${held.length} messages`} waiting for this turn to end — {held[held.length - 1]!.text}
        </span>
        <button type="button" onClick={onSendNow} className="shrink-0 underline-offset-2 hover:underline">
          Send now
        </button>
      </div>
    </div>
  )
}
