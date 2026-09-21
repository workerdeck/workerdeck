import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfigFile, resolveInstanceConfig, parseArgs as parseCliArgs } from '../config.ts'

const HELP = `usage: workerdeck reload [--state-dir PATH] [--config PATH]

Tells a gateway started with --hot-reload to re-evaluate its own source in place.
Live sessions, their engine child processes and any turn in flight are carried
across the swap. Resolves the running gateway through <state-dir>/gateway.pid,
so it only ever reaches an instance on this machine.

exit 0 = signalled, 1 = no instance found, 2 = bad arguments
`

export async function runReload(argv: string[]): Promise<number> {
  let values: { 'state-dir'?: string; config?: string; help: boolean }
  try {
    values = parseArgs({
      args: argv,
      options: {
        'state-dir': { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }).values as typeof values
  } catch (error) {
    process.stderr.write(`reload: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }

  let stateDir: string | null
  if (values['state-dir']) {
    stateDir = resolvePath(values['state-dir'])
  } else {
    // Resolved the way the gateway itself resolves it, config file included, so `reload` and the instance it is
    // aimed at cannot disagree about where the pidfile is.
    try {
      const loaded = await loadConfigFile(values.config)
      stateDir = resolveInstanceConfig(parseCliArgs(values.config ? ['--config', values.config] : []), loaded).stateDir
    } catch (error) {
      process.stderr.write(`reload: ${error instanceof ConfigError ? error.message : String(error)}\n`)
      return 2
    }
  }
  if (!stateDir) {
    process.stderr.write(
      'reload: this configuration has no state dir, so there is no pidfile to read.\n  Send SIGUSR2 to the gateway process instead.\n',
    )
    return 1
  }

  const pidPath = join(stateDir, 'gateway.pid')
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  } catch {
    process.stderr.write(`reload: no gateway.pid in ${stateDir}\n  Only a gateway started with --hot-reload writes one.\n`)
    return 1
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stderr.write(`reload: ${pidPath} does not name a process\n`)
    return 1
  }
  try {
    // The pid, never the process group: this reload happens inside the gateway process, and signalling the group
    // would reach the npx launcher and every engine child with it.
    process.kill(pid, 'SIGUSR2')
  } catch {
    process.stderr.write(`reload: no process ${pid} (stale pidfile in ${stateDir})\n`)
    return 1
  }
  process.stdout.write(`reloading gateway ${pid}\n`)
  return 0
}
