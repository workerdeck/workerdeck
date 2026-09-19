import type { Runner } from '@workerdeck/core'
import { isJobRun } from '@workerdeck/protocol'

// What a hot reload may do with a live session. `carry` hands the runner object itself to the next generation,
// which is the only way an engine child process, its subagents and its shell grandchildren survive; `persist` is
// the ordinary restart story through the store; `drop` lets the session end with the generation.
export type ReloadPlan = 'carry' | 'persist' | 'drop'

export function reloadPlan(runner: Runner): ReloadPlan {
  const info = runner.info()
  if (info.status === 'closed' || info.status === 'failed') {
    return 'drop'
  }
  // The queue owns a job's session: a carried one would be a row nothing will ever finalize.
  if (isJobRun(info)) {
    return 'drop'
  }
  // Keyed on the capability, never on the engine name: "can this session persist itself" is the actual question,
  // and a runner that can snapshot has in-process executors closed over this generation's bridge hub, which after
  // the swap has no sockets. Carrying one does not orphan a call in flight, it breaks every later bridged call.
  if (runner.snapshot !== undefined) {
    return 'persist'
  }
  return 'carry'
}
