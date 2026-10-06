import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { enrollGateway, enrollGatewayHash, readEnrollments, revokeGateway, setGatewayOwner, writeKeyFile } from './enrollment.ts'
import { DEFAULT_RELAY_OWNER, startRelay, type RelayStatus } from './relay.ts'
import { fetchRelayStatus, statusSocketPath } from './status.ts'
import { readRules, rulesPath } from './rules.ts'

export const RELAY_HELP = `workerdeck-relay - the cross-gateway peer relay. Also runs as \`workerdeck relay\`.

Usage
  workerdeck-relay serve [options]          run the relay
  workerdeck-relay enroll <name> [--rotate] [--owner <label>] [--hash <sha256>]
                                            enroll a gateway and print its key once, or store the
                                            hash a colleague's \`keygen\` printed (the key stays theirs)
  workerdeck-relay owner <name> <label>     set the owner of an enrolled gateway (--clear to unset)
  workerdeck-relay revoke <name>            revoke a gateway; a running relay drops it within seconds
  workerdeck-relay list                     list enrolled gateways
  workerdeck-relay status                   ask the relay serving this state dir who is online
  workerdeck-relay keygen [--out <file>] [--force]
                                            on a gateway's machine: write a new key (default
                                            ~/.workerdeck/relay.key, mode 0600) and print only its hash

Options
  --state-dir <path>   enrollments, rules and the status socket (relay.sock); default ~/.workerdeck/relay
  --host <addr>        listen address (default 127.0.0.1)
  --port <n>           listen port (default 7777)
  --tls-cert <file>    serve wss:// with this certificate (optional, plain ws:// otherwise)
  --tls-key <file>     the certificate's private key
  --owner <label>      serve: the owner of gateways enrolled without one (default ${DEFAULT_RELAY_OWNER})
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
  owner?: string
  hash?: string
  out?: string
  force?: boolean
  clear?: boolean
  help?: boolean
  rest: string[]
}

export class RelayUsageError extends Error {}

export function parseRelayArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RelayFlags {
  const flags: RelayFlags = { stateDir: env.WORKERDECK_RELAY_STATE_DIR ?? join(homedir(), '.workerdeck', 'relay'), rest: [] }
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
      case '--owner': {
        flags.owner = value()
        break
      }
      case '--hash': {
        flags.hash = value()
        break
      }
      case '--out': {
        flags.out = resolve(value())
        break
      }
      case '--force': {
        flags.force = true
        break
      }
      case '--clear': {
        flags.clear = true
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
  flags.rest = positional.slice(2)
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
        owner: flags.owner,
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
      const options = { rotate: flags.rotate, owner: flags.owner }
      const owned = flags.owner ? ` (owner ${flags.owner})` : ''
      if (flags.hash) {
        await enrollGatewayHash(flags.stateDir, flags.name, flags.hash, options)
        console.log(`Enrolled ${flags.name}${owned} with the key hash it generated; its key never left that machine.`)
        return 0
      }
      const key = await enrollGateway(flags.stateDir, flags.name, options)
      console.log(
        `Enrolled ${flags.name}${owned}. Its key, shown once:\n\n  ${key}\n\n` +
          `Save it on that gateway (for example ~/.workerdeck/relay.key, mode 0600) and point relay.keyFile at it.`,
      )
      return 0
    }
    case 'owner': {
      const label = flags.clear ? undefined : flags.rest[0]
      if (!flags.name || (!flags.clear && !label)) {
        throw new RelayUsageError('owner needs a gateway name and a label (or --clear)')
      }
      const changed = await setGatewayOwner(flags.stateDir, flags.name, label)
      console.log(changed ? `${flags.name}: owner ${label ?? 'cleared'}.` : `${flags.name} is not enrolled.`)
      return changed ? 0 : 1
    }
    case 'keygen': {
      const out = flags.out ?? join(homedir(), '.workerdeck', 'relay.key')
      let hash: string
      try {
        hash = await writeKeyFile(out, { force: flags.force })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          console.error(`workerdeck-relay: ${out} exists; pass --force to replace it (the old key stops working once re-enrolled)`)
          return 1
        }
        throw error
      }
      console.log(
        `Wrote a new gateway key to ${out} (mode 0600). Send the relay operator only this hash:\n\n  ${hash}\n\n` +
          `They enroll it with: workerdeck relay enroll <gateway-name> --owner <you> --hash ${hash}`,
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
        console.log(
          `${name}\towner ${entry.owner ?? `${DEFAULT_RELAY_OWNER} (default)`}\tenrolled ${new Date(entry.enrolledAt).toISOString()}`,
        )
      }
      return 0
    }
    case 'status': {
      let status: RelayStatus
      try {
        status = await fetchRelayStatus(flags.stateDir)
      } catch (error) {
        const socket = statusSocketPath(flags.stateDir)
        console.error(`workerdeck-relay: no relay answered on ${socket} (${error instanceof Error ? error.message : String(error)})`)
        return 2
      }
      for (const gateway of status.gateways) {
        console.log(
          gateway.online
            ? `${gateway.name}\t${gateway.owner}\tonline\t${gateway.sessions} session(s)\taccepts ${gateway.ops.join(', ') || 'nothing'}` +
                (gateway.features?.length ? `\tfeatures ${gateway.features.join(', ')}` : '')
            : `${gateway.name}\t${gateway.owner}\toffline`,
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
