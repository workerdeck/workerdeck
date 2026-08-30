#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadConfigFile, parseArgs, resolveInstanceConfig } from './config.ts'
import { startInstance } from './lib/instance.ts'

const HELP = `workerdeck — run a workerdeck instance: session gateway + dashboard, one port.

Usage
  workerdeck [options]
  workerdeck guard [options]     check whether it is safe to restart an instance

Options
  -p, --port <n>            port to listen on (default 8787, WORKERDECK_PORT)
      --host <addr>         interface to bind (default 127.0.0.1, WORKERDECK_HOST)
      --auth-key <secret>   shared secret, min 12 chars; browsers log in with it,
                            services send it as x-workerdeck-key
                            (WORKERDECK_AUTH_KEY). Unset = no auth on loopback;
                            on any other interface a key is generated instead,
                            printed once, and stored in <state-dir>/auth-key for
                            later starts to reuse.
      --trust-proxy         trust x-forwarded-proto/-host/-for from one reverse
                            proxy. Required behind TLS termination, or the session
                            cookie loses its Secure flag and the origin check
                            computes http:// where the browser says https://.
      --allowed-origin <o>  extra origin accepted on browser requests, for when a
                            proxy rewrites Host (repeatable)
      --allowed-host <name> extra Host header accepted when running without auth
                            (repeatable; loopback names are always accepted)
      --insecure-host <name>
                            bind host that may serve without auth — no key demanded,
                            none generated — and, while unauthenticated, also
                            accepted as a Host header (repeatable; config:
                            insecureHosts). Names the host alone, no port.
      --profile <name=dir>  Claude config dir a session may run under (repeatable)
      --cwd-root <path>     restrict session cwds to this root (repeatable,
                            WORKERDECK_CWD_ROOTS as a ':'-separated list)
      --fs-root <path>      narrow which host directories /v1/fs serves
                            (repeatable, WORKERDECK_FS_ROOTS as a ':'-separated
                            list). Reading otherwise follows --cwd-root: a caller
                            who may start a session in a tree can already read it
                            through the agent. With neither, the routes 404.
      --fs-write            also accept writes over /v1/fs. Its own switch because
                            an agent's writes go through the permission flow and a
                            PUT does not. Every write is still conditional on the
                            hash the client last read.
      --state-dir <path>    where parked sessions are persisted
                            (default: beside the config file, else ~/.workerdeck)
      --no-parking-store    keep parked sessions in memory only; a restart drops them
  -c, --config <path>       config file (default: ./workerdeck.config.mjs)
      --insecure            allow no-auth on a non-loopback address. Only when
                            something in front is doing the authenticating.
      --cors-origin <o>     browser origin allowed to call /v1 cross-origin, for a
                            dashboard served elsewhere (repeatable, exact origin, no
                            wildcard; config: corsOrigins). Refused without auth. The
                            key is still required — this only permits the call.
      --no-web              don't serve the web dashboard (config: web: false).
                            /v1 and the auth routes are unchanged; everything else
                            404s. For a gateway reached only from the VS Code
                            extension, the phone, or another host's dashboard.
      --open                open the dashboard in a browser once it is up
  -h, --help                show this
  -v, --version             print the version

Config file
  Options that cannot fit on a command line — \`authenticate\`, \`buildRunnerConfig\`,
  \`createEngineRunner\` are functions — live in workerdeck.config.mjs, which
  default-exports the createWorkerServer options (or a function returning them).
  Flags and env override it. Supplying your own \`authenticate\` turns the built-in
  shared-secret auth off entirely.

Credentials
  workerdeck implements no Anthropic auth of its own: the official SDK/CLI
  resolves credentials from the environment, per profile. --auth-key protects this
  gateway, nothing else.
`

async function readVersion(): Promise<string> {
  // src/cli.ts and build/cli.mjs are both one level under the package root.
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  try {
    const raw = await readFile(pkgPath, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Best-effort: a browser that won't open is a convenience missed, not a failure. */
function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignored
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'guard') {
    const { runGuard } = await import('./lib/guard.ts')
    return await runGuard(argv.slice(1))
  }

  const flags = parseArgs(argv)
  if (flags.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (flags.version) {
    process.stdout.write(`${await readVersion()}\n`)
    return 0
  }

  const loaded = await loadConfigFile(flags.config)
  const config = resolveInstanceConfig(flags, loaded)
  const instance = await startInstance(config)

  if (config.open) {
    openInBrowser(instance.url)
  }

  const shutdown = (signal: string): void => {
    process.stdout.write(`\n[workerdeck] ${signal} — shutting down\n`)
    // Parked sessions are already on disk; this is about letting in-flight
    // requests finish rather than dropping sockets on the floor.
    instance
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Resolves only on close; the process stays up serving.
  await instance.closed
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) {
      process.exit(code)
    }
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`[workerdeck] ${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`[workerdeck] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
