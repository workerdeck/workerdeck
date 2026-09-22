import type { Instance } from './instance.ts'

export type ShutdownOptions = {
  // A getter, not an instance: under --hot-reload the instance is replaced on every reload, and a captured one
  // would drain a server that stopped listening several generations ago.
  current: () => Instance
  // Runners this process holds outside any instance, which under --hot-reload is what a failed generation leaves
  // behind: no registry holds them, so `close()` cannot reach them and nothing else ends their engine children.
  alsoClose?: () => { close: (reason?: 'client' | 'server' | 'error') => void }[]
  log?: (text: string) => void
}

export function installShutdown({
  current,
  alsoClose,
  log = (text) => void process.stdout.write(`${text}\n`),
}: ShutdownOptions): (signal: string) => void {
  // A second signal must always be able to kill a shutdown that is taking too long. That used to work only by
  // accident - the second call re-entered `instance.close()` and got an immediate callback out of an already-closed
  // http server - so it evaporated the moment close stopped being idempotent-by-luck. Make it a real path.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stdout.write(`\n[workerdeck] ${signal} again - terminating now\n`)
      // Shell children are detached group leaders, so a plain exit orphans every one of them.
      current().server.shells?.killAllSync()
      process.exit(130)
    }
    shuttingDown = true
    log(`\n[workerdeck] ${signal} - shutting down (press again to stop now)`)
    const instance = current()
    const running = instance.server.shells?.running() ?? []
    if (running.length > 0) {
      const named = running.map((shell) => `#${shell.ordinal} ${shell.label} (session ${shell.sessionId.slice(0, 8)})`).join(', ')
      log(`[workerdeck] ${running.length} shell(s) still running and will be stopped: ${named}`)
    }
    instance
      .drain({
        onProgress: (report) => {
          if (report.working.length > 0) {
            log(`[workerdeck] waiting for ${report.working.length} session(s) to finish the current turn`)
          }
          // Named, not waited for: nothing about shutting down answers a permission prompt.
          for (const id of report.awaitingHuman) {
            log(`[workerdeck] session ${id} is waiting on an approval - not waiting for it`)
          }
          if (report.timedOut) {
            log(`[workerdeck] ${report.working.length} session(s) still running - stopping anyway`)
          } else if (report.working.length === 0) {
            log('[workerdeck] all turns finished')
          }
        },
      })
      .catch(() => undefined)
      .then(() => instance.close())
      .then(() => {
        for (const runner of alsoClose?.() ?? []) {
          runner.close('server')
        }
      })
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Returned for the one caller that cannot rely on the signal: a raw-mode TTY delivers ctrl-c as a byte, not SIGINT.
  return shutdown
}
