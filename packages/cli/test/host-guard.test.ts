import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { hostnameOf, isLoopbackHostname, parseArgs, resolveInstanceConfig } from '../src/config.ts'
import { createHostGuard } from '../src/instance.ts'

const req = (host?: string): IncomingMessage =>
  ({ headers: host === undefined ? {} : { host } }) as unknown as IncomingMessage

const noConfig = { path: null, options: {} }

describe('hostnameOf', () => {
  it('strips the port and IPv6 brackets, and lowercases', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1')
    expect(hostnameOf('LocalHost:8787')).toBe('localhost')
    expect(hostnameOf('[::1]:8787')).toBe('::1')
    expect(hostnameOf('example.com')).toBe('example.com')
  })

  it('returns empty for a header it cannot parse', () => {
    expect(hostnameOf('')).toBe('')
    expect(hostnameOf('a b c')).toBe('')
  })
})

describe('isLoopbackHostname', () => {
  it('accepts the whole 127.0.0.0/8 block and the names for it', () => {
    for (const h of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', 'localhost']) {
      expect(isLoopbackHostname(h)).toBe(true)
    }
  })

  it('rejects anything routable', () => {
    for (const h of ['evil.com', '10.0.0.1', '0.0.0.0', '169.254.1.1']) {
      expect(isLoopbackHostname(h)).toBe(false)
    }
  })
})

describe('createHostGuard', () => {
  it('is a no-op when auth is on (allowedHosts is null)', () => {
    const guard = createHostGuard(null)
    expect(guard(req('evil.com'))).toBe(true)
  })

  describe('on an unauthenticated instance', () => {
    const guard = createHostGuard(new Set(['127.0.0.1', '::1', 'localhost']))

    it('accepts loopback host names', () => {
      expect(guard(req('127.0.0.1:8787'))).toBe(true)
      expect(guard(req('localhost:8787'))).toBe(true)
      expect(guard(req('[::1]:8787'))).toBe(true)
    })

    it('rejects a rebound public name — the whole point of the guard', () => {
      // The connection really does arrive on 127.0.0.1 (the attacker controls
      // their own DNS); what they cannot forge is the Host the browser sends.
      expect(guard(req('attacker.example:8787'))).toBe(false)
    })

    it('rejects an unparseable Host rather than falling open', () => {
      expect(guard(req('a b c'))).toBe(false)
    })

    it('allows a missing Host — not a browser, so not a rebinding victim', () => {
      expect(guard(req(undefined))).toBe(true)
    })

    it('honours an operator-added name', () => {
      const custom = createHostGuard(new Set(['127.0.0.1', 'localhost', 'devbox.local']))
      expect(custom(req('devbox.local:8787'))).toBe(true)
      expect(custom(req('other.local:8787'))).toBe(false)
    })
  })
})

describe('resolveInstanceConfig and the host guard', () => {
  it('arms the guard only when there is no auth', () => {
    expect(resolveInstanceConfig(parseArgs([]), noConfig, {}).allowedHosts).not.toBeNull()
    expect(
      resolveInstanceConfig(parseArgs(['--auth-key', 'long-enough-secret']), noConfig, {})
        .allowedHosts,
    ).toBeNull()
  })

  it('stands down when the config file authenticates for itself', () => {
    const loaded = { path: '/x/c.mjs', options: { authenticate: () => ({}) } }
    expect(resolveInstanceConfig(parseArgs([]), loaded, {}).allowedHosts).toBeNull()
  })

  it('treats an empty auth key as unset, not as auth', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, { WORKERDECK_AUTH_KEY: '' })
    expect(config.authKey).toBeUndefined()
    expect(config.allowedHosts).not.toBeNull()
  })

  it('carries --allowed-host and --allowed-origin through', () => {
    const config = resolveInstanceConfig(
      parseArgs(['--allowed-host', 'devbox.local', '--allowed-origin', 'https://ops.example.com']),
      noConfig,
      {},
    )
    expect(config.allowedHosts?.has('devbox.local')).toBe(true)
    expect(config.auth.allowedOrigins).toEqual(['https://ops.example.com'])
  })

  it('lowercases allowed hosts so they can actually match a Host header', () => {
    // hostnameOf lowercases what the guard compares, so an uppercase entry
    // would otherwise be a gate that looks armed and never opens.
    const config = resolveInstanceConfig(parseArgs(['--allowed-host', 'DevBox.Local']), noConfig, {})
    const guard = createHostGuard(config.allowedHosts)
    expect(guard(req('devbox.local:8787'))).toBe(true)
  })

  it('lets the guard honour an insecure host end to end', () => {
    const config = resolveInstanceConfig(
      parseArgs(['--host', 'toby', '--insecure-host', 'toby']),
      noConfig,
      {},
    )
    const guard = createHostGuard(config.allowedHosts)
    expect(guard(req('toby:8787'))).toBe(true)
    expect(guard(req('attacker.example:8787'))).toBe(false)
  })

  it('reads port, host and auth from the config file, with flags still winning', () => {
    const loaded = {
      path: '/x/c.mjs',
      options: { port: 9100, host: '0.0.0.0', auth: { secret: 'from-the-config-file' } },
    }
    const fromFile = resolveInstanceConfig(parseArgs([]), loaded, {})
    expect(fromFile.port).toBe(9100)
    expect(fromFile.authKey).toBe('from-the-config-file')

    const overridden = resolveInstanceConfig(parseArgs(['--port', '1234']), loaded, {})
    expect(overridden.port).toBe(1234)
  })

  it('keeps instance-only keys out of the server options', () => {
    const loaded = {
      path: '/x/c.mjs',
      options: { port: 9100, host: '0.0.0.0', auth: { secret: 'x'.repeat(20) }, basePath: '/api' },
    }
    const config = resolveInstanceConfig(parseArgs([]), loaded, {})
    expect(config.options.basePath).toBe('/api')
    expect(config.options).not.toHaveProperty('port')
    expect(config.options).not.toHaveProperty('auth')
  })
})
