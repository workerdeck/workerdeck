import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { formatPairingLink } from '@workerdeck/protocol'
import { defaultStateDir, parsePublicUrl } from '../config.ts'
import {
  addServeRoute,
  chooseServePort,
  execTailscale,
  findGatewayRoute,
  inspectTailscale,
  publicUrl,
  removeServeRoute,
  serveStatus,
  TailscaleError,
  type Exec,
} from './tailscale.ts'

const REMOTE_HELP = `usage: workerdeck remote <enable|disable|status> [--port N] [--state-dir PATH]

  enable    publish a gateway started with --remote to your tailnet with tailscale serve,
            after checking on the live process that it refuses a request without the key
  disable   remove that tailscale serve route (the gateway keeps running)
  status    show tailscale, the route and the gateway's mode

exit 0 = done, 1 = refused or failed
`

const PAIR_HELP = `usage: workerdeck pair-link [--port N] [--state-dir PATH] [--public-url URL] [--no-qr]

Prints the pairing link for a gateway, and a QR code a phone camera can scan. The address is
--public-url, else the publicUrl the running gateway reports, else its tailscale serve route.
The link holds the gateway's key: anyone who has it can run agents on this machine.
`

export type RemoteDeps = {
  exec?: Exec
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  out?: (text: string) => void
  err?: (text: string) => void
  // How long the first https request may take while tailscale provisions the certificate.
  publishTimeoutMs?: number
}

type Target = { port: number; stateDir: string }

class RemoteError extends Error {}

// Expected failures print one line; anything else is a bug and keeps its stack.
function isReportable(error: unknown): error is Error {
  if (error instanceof RemoteError || error instanceof TailscaleError) {
    return true
  }
  const code = (error as { code?: unknown } | null)?.code
  return (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) || (error instanceof TypeError && error.message === 'fetch failed')
}

function targetOf(values: { port?: string; 'state-dir'?: string }, env: NodeJS.ProcessEnv): Target {
  const raw = values.port ?? env.WORKERDECK_PORT ?? '8787'
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RemoteError(`not a valid port: ${raw}`)
  }
  return { port, stateDir: values['state-dir'] ?? env.WORKERDECK_STATE_DIR ?? defaultStateDir(null) }
}

async function readKey(target: Target, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.WORKERDECK_AUTH_KEY) {
    return env.WORKERDECK_AUTH_KEY
  }
  const path = join(target.stateDir, 'auth-key')
  try {
    const key = (await readFile(path, 'utf8')).split('\n', 1)[0]!.trim()
    if (key.length >= 12) {
      return key
    }
  } catch {}
  throw new RemoteError(`no gateway key at ${path} (or in WORKERDECK_AUTH_KEY); start the gateway with --remote first`)
}

type GatewayMode = { reachable: false } | { reachable: true; auth: boolean; remote: boolean; publicUrl?: string }

async function gatewayMode(base: string, http: typeof fetch): Promise<GatewayMode> {
  try {
    const res = await http(`${base}/auth/status`, { signal: AbortSignal.timeout(5_000) })
    const body = (await res.json()) as { enabled?: unknown; remote?: unknown; publicUrl?: unknown }
    return {
      reachable: true,
      auth: body.enabled === true,
      remote: body.remote === true,
      ...(typeof body.publicUrl === 'string' ? { publicUrl: body.publicUrl } : {}),
    }
  } catch {
    return { reachable: false }
  }
}

// On the live process, never the config: what matters is what the port answers right now.
async function verifyKeyEnforced(base: string, key: string, http: typeof fetch): Promise<void> {
  const open = await http(`${base}/v1/meta`, { signal: AbortSignal.timeout(5_000) })
  if (open.status !== 401) {
    throw new RemoteError(`the gateway answered ${open.status} to a request without the key; refusing to publish it`)
  }
  const keyed = await http(`${base}/v1/meta`, { headers: { 'x-workerdeck-key': key }, signal: AbortSignal.timeout(5_000) })
  if (keyed.status !== 200) {
    throw new RemoteError(`the gateway refused its own key (${keyed.status}); is ${base} the gateway this state dir belongs to?`)
  }
}

async function waitPublished(url: string, http: typeof fetch, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mode = await gatewayMode(url, http)
    if (mode.reachable && mode.remote) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return false
}

export async function runRemote(argv: string[], deps: RemoteDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`))
  const err = deps.err ?? ((text: string) => process.stderr.write(`[workerdeck] ${text}\n`))
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    out(REMOTE_HELP)
    return command === undefined ? 1 : 0
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: 'string', short: 'p' }, 'state-dir': { type: 'string' } },
      strict: true,
    })
    const env = deps.env ?? process.env
    const target = targetOf(values, env)
    const exec = deps.exec ?? execTailscale
    const http = deps.fetch ?? fetch
    if (command === 'enable') {
      return await enable(target, env, exec, http, out, deps.publishTimeoutMs ?? 45_000)
    }
    if (command === 'disable') {
      return await disable(target, exec, out)
    }
    if (command === 'status') {
      return await status(target, exec, http, out)
    }
    throw new RemoteError(`unknown remote command: ${command}`)
  } catch (error) {
    if (isReportable(error)) {
      err(error.message)
      return 1
    }
    throw error
  }
}

async function enable(
  target: Target,
  env: NodeJS.ProcessEnv,
  exec: Exec,
  http: typeof fetch,
  out: (text: string) => void,
  publishTimeoutMs: number,
): Promise<number> {
  const self = await inspectTailscale(exec)
  if (!self.httpsEnabled) {
    throw new RemoteError(
      'HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin console ' +
        '(DNS, HTTPS Certificates), then run this again.',
    )
  }
  const base = `http://127.0.0.1:${target.port}`
  const mode = await gatewayMode(base, http)
  if (!mode.reachable) {
    throw new RemoteError(`no gateway answers on ${base}; start it with: workerdeck --remote`)
  }
  if (!mode.remote) {
    throw new RemoteError(`the gateway on ${base} is not in remote mode; restart it with --remote, then run this again`)
  }
  await verifyKeyEnforced(base, await readKey(target, env), http)

  const before = await serveStatus(exec)
  const existing = findGatewayRoute(before, self.dnsName, target.port)
  if (existing !== null) {
    out(`already published at ${publicUrl(self.dnsName, existing)}`)
    out('show the pairing link with: workerdeck pair-link')
    return 0
  }
  const servePort = chooseServePort(before)
  await addServeRoute(servePort, target.port, exec)
  const url = publicUrl(self.dnsName, servePort)
  if (!(await waitPublished(url, http, publishTimeoutMs))) {
    await removeServeRoute(servePort, exec).catch(() => {})
    throw new RemoteError(`${url} did not answer as this gateway; the route was removed again`)
  }
  out(`published at ${url} (your tailnet only)`)
  out('show the pairing link with: workerdeck pair-link')
  return 0
}

async function disable(target: Target, exec: Exec, out: (text: string) => void): Promise<number> {
  const self = await inspectTailscale(exec)
  const servePort = findGatewayRoute(await serveStatus(exec), self.dnsName, target.port)
  if (servePort === null) {
    out(`nothing to remove: no tailscale serve route points at port ${target.port}`)
    return 0
  }
  await removeServeRoute(servePort, exec)
  out(`removed ${publicUrl(self.dnsName, servePort)}; the gateway still runs on loopback`)
  return 0
}

async function status(target: Target, exec: Exec, http: typeof fetch, out: (text: string) => void): Promise<number> {
  const self = await inspectTailscale(exec)
  out(`tailscale ${self.version}, ${self.dnsName}, HTTPS certificates ${self.httpsEnabled ? 'on' : 'off'}`)
  const servePort = findGatewayRoute(await serveStatus(exec), self.dnsName, target.port)
  out(servePort === null ? `route: none for port ${target.port}` : `route: ${publicUrl(self.dnsName, servePort)}`)
  const mode = await gatewayMode(`http://127.0.0.1:${target.port}`, http)
  out(
    !mode.reachable
      ? `gateway: nothing answers on port ${target.port}`
      : `gateway: port ${target.port}, ${mode.remote ? 'remote mode' : mode.auth ? 'not remote (key on)' : 'not remote, no key'}`,
  )
  if (mode.reachable && mode.publicUrl) {
    out(`public url: ${mode.publicUrl}`)
  }
  return 0
}

export async function runPairLink(argv: string[], deps: RemoteDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`))
  const err = deps.err ?? ((text: string) => process.stderr.write(`[workerdeck] ${text}\n`))
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string', short: 'p' },
        'state-dir': { type: 'string' },
        'public-url': { type: 'string' },
        'no-qr': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
    if (values.help) {
      out(PAIR_HELP)
      return 0
    }
    const env = deps.env ?? process.env
    const target = targetOf(values, env)
    const base = await pairingBase(values['public-url'], target, env, deps.exec ?? execTailscale, deps.fetch ?? fetch)
    const link = formatPairingLink(base, await readKey(target, env))
    if (!values['no-qr']) {
      const { renderUnicodeCompact } = await import('uqr')
      out(renderUnicodeCompact(link, { border: 2 }))
    }
    out(link)
    out('This link holds the gateway key. Share it only with your own devices.')
    return 0
  } catch (error) {
    if (isReportable(error)) {
      err(error.message)
      return 1
    }
    throw error
  }
}

async function pairingBase(flag: string | undefined, target: Target, env: NodeJS.ProcessEnv, exec: Exec, http: typeof fetch): Promise<string> {
  const declared = flag ?? (env.WORKERDECK_PUBLIC_URL || undefined)
  if (declared !== undefined) {
    try {
      return parsePublicUrl(declared, flag !== undefined ? '--public-url' : 'WORKERDECK_PUBLIC_URL')
    } catch (error) {
      throw new RemoteError((error as Error).message)
    }
  }
  const mode = await gatewayMode(`http://127.0.0.1:${target.port}`, http)
  if (mode.reachable && mode.publicUrl) {
    return mode.publicUrl
  }
  const self = await inspectTailscale(exec)
  const servePort = findGatewayRoute(await serveStatus(exec), self.dnsName, target.port)
  if (servePort === null) {
    throw new RemoteError(
      `port ${target.port} is not published to your tailnet and declares no publicUrl; run: workerdeck remote enable, or pass --public-url`,
    )
  }
  return publicUrl(self.dnsName, servePort)
}
