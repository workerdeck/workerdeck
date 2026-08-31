import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError, defaultStateDir, isLoopback, loadConfigFile, parseArgs, resolveInstanceConfig } from '../src/config.ts'

const noConfig = { path: null, options: {} }

// Fixtures live under the package because vitest loads them through vite's module graph, which will not read a file
// outside the project root. The CLI itself has no such limit.
const created: string[] = []
async function tempConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-config-'))
  created.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseArgs', () => {
  it('parses the common flags', () => {
    const flags = parseArgs(['--port', '9000', '--host', '0.0.0.0', '--auth-key', 's3cret'])
    expect(flags.port).toBe(9000)
    expect(flags.host).toBe('0.0.0.0')
    expect(flags.authKey).toBe('s3cret')
  })

  it('accepts repeated profiles and cwd roots, resolving paths', () => {
    const flags = parseArgs(['--profile', 'toby=./a', '--profile', 'dan=./b', '--cwd-root', './c'])
    expect(flags.profiles).toEqual([
      { name: 'toby', configDir: resolve('./a') },
      { name: 'dan', configDir: resolve('./b') },
    ])
    expect(flags.cwdRoots).toEqual([resolve('./c')])
  })

  it('rejects a profile without a directory', () => {
    expect(() => parseArgs(['--profile', 'toby'])).toThrow(ConfigError)
    expect(() => parseArgs(['--profile', 'toby='])).toThrow(ConfigError)
  })

  it('accepts repeated insecure hosts', () => {
    const flags = parseArgs(['--insecure-host', 'toby', '--insecure-host', '0.0.0.0'])
    expect(flags.insecureHosts).toEqual(['toby', '0.0.0.0'])
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['--porrt', '9000'])).toThrow(/unknown option/)
  })

  it('rejects a port that is not a port', () => {
    expect(() => parseArgs(['--port', 'http'])).toThrow(ConfigError)
    expect(() => parseArgs(['--port', '99999'])).toThrow(ConfigError)
  })

  it('treats a missing value as an error, not as the next flag', () => {
    expect(() => parseArgs(['--auth-key', '--port', '9000'])).toThrow(/requires a value/)
  })
})

describe('resolveInstanceConfig', () => {
  it('defaults to loopback on 8787', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, {})
    expect(config.port).toBe(8787)
    expect(config.host).toBe('127.0.0.1')
    expect(config.authKey).toBeUndefined()
  })

  it('lets flags beat env', () => {
    const config = resolveInstanceConfig(parseArgs(['--port', '1234']), noConfig, {
      WORKERDECK_PORT: '9999',
      WORKERDECK_AUTH_KEY: 'from-env',
    })
    expect(config.port).toBe(1234)
    expect(config.authKey).toBe('from-env')
  })

  it('plans a generated key instead of serving open on a routable address', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), noConfig, {})
    expect(config.generateAuthKey).toBe(true)
    expect(config.authKey).toBeUndefined()
    expect(config.allowedHosts).toBeNull()
  })

  it('never plans generation with a key, with --insecure, or on loopback', () => {
    const withKey = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0', '--auth-key', 'k']), noConfig, {})
    expect(withKey.generateAuthKey).toBe(false)
    expect(withKey.authKey).toBe('k')

    const insecure = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0', '--insecure']), noConfig, {})
    expect(insecure.generateAuthKey).toBe(false)
    expect(insecure.allowedHosts).not.toBeNull()

    const loopback = resolveInstanceConfig(parseArgs(['--host', '::1']), noConfig, {})
    expect(loopback.generateAuthKey).toBe(false)
    expect(loopback.authKey).toBeUndefined()
  })

  it('keeps the zero-config loopback instance keyless', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, {})
    expect(config.generateAuthKey).toBe(false)
    expect(config.authKey).toBeUndefined()
    expect(config.allowedHosts).not.toBeNull()
  })

  it('never plans generation under allowUnauthenticated', () => {
    const loaded = { path: '/x/c.mjs', options: { allowUnauthenticated: true } }
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), loaded, {})
    expect(config.generateAuthKey).toBe(false)
  })

  it('accepts a config file that authenticates for itself', () => {
    const loaded = { path: '/x/workerdeck.config.mjs', options: { authenticate: () => ({}) } }
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), loaded, {})
    expect(config.hostAuthenticates).toBe(true)
    expect(config.generateAuthKey).toBe(false)
  })

  it('enables durable parking by default and --no-parking-store turns it off', () => {
    expect(resolveInstanceConfig(parseArgs([]), noConfig, {}).stateDir).toBeTruthy()
    expect(resolveInstanceConfig(parseArgs(['--no-parking-store']), noConfig, {}).stateDir).toBeNull()
  })

  it('reads cwd roots from a colon-separated env var', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, {
      WORKERDECK_CWD_ROOTS: '/tmp/a:/tmp/b',
    })
    expect(config.options.allowedCwdRoots).toEqual([resolve('/tmp/a'), resolve('/tmp/b')])
  })

  it('leaves hostFiles unset when nothing narrows it — the server inherits the cwd roots', () => {
    const config = resolveInstanceConfig(parseArgs(['--cwd-root', '/tmp/a']), noConfig, {})
    expect(config.options.allowedCwdRoots).toEqual([resolve('/tmp/a')])
    expect(config.options.hostFiles).toBeUndefined()
  })

  it('takes fs roots from flags or a colon-separated env var, and --fs-write is its own switch', () => {
    const flagged = resolveInstanceConfig(parseArgs(['--fs-root', '/tmp/a', '--fs-root', '/tmp/b', '--fs-write']), noConfig, {})
    expect(flagged.options.hostFiles).toEqual({
      roots: [resolve('/tmp/a'), resolve('/tmp/b')],
      write: true,
    })

    const fromEnv = resolveInstanceConfig(parseArgs([]), noConfig, {
      WORKERDECK_FS_ROOTS: '/tmp/a:/tmp/b',
    })
    expect(fromEnv.options.hostFiles).toEqual({ roots: [resolve('/tmp/a'), resolve('/tmp/b')] })
  })

  it('lets --fs-write turn on writes for roots the config file declared', () => {
    const config = resolveInstanceConfig(
      parseArgs(['--fs-write']),
      { path: '/x/c.mjs', options: { hostFiles: { roots: ['/srv/projects'] } } },
      {},
    )
    expect(config.options.hostFiles).toEqual({ roots: ['/srv/projects'], write: true })
  })

  it('puts state beside the config file when there is one', () => {
    expect(defaultStateDir('/srv/worker/workerdeck.config.mjs')).toBe('/srv/worker/.workerdeck')
  })
})

describe('insecureHosts', () => {
  const withInsecure = (hosts: string[]) => ({
    path: '/x/c.mjs',
    options: { insecureHosts: hosts },
  })

  it('lets a declared bind host serve without auth, and accepts it as a Host header', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', 'toby']), withInsecure(['toby']), {})
    expect(config.generateAuthKey).toBe(false)
    expect(config.authKey).toBeUndefined()
    expect(config.allowedHosts?.has('toby')).toBe(true)
    expect(config.allowedHosts?.has('localhost')).toBe(true)
  })

  it('works as a repeatable --insecure-host flag too', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', 'toby', '--insecure-host', 'toby']), noConfig, {})
    expect(config.generateAuthKey).toBe(false)
    expect(config.allowedHosts?.has('toby')).toBe(true)
  })

  it('matches case-insensitively in both directions', () => {
    const upper = resolveInstanceConfig(parseArgs(['--host', 'TOBY']), withInsecure(['toby']), {})
    expect(upper.generateAuthKey).toBe(false)
    const upperEntry = resolveInstanceConfig(parseArgs(['--host', 'toby']), withInsecure(['TOBY']), {})
    expect(upperEntry.generateAuthKey).toBe(false)
    expect(upperEntry.allowedHosts?.has('toby')).toBe(true)
  })

  it('matches the bind host literally — a declaration is not a wildcard', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), withInsecure(['toby']), {})
    expect(config.generateAuthKey).toBe(true)
    expect(config.allowedHosts).toBeNull()
  })

  it('accepts 0.0.0.0 as "every interface", with the Host gate still fenced', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), withInsecure(['0.0.0.0', 'toby']), {})
    expect(config.generateAuthKey).toBe(false)
    expect(config.allowedHosts?.has('0.0.0.0')).toBe(true)
    expect(config.allowedHosts?.has('toby')).toBe(true)
    expect(config.allowedHosts?.has('attacker.example')).toBe(false)
  })

  it('handles bare IPv6 entries', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', 'fd7a::1234']), withInsecure(['fd7a::1234']), {})
    expect(config.generateAuthKey).toBe(false)
    expect(config.allowedHosts?.has('fd7a::1234')).toBe(true)
  })

  it('rejects an entry carrying a port rather than silently never matching', () => {
    expect(() => resolveInstanceConfig(parseArgs(['--host', 'toby']), withInsecure(['toby:8787']), {})).toThrow(/carries a port/)
    expect(() => resolveInstanceConfig(parseArgs(['--host', '::1']), withInsecure(['[::1]:8787']), {})).toThrow(/carries a port/)
  })

  it('rejects an entry that is not a host at all', () => {
    expect(() => resolveInstanceConfig(parseArgs([]), withInsecure(['a b c']), {})).toThrow(ConfigError)
    expect(() => resolveInstanceConfig(parseArgs([]), withInsecure(['http://toby']), {})).toThrow(ConfigError)
  })

  it('weakens nothing when auth is on', () => {
    const config = resolveInstanceConfig(parseArgs(['--host', 'toby', '--auth-key', 'long-enough-secret']), withInsecure(['toby']), {})
    expect(config.authKey).toBe('long-enough-secret')
    expect(config.generateAuthKey).toBe(false)
    expect(config.allowedHosts).toBeNull()
  })
})

describe('loadConfigFile', () => {
  it('returns empty options when there is no config file', async () => {
    const dir = await tempConfigDir()
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded).toEqual({ path: null, options: {} })
  })

  it('loads a default-exported object', async () => {
    const dir = await tempConfigDir()
    await writeFile(join(dir, 'workerdeck.config.mjs'), 'export default { basePath: "/api", allowUnauthenticated: true }\n')
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded.options.basePath).toBe('/api')
  })

  it('loads a default-exported function, including an async one', async () => {
    const dir = await tempConfigDir()
    await writeFile(join(dir, 'workerdeck.config.mjs'), 'export default async () => ({ basePath: "/late" })\n')
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded.options.basePath).toBe('/late')
  })

  it('fails loudly on an explicit path that does not exist', async () => {
    await expect(loadConfigFile('/nope/workerdeck.config.mjs')).rejects.toThrow(/no config file/)
  })

  it('fails on a config file with no default export', async () => {
    const dir = await tempConfigDir()
    await writeFile(join(dir, 'workerdeck.config.mjs'), 'export const port = 1\n')
    await expect(loadConfigFile(undefined, dir)).rejects.toThrow(/no default export/)
  })
})

describe('isLoopback', () => {
  it('knows the loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('192.168.1.4')).toBe(false)
  })
})
