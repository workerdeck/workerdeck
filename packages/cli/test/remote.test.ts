import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePairingLink } from '@workerdeck/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { runPairLink, runRemote } from '../src/lib/remote.ts'
import { chooseServePort, findGatewayRoute, pairingLink, versionAtLeast, type Exec, type ServeStatus } from '../src/lib/tailscale.ts'

const DNS = 'home.tail1234.ts.net'
const KEY = 'k3y-for-the-remote-tests'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-remote-'))
  dirs.push(dir)
  await writeFile(join(dir, 'auth-key'), `${KEY}\n`, { mode: 0o600 })
  return dir
}

function fakeTailscale(initial: ServeStatus, options: { https?: boolean; version?: string } = {}) {
  let status = structuredClone(initial)
  const calls: string[][] = []
  const exec: Exec = async (args) => {
    calls.push(args)
    const line = args.join(' ')
    if (line === 'version') {
      return { code: 0, stdout: `${options.version ?? '1.104.7'}\n  tailscale commit: x\n`, stderr: '' }
    }
    if (line === 'status --json') {
      const certs = options.https === false ? null : [DNS]
      return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DNS}.` }, CertDomains: certs }), stderr: '' }
    }
    if (line === 'serve status --json') {
      return { code: 0, stdout: JSON.stringify(status), stderr: '' }
    }
    const add = /^serve --bg --https=(\d+) (\S+)$/.exec(line)
    if (add) {
      status = {
        TCP: { ...status.TCP, [add[1]!]: { HTTPS: true } },
        Web: { ...status.Web, [`${DNS}:${add[1]}`]: { Handlers: { '/': { Proxy: add[2]! } } } },
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const off = /^serve --https=(\d+) off$/.exec(line)
    if (off) {
      const { [off[1]!]: _t, ...tcp } = status.TCP ?? {}
      const { [`${DNS}:${off[1]}`]: _w, ...web } = status.Web ?? {}
      status = { TCP: tcp, Web: web }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected: ${line}` }
  }
  return { exec, calls, status: () => status }
}

function fakeGateway(options: { remote?: boolean; openMeta?: boolean; published?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === DNS && options.published === false) {
      throw new TypeError('fetch failed')
    }
    if (url.pathname === '/auth/status') {
      return Response.json({ enabled: true, authenticated: false, ...(options.remote === false ? {} : { remote: true }) })
    }
    if (url.pathname === '/v1/meta') {
      const key = new Headers(init?.headers).get('x-workerdeck-key')
      return new Response(null, { status: key === KEY || options.openMeta ? 200 : 401 })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
}

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: (text: string) => lines.push(text), err: (text: string) => errors.push(text) }
}

const UNRELATED: ServeStatus = {
  TCP: { '443': { HTTPS: true } },
  Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8190' } } } },
}

describe('tailscale helpers', () => {
  it('compares versions numerically', () => {
    expect(versionAtLeast('1.104.7', '1.104.0')).toBe(true)
    expect(versionAtLeast('1.98.12', '1.104.0')).toBe(false)
    expect(versionAtLeast('2.0.0', '1.104.0')).toBe(true)
  })

  it('finds only a whole-host route to this gateway port', () => {
    expect(findGatewayRoute(UNRELATED, DNS, 8787)).toBeNull()
    expect(findGatewayRoute(UNRELATED, DNS, 8190)).toBe(443)
    const shared: ServeStatus = {
      Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' }, '/x': { Proxy: '9000' } } } },
    }
    expect(findGatewayRoute(shared, DNS, 8787)).toBeNull()
  })

  it('never picks a port that serves anything else', () => {
    expect(chooseServePort({})).toBe(443)
    expect(chooseServePort(UNRELATED)).toBe(8443)
  })

  it('produces a link every client parses back', () => {
    expect(parsePairingLink(pairingLink(DNS, 8443, KEY))).toEqual({ baseUrl: `https://${DNS}:8443`, key: KEY })
    expect(parsePairingLink(` ${pairingLink(DNS, 443, 'a+b/c%d-123456')}\n`)).toEqual({ baseUrl: `https://${DNS}`, key: 'a+b/c%d-123456' })
    expect(parsePairingLink(`https://${DNS}/#/sessions`)).toBeNull()
    expect(parsePairingLink(`https://${DNS}/#pair=short`)).toBeNull()
    expect(parsePairingLink(`ftp://${DNS}/#pair=${KEY}`)).toBeNull()
    // The same cases as the Rust core's `a_pairing_link_parses_like_the_typescript_rule`.
    expect(parsePairingLink(`https://Home.tail1.ts.net:443/#pair=${KEY}`)).toEqual({ baseUrl: 'https://home.tail1.ts.net', key: KEY })
    expect(parsePairingLink(`https://${DNS}/#pair=bad%zz-escape-1234`)).toBeNull()
  })

  it('puts the key in the fragment', () => {
    expect(pairingLink(DNS, 443, 'a+b')).toBe(`https://${DNS}/#pair=a%2Bb`)
    expect(pairingLink(DNS, 8443, 'k')).toBe(`https://${DNS}:8443/#pair=k`)
  })
})

describe('workerdeck remote', () => {
  it('publishes a verified remote gateway beside an unrelated route', async () => {
    const ts = fakeTailscale(UNRELATED)
    const io = capture()
    const code = await runRemote(['enable', '--state-dir', await stateDir()], { exec: ts.exec, fetch: fakeGateway(), env: {}, ...io })
    expect(io.errors).toEqual([])
    expect(code).toBe(0)
    expect(ts.status().Web?.[`${DNS}:443`]?.Handlers?.['/']?.Proxy).toBe('http://127.0.0.1:8190')
    expect(findGatewayRoute(ts.status(), DNS, 8787)).toBe(8443)
    expect(io.lines[0]).toBe(`published at https://${DNS}:8443 (your tailnet only)`)
  })

  it('refuses a gateway that is not in remote mode or answers without the key', async () => {
    for (const gateway of [fakeGateway({ remote: false }), fakeGateway({ openMeta: true })]) {
      const ts = fakeTailscale({})
      const io = capture()
      expect(await runRemote(['enable', '--state-dir', await stateDir()], { exec: ts.exec, fetch: gateway, env: {}, ...io })).toBe(1)
      expect(ts.calls.some((args) => args.includes('--bg'))).toBe(false)
    }
  })

  it('explains the tailnet HTTPS toggle instead of publishing', async () => {
    const ts = fakeTailscale({}, { https: false })
    const io = capture()
    expect(await runRemote(['enable', '--state-dir', await stateDir()], { exec: ts.exec, fetch: fakeGateway(), env: {}, ...io })).toBe(1)
    expect(io.errors[0]).toMatch(/HTTPS certificates are off/)
  })

  it('removes the route again when the published URL never answers', async () => {
    const ts = fakeTailscale({})
    const io = capture()
    const code = await runRemote(['enable', '--state-dir', await stateDir()], {
      exec: ts.exec,
      fetch: fakeGateway({ published: false }),
      env: {},
      publishTimeoutMs: 10,
      ...io,
    })
    expect(code).toBe(1)
    expect(ts.status().Web ?? {}).toEqual({})
  })

  it('disable removes only its own route', async () => {
    const ts = fakeTailscale(UNRELATED)
    const dir = await stateDir()
    await runRemote(['enable', '--state-dir', dir], { exec: ts.exec, fetch: fakeGateway(), env: {}, ...capture() })
    expect(await runRemote(['disable'], { exec: ts.exec, env: {}, ...capture() })).toBe(0)
    expect(ts.status()).toEqual(UNRELATED)
    const io = capture()
    expect(await runRemote(['disable'], { exec: ts.exec, env: {}, ...io })).toBe(0)
    expect(io.lines[0]).toMatch(/nothing to remove/)
  })

  it('pair-link prints the link for a published gateway only', async () => {
    const ts = fakeTailscale(UNRELATED)
    const dir = await stateDir()
    const before = capture()
    expect(await runPairLink(['--state-dir', dir], { exec: ts.exec, env: {}, ...before })).toBe(1)
    await runRemote(['enable', '--state-dir', dir], { exec: ts.exec, fetch: fakeGateway(), env: {}, ...capture() })
    const io = capture()
    expect(await runPairLink(['--state-dir', dir, '--no-qr'], { exec: ts.exec, env: {}, ...io })).toBe(0)
    expect(io.lines[0]).toBe(`https://${DNS}:8443/#pair=${KEY}`)
  })
})
