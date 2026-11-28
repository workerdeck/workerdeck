import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gatewayArgv } from '../src/host/argv.ts'
import {
  plistProgramArguments,
  serviceArgvCurrent,
  serviceCommand,
  serviceInstallCommand,
  serviceOwned,
  servicePlistPath,
} from '../src/host/service.ts'
import type { HostSettings } from '../src/host/settings.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function settings(overrides: Partial<HostSettings> = {}): HostSettings {
  return {
    enabled: true,
    autoStart: true,
    port: 8794,
    bindAddress: '127.0.0.1',
    requireAuthKey: false,
    remote: false,
    publicUrl: undefined,
    stateDir: '/tmp/wd-svc-vsc',
    configPath: undefined,
    binaryPath: undefined,
    useNpx: true,
    npxSpec: undefined,
    dashboard: true,
    shell: false,
    shellAgentWrite: 'read-only',
    hotReload: false,
    cwdRoots: [],
    statusBar: true,
    name: 'This machine',
    engineSleepAfterMinutes: 0,
    agentSleepAfterMinutes: 15,
    effortDefaults: {},
    agentContextReset: 'off',
    agentSharing: 'private',
    keepAwake: 'work',
    ...overrides,
  }
}

function plistOf(programArguments: string[]): string {
  const args = programArguments.map((arg) => `    <string>${arg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.workerdeck.gateway.8794</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin</string>
  </dict>
</dict>
</plist>
`
}

describe('gatewayArgv keepAwake', () => {
  it('passes nothing for work, the CLI default', () => {
    const argv = gatewayArgv(settings())
    expect(argv).not.toContain('--keep-awake')
    expect(argv).not.toContain('--no-keep-awake')
  })

  it('passes --keep-awake always and --no-keep-awake', () => {
    expect(gatewayArgv(settings({ keepAwake: 'always' })).join(' ')).toContain('--keep-awake always')
    expect(gatewayArgv(settings({ keepAwake: 'off' }))).toContain('--no-keep-awake')
  })
})

describe('gatewayArgv requireAuthKey', () => {
  it('asks for the stored key on loopback, and leaves it to --remote there', () => {
    expect(gatewayArgv(settings({ requireAuthKey: true }))).toContain('--require-auth-key')
    expect(gatewayArgv(settings({ requireAuthKey: true, remote: true }))).not.toContain('--require-auth-key')
    expect(gatewayArgv(settings())).not.toContain('--require-auth-key')
  })
})

describe('service commands', () => {
  it('forces stop, restart and uninstall, never naming the port or state dir runCli appends', () => {
    expect(serviceCommand('stop')).toEqual(['service', 'stop', '--force'])
    expect(serviceCommand('restart')).toEqual(['service', 'restart', '--force'])
    expect(serviceCommand('uninstall')).toEqual(['service', 'uninstall', '--force'])
    expect(serviceCommand('start')).toEqual(['service', 'start'])
  })

  it('installs with the gateway argv after --, less its port and state dir', () => {
    const command = serviceInstallCommand(gatewayArgv(settings({ remote: true, keepAwake: 'always', cwdRoots: ['/src'] })))
    expect(command).toEqual(['service', 'install', '--', '--host', '127.0.0.1', '--remote', '--cwd-root', '/src', '--keep-awake', 'always'])
  })
})

describe('service plist', () => {
  it('lives under ~/Library/LaunchAgents, keyed on the port', () => {
    expect(servicePlistPath(8794, '/Users/me')).toBe('/Users/me/Library/LaunchAgents/dev.workerdeck.gateway.8794.plist')
  })

  it('owns the port only on macOS, and only while the plist exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wd-vsc-service-'))
    dirs.push(home)
    expect(serviceOwned(8794, 'darwin', home)).toBe(false)
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(servicePlistPath(8794, home), plistOf(['/bin/node']))
    expect(serviceOwned(8794, 'darwin', home)).toBe(true)
    expect(serviceOwned(8794, 'linux', home)).toBe(false)
    expect(serviceOwned(8795, 'darwin', home)).toBe(false)
  })

  it('reads ProgramArguments, unescaped', () => {
    expect(plistProgramArguments(plistOf(['/bin/node', '/opt/a&b/cli.mjs']))).toEqual(['/bin/node', '/opt/a&b/cli.mjs'])
  })

  it('is current when the installed flags match what install would write today', () => {
    const argv = gatewayArgv(settings({ keepAwake: 'always' }))
    const installed = [
      '/bin/node',
      '/opt/workerdeck/cli.mjs',
      ...serviceInstallCommand(argv).slice(3),
      '--port',
      '8794',
      '--state-dir',
      '/tmp/wd-svc-vsc',
    ]
    expect(serviceArgvCurrent(plistOf(installed), argv)).toBe(true)
  })

  it('is stale when a setting changed the flags, added or removed', () => {
    const before = gatewayArgv(settings({ keepAwake: 'always', remote: true }))
    const installed = [
      '/bin/node',
      '/opt/workerdeck/cli.mjs',
      ...serviceInstallCommand(before).slice(3),
      '--port',
      '8794',
      '--state-dir',
      '/tmp/wd-svc-vsc',
    ]
    expect(serviceArgvCurrent(plistOf(installed), gatewayArgv(settings({ keepAwake: 'always' })))).toBe(false)
    expect(serviceArgvCurrent(plistOf(installed), gatewayArgv(settings({ keepAwake: 'always', remote: true, shell: true })))).toBe(false)
    expect(
      serviceArgvCurrent(plistOf(installed), gatewayArgv(settings({ keepAwake: 'always', remote: true, stateDir: '/elsewhere' }))),
    ).toBe(false)
    expect(serviceArgvCurrent('', before)).toBe(false)
  })
})
