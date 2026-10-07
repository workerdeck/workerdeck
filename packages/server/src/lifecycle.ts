import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import type { JobQueue } from '@workerdeck/queue'
import { sessionState } from '@workerdeck/protocol'
import type { DiagnosticSink, DrainOptions, DrainReport } from './options.ts'
import type { EngineSleepTimers } from './services/engine-sleep.ts'
import type { SessionParkManager } from './services/parking.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { ShellRegistry } from './services/shells.ts'

// How long a client gets to acknowledge the shutdown close frame before its socket is torn down.
const SOCKET_CLOSE_GRACE_MS = 250

// The outer bound on close(): it resolves by then whether or not the runtime ever reports the drains complete.
const CLOSE_DEADLINE_MS = 1_000

export type ServerLifecycleDeps = {
  server: Server
  wss: WebSocketServer
  registry: SessionRegistry
  parking: SessionParkManager
  shells: ShellRegistry | null
  queue: JobQueue | undefined
  engineSleep: EngineSleepTimers
  closeQueueSockets: () => void
  // Resolves once the agent store's in-flight write has landed; the next generation hydrates only after close.
  releaseDirectories: () => Promise<void>
  diagnose: DiagnosticSink
}

export type ServerLifecycle = {
  draining: () => boolean
  drain: (options?: DrainOptions) => Promise<DrainReport>
  close: () => Promise<void>
}

export function createServerLifecycle(deps: ServerLifecycleDeps): ServerLifecycle {
  let closing: Promise<void> | undefined
  let draining = false
  return {
    draining: () => draining,
    drain: async (options = {}) => {
      draining = true
      deps.queue?.pause()
      return drainSessions(deps.registry, deps.shells, options)
    },
    close: () => {
      closing ??= closeServer(deps)
      return closing
    },
  }
}

// Split live sessions into "will finish by itself" and "needs a person".
//
// `sessionState` is the vocabulary the dashboard, the session list and `workerdeck guard` already sort by, and it
// draws exactly the line a drain needs: `working` covers starting/running and running subagents, while `attention`
// covers a pending approval. Re-spelling that set here is how the two definitions would drift apart.
function surveyDrain(registry: SessionRegistry, shells: ShellRegistry | null): DrainReport {
  const working: string[] = []
  const awaitingHuman: string[] = []
  for (const info of registry.list()) {
    const state = sessionState(info)
    if (state === 'working') {
      working.push(info.id)
    } else if (state === 'attention') {
      awaitingHuman.push(info.id)
    }
  }
  const running = (shells?.running() ?? []).map(({ sessionId, id, label }) => ({ sessionId, id, label }))
  return { working, awaitingHuman, timedOut: false, shells: running }
}

function sameDrain(a: DrainReport, b: DrainReport): boolean {
  return a.working.join() === b.working.join() && a.awaitingHuman.join() === b.awaitingHuman.join()
}

async function drainSessions(registry: SessionRegistry, shells: ShellRegistry | null, options: DrainOptions): Promise<DrainReport> {
  const { timeoutMs = 30_000, pollMs = 250, onProgress } = options
  const deadline = Date.now() + timeoutMs
  let report = surveyDrain(registry, shells)
  onProgress?.(report)
  while (report.working.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const next = surveyDrain(registry, shells)
    // Only speak when something actually changed: a shutdown that reports on its own progress should be
    // readable, not a per-tick redraw of the same two lines.
    if (!sameDrain(next, report)) {
      onProgress?.(next)
    }
    report = next
  }
  report = { ...surveyDrain(registry, shells), timedOut: false }
  report.timedOut = report.working.length > 0
  onProgress?.(report)
  return report
}

function closeServer(deps: ServerLifecycleDeps): Promise<void> {
  const { server, wss, registry, parking, shells, queue } = deps
  return new Promise((resolve) => {
    const released = deps.releaseDirectories().catch((error: unknown) => deps.diagnose(error, 'agent-flush'))
    queue?.close()
    // Before the runners close: their `session_closed` would settle every shell as `killed`, and a graceful stop is
    // `server_stopped`. The index lands through `flushed` below, ahead of resolving.
    shells?.killAll('server_stopped')
    const flushed = Promise.all([released, shells?.flush().catch((error: unknown) => deps.diagnose(error, 'shell-flush'))])
    // Ordering is load-bearing: parking's `#closed` guard must be set before the registry closes runners with
    // reason 'server', or shutdown discards every dormant record. See docs/GOTCHAS.md.
    parking.close()
    deps.engineSleep.close()
    registry.closeAll()
    // `wss` is `noServer`, so `wss.close()` only waits for `clients` to empty, and `server.closeAllConnections()`
    // never reaches an upgraded socket: close every client ourselves, then terminate what has not acknowledged.
    for (const ws of wss.clients) {
      ws.close(1001, 'server shutting down')
    }
    deps.closeQueueSockets()
    const force = setTimeout(() => {
      for (const ws of wss.clients) {
        ws.terminate()
      }
    }, SOCKET_CLOSE_GRACE_MS)
    force.unref()
    const finish = (): void => void flushed.then(() => resolve())
    const deadline = setTimeout(finish, CLOSE_DEADLINE_MS)
    deadline.unref()
    const drained = Promise.all([
      new Promise<void>((done) => wss.close(() => done())),
      new Promise<void>((done) => server.close(() => done())),
    ])
    server.closeAllConnections()
    void drained.then(() => {
      clearTimeout(force)
      clearTimeout(deadline)
      finish()
    })
  })
}
