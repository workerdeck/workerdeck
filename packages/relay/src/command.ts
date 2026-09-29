import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { enrollGateway, readEnrollments, revokeGateway } from './enrollment.ts'
import { startRelay, type RelayStatus } from './relay.ts'
import { readRules, rulesPath } from './rules.ts'

export const RELAY_HELP = `workerdeck-relay - the cross-gateway peer relay. Also runs as \`workerdeck relay\`.

Usage
  workerdeck-relay serve [options]          run the relay
  workerdeck-relay enroll <name> [--rotate] enroll a gateway and print its key once
  workerdeck-relay revoke <name>            revoke a gateway; a running relay drops it within seconds
  workerdeck-relay list                     list enrolled gateways
  workerdeck-relay status [options]         ask a running relay on this machine who is online

Options
  --state-dir <path>   enrollments (gateways.json) and rules (rules.json); default ~/.workerdeck/relay
  --host <addr>        listen address (default 127.0.0.1)
  --port <n>           listen port (default 7777)
  --tls-cert <file>    serve wss:// with this certificate (optional, plain ws:// otherwise)
  --tls-key <file>     the certificate's private key
  -h, --help           this text
`

export type RelayFlags = {
  command?: string
  name?: string
  stateDir: string
  host?: string
  port?: number
  tlsCert?: string
  tlsKey?: string
  rotate?: boolean
  help?: boolean
}

export class RelayUsageError extends Error {}

export function parseRelayArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RelayFlags {
  const flags: RelayFlags = { stateDir: env.WORKERDECK_RELAY_STATE_DIR ?? join(homedir(), '.workerdeck', 'relay') }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) {
        throw new RelayUsageError(`${arg} needs a value`)
      }
      return next
    }
    switch (arg) {
      case '--state-dir': {
        flags.stateDir = resolve(value())
        break
      }
      case '--host': {
        flags.host = value()
        break
      }
      case '--port': {
        const port = Number(value())
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new RelayUsageError('--port must be a port number')
        }
        flags.port = port
        break
      }
      case '--tls-cert': {
        flags.tlsCert = resolve(value())
        break
      }
      case '--tls-key': {
        flags.tlsKey = resolve(value())
        break
      }
      case '--rotate': {
        flags.rotate = true
        break
      }
      case '-h':
      case '--help': {
        flags.help = true
        break
      }
      default: {
        if (arg.startsWith('-')) {
          throw new RelayUsageError(`unknown option: ${arg}`)
        }
        positional.push(arg)
      }
    }
  }
  flags.command = positional[0]
  flags.name = positional[1]
  if (Boolean(flags.tlsCert) !== Boolean(flags.tlsKey)) {
    throw new RelayUsageError('--tls-cert and --tls-key go together')
  }
  return flags
}

export async function runRelayCli(argv: readonly string[]): Promise<number> {
  let flags: RelayFlags
  try {
    flags = parseRelayArgs(argv)
  } catch (error) {
    if (error instanceof RelayUsageError) {
      console.error(`workerdeck-relay: ${error.message}\n\n${RELAY_HELP}`)
      return 2
    }
    throw error
  }
  if (flags.help || !flags.command) {
    console.log(RELAY_HELP)
    return flags.help ? 0 : 2
  }
  switch (flags.command) {
    case 'serve': {
      await readRules(flags.stateDir)
      const relay = await startRelay({
        stateDir: flags.stateDir,
        host: flags.host,
        port: flags.port,
        tls: flags.tlsCert && flags.tlsKey ? { cert: await readFile(flags.tlsCert), key: await readFile(flags.tlsKey) } : undefined,
      })
      const enrolled = Object.keys((await readEnrollments(flags.stateDir)).gateways).length
      console.log(`workerdeck-relay listening on ${relay.url} (${enrolled} gateway(s) enrolled, rules at ${rulesPath(flags.stateDir)})`)
      await new Promise<void>((done) => {
        const stop = () => void relay.close().then(done)
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      return 0
    }
    case 'enroll': {
      if (!flags.name) {
        throw new RelayUsageError('enroll needs a gateway name')
      }
      const key = await enrollGateway(flags.stateDir, flags.name, { rotate: flags.rotate })
      console.log(
        `Enrolled ${flags.name}. Its key, shown once:\n\n  ${key}\n\n` +
          `Save it on that gateway (for example ~/.workerdeck/relay.key, mode 0600) and point relay.keyFile at it.`,
      )
      return 0
    }
    case 'revoke': {
      if (!flags.name) {
        throw new RelayUsageError('revoke needs a gateway name')
      }
      const removed = await revokeGateway(flags.stateDir, flags.name)
      console.log(removed ? `Revoked ${flags.name}.` : `${flags.name} was not enrolled.`)
      return removed ? 0 : 1
    }
    case 'list': {
      const file = await readEnrollments(flags.stateDir)
      const names = Object.entries(file.gateways).sort(([a], [b]) => (a < b ? -1 : 1))
      if (names.length === 0) {
        console.log('No gateways enrolled.')
      }
      for (const [name, entry] of names) {
        console.log(`${name}\tenrolled ${new Date(entry.enrolledAt).toISOString()}`)
      }
      return 0
    }
    case 'status': {
      const scheme = flags.tlsCert ? 'https' : 'http'
      const url = `${scheme}://127.0.0.1:${flags.port ?? 7777}/status`
      let status: RelayStatus
      try {
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        status = (await res.json()) as RelayStatus
      } catch (error) {
        console.error(`workerdeck-relay: no relay answered at ${url} (${error instanceof Error ? error.message : String(error)})`)
        return 2
      }
      for (const gateway of status.gateways) {
        console.log(
          gateway.online
            ? `${gateway.name}\tonline\t${gateway.sessions} session(s)\taccepts ${gateway.ops.join(', ') || 'nothing'}`
            : `${gateway.name}\toffline`,
        )
      }
      return 0
    }
    default: {
      console.error(`workerdeck-relay: unknown command ${flags.command}\n\n${RELAY_HELP}`)
      return 2
    }
  }
}
