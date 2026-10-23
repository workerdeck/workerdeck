import { useEffect } from 'react'
import { WorkerDeckError } from '@workerdeck/client'
import { errorMessage, sortQuestionBoards, type QuestionBoardInfo } from '@workerdeck/protocol'
import { client } from '../lib/client.ts'
import { onHostsChange } from '../lib/hosts.ts'
import { createPolledStore } from '../lib/store.ts'

const FALLBACK_INTERVAL_MS = 30_000

type State = {
  boards: QuestionBoardInfo[]
  enabled: boolean
  live: boolean
  error: string | undefined
}

const store = createPolledStore<State>(
  { boards: [], enabled: true, live: false, error: undefined },
  { load: loadBoards, intervalMs: FALLBACK_INTERVAL_MS, onIdle: detachBoards },
)
const emit = store.patch

let detach: (() => void) | undefined

onHostsChange(() => {
  if (store.watched()) {
    void store.refresh()
  }
})

async function loadBoards(): Promise<void> {
  const gateway = client()
  if (!gateway) {
    return
  }
  try {
    emit({ boards: sortQuestionBoards(await gateway.questionBoards()), enabled: true, error: undefined })
    ensureAttached()
  } catch (e) {
    if (e instanceof WorkerDeckError && e.status === 404) {
      emit({ enabled: false, error: undefined })
    } else {
      emit({ error: errorMessage(e) })
    }
  }
}

function detachBoards(): void {
  detach?.()
  detach = undefined
  emit({ live: false })
}

// Attached only after REST answered: a gateway with the board off refuses the upgrade and the handle would loop.
function ensureAttached(): void {
  if (detach || !store.get().enabled || !store.watched()) {
    return
  }
  const gateway = client()
  if (!gateway) {
    return
  }
  const handle = gateway.attachQuestions()
  const offs = [
    handle.on('attached', (boards) => emit({ boards: sortQuestionBoards(boards) })),
    handle.on('changed', (board) =>
      emit({ boards: sortQuestionBoards([board, ...store.get().boards.filter((other) => other.id !== board.id)]) }),
    ),
    handle.on('connectionChange', (live) => emit({ live })),
  ]
  detach = () => {
    for (const off of offs) {
      off()
    }
    handle.detach()
  }
}

export function useQuestions(): State & { refresh: () => Promise<void> } {
  const value = store.use()
  useEffect(ensureAttached, [value.enabled])
  return { ...value, refresh: store.refresh }
}

export function useOpenQuestions(): { open: number; blocking: number } {
  const { boards } = useQuestions()
  return boards.reduce((sum, board) => ({ open: sum.open + board.open, blocking: sum.blocking + board.blocking }), { open: 0, blocking: 0 })
}
