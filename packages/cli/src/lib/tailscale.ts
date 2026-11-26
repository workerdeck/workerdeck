import { execFile } from 'node:child_process'

// The version the header and route behaviour in `docs/GOTCHAS.md` § Remote mode was verified against.
export const MIN_TAILSCALE_VERSION = '1.104.0'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (args: string[]) => Promise<ExecResult>

export class TailscaleError extends Error {}

// The Mac App Store build ships its CLI inside the app bundle and puts nothing on PATH.
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

function run(command: string, args: string[]): Promise<ExecResult & { missing: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing })
    })
  })
}

export const execTailscale: Exec = async (args) => {
  const result = await run('tailscale', args)
  if (!result.missing || process.platform !== 'darwin') {
    return result
  }
  return await run(MAC_APP_CLI, args)
}

export type ServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>
}

export type TailscaleSelf = { version: string; dnsName: string; httpsEnabled: boolean }

function versionParts(value: string): number[] {
  return value.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10) || 0)
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const [a, b] = [versionParts(version), versionParts(minimum)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0)
    }
  }
  return true
}

export async function inspectTailscale(exec: Exec = execTailscale): Promise<TailscaleSelf> {
  const version = await exec(['version'])
  if (version.code !== 0) {
    throw new TailscaleError('the tailscale CLI was not found. Install Tailscale (https://tailscale.com/download) and sign in.')
  }
  const current = version.stdout.split('\n', 1)[0]!.trim()
  if (!versionAtLeast(current, MIN_TAILSCALE_VERSION)) {
    throw new TailscaleError(`tailscale ${current} is too old; remote mode needs ${MIN_TAILSCALE_VERSION} or newer.`)
  }
  const status = await exec(['status', '--json'])
  let parsed: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null }
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed
  } catch {
    throw new TailscaleError('tailscale is not running. Start it and sign in, then try again.')
  }
  if (parsed.BackendState !== 'Running') {
    throw new TailscaleError(`tailscale is ${parsed.BackendState ?? 'not running'}. Sign in and connect, then try again.`)
  }
  const dnsName = (parsed.Self?.DNSName ?? '').replace(/\.$/, '')
  if (dnsName === '') {
    throw new TailscaleError('this device has no tailnet DNS name. Turn on MagicDNS in the Tailscale admin console.')
  }
  return { version: current, dnsName, httpsEnabled: (parsed.CertDomains ?? []).length > 0 }
}

export async function serveStatus(exec: Exec = execTailscale): Promise<ServeStatus> {
  const result = await exec(['serve', 'status', '--json'])
  if (result.code !== 0) {
    throw new TailscaleError(`tailscale serve status failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  const text = result.stdout.trim()
  if (text === '' || text === '{}') {
    return {}
  }
  try {
    return JSON.parse(text) as ServeStatus
  } catch {
    throw new TailscaleError('tailscale serve status --json printed something that is not JSON')
  }
}

function proxyPort(proxy: string): number | null {
  const match = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy.trim())
  return match ? Number(match[1]) : null
}

// Ours means the whole host:port serves this gateway at `/`; a route that shares the port with other paths is not.
export function findGatewayRoute(status: ServeStatus, dnsName: string, gatewayPort: number): number | null {
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const separator = hostPort.lastIndexOf(':')
    if (hostPort.slice(0, separator) !== dnsName) {
      continue
    }
    const handlers = Object.entries(web.Handlers ?? {})
    if (handlers.length === 1 && handlers[0]![0] === '/' && proxyPort(handlers[0]![1].Proxy ?? '') === gatewayPort) {
      return Number(hostPort.slice(separator + 1))
    }
  }
  return null
}

// `serve` silently replaces whatever a port served, so a port anything else uses is never a candidate.
export function chooseServePort(status: ServeStatus): number {
  const taken = new Set(Object.keys(status.TCP ?? {}).map(Number))
  for (const port of [443, 8443, ...Array.from({ length: 50 }, (_, i) => 8444 + i)]) {
    if (!taken.has(port)) {
      return port
    }
  }
  throw new TailscaleError('no free HTTPS port for tailscale serve (443, 8443 to 8493 are all taken)')
}

export async function addServeRoute(servePort: number, gatewayPort: number, exec: Exec = execTailscale): Promise<void> {
  const result = await exec(['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${gatewayPort}`])
  if (result.code !== 0) {
    throw new TailscaleError(`tailscale serve failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`)
  }
}

export async function removeServeRoute(servePort: number, exec: Exec = execTailscale): Promise<void> {
  const result = await exec(['serve', `--https=${servePort}`, 'off'])
  if (result.code !== 0) {
    throw new TailscaleError(`could not remove the tailscale serve route on ${servePort}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
}

export function publicUrl(dnsName: string, servePort: number): string {
  return servePort === 443 ? `https://${dnsName}` : `https://${dnsName}:${servePort}`
}

// The key rides in the fragment, which browsers never send: no server or proxy log ever sees it.
export function pairingLink(dnsName: string, servePort: number, key: string): string {
  return `${publicUrl(dnsName, servePort)}/#pair=${encodeURIComponent(key)}`
}
