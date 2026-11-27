import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renderPlist, runService, servicePath, type ExecResult } from '../src/lib/service.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-service-'))
  dirs.push(dir)
  return dir
}

const SELF = { node: '/opt/node/bin/node', execArgv: [], script: '/opt/lib/workerdeck/build/cli.mjs' }

function fakeLaunchd() {
  let loaded = false
  let up = false
  const calls: string[] = []
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args].join(' '))
    const [verb] = args
    if (verb === 'print') {
      return loaded ? { code: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' } : { code: 113, stdout: '', stderr: 'Bad request.' }
    }
    if (verb === 'bootstrap') {
      loaded = true
      up = true
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'bootout') {
      loaded = false
      up = false
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'kickstart') {
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  const http = (async () => {
    if (!up) {
      throw new TypeError('fetch failed')
    }
    return Response.json({ enabled: true })
  }) as unknown as typeof fetch
  return { exec, http, calls, setUp: (value: boolean) => (up = value) }
}

function io() {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: (t: string) => lines.push(t), err: (t: string) => errors.push(t) }
}

describe('workerdeck service', () => {
  it('installs an agent that runs this build with its port and state dir, then starts it', async () => {
    const h = await home()
    const launchd = fakeLaunchd()
    const capture = io()
    const deps = { exec: launchd.exec, fetch: launchd.http, home: h, platform: 'darwin' as const, uid: 501, self: SELF, env: { PATH: '/x/bin' } }
    expect(await runService(['install', '--', '--remote', '--port', '8790'], { ...deps, ...capture })).toBe(0)
    const plist = await readFile(join(h, 'Library/LaunchAgents/dev.workerdeck.gateway.8790.plist'), 'utf8')
    expect(plist).toContain('<string>/opt/lib/workerdeck/build/cli.mjs</string>\n    <string>--remote</string>')
    expect(plist).toContain(`<string>--state-dir</string>\n    <string>${join(h, '.workerdeck')}</string>`)
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(launchd.calls).toContain(`launchctl bootstrap gui/501 ${join(h, 'Library/LaunchAgents/dev.workerdeck.gateway.8790.plist')}`)
    expect(existsSync(join(h, '.workerdeck/logs'))).toBe(true)
    expect(plist).toContain('<key>WorkingDirectory</key><string>/opt/lib/workerdeck/build</string>')
    const again = io()
    expect(await runService(['install', '--port', '8790'], { ...deps, ...again })).toBe(1)
    expect(again.errors[0]).toContain('already installed')
  })

  it('refuses a temporary npx path, a busy port and other platforms', async () => {
    const h = await home()
    const launchd = fakeLaunchd()
    const base = { exec: launchd.exec, fetch: launchd.http, home: h, platform: 'darwin' as const, uid: 501, env: {} }
    const npx = io()
    const self = { ...SELF, script: '/Users/a/.npm/_npx/123/node_modules/workerdeck/build/cli.mjs' }
    expect(await runService(['install'], { ...base, self, ...npx })).toBe(1)
    expect(npx.errors[0]).toContain('npm install -g workerdeck')
    launchd.setUp(true)
    const busy = io()
    expect(await runService(['install'], { ...base, self: SELF, ...busy })).toBe(1)
    expect(busy.errors[0]).toContain('already answers on port 8787')
    const linux = io()
    expect(await runService(['status'], { ...base, platform: 'linux', ...linux })).toBe(1)
    expect(linux.errors[0]).toContain('macOS only')
  })

  it('stops, restarts and uninstalls only past the guard unless forced', async () => {
    const h = await home()
    const launchd = fakeLaunchd()
    let verdict = 1
    const guardCalls: string[][] = []
    const guard = async (argv: string[]) => {
      guardCalls.push(argv)
      return verdict
    }
    const deps = { exec: launchd.exec, fetch: launchd.http, home: h, platform: 'darwin' as const, uid: 501, self: SELF, env: {}, guard }
    await runService(['install'], { ...deps, ...io() })
    const busy = io()
    expect(await runService(['stop'], { ...deps, ...busy })).toBe(1)
    expect(busy.errors[0]).toContain('a turn is running')
    expect(guardCalls[0]).toEqual(['--url', 'http://127.0.0.1:8787/v1'])
    expect(await runService(['restart', '--force'], { ...deps, ...io() })).toBe(0)
    expect(launchd.calls).toContain('launchctl kickstart -k gui/501/dev.workerdeck.gateway.8787')
    verdict = 0
    const status = io()
    await runService(['status'], { ...deps, ...status })
    expect(status.lines).toEqual([
      expect.stringContaining('installed'),
      'launchd: loaded, pid 4242',
      'gateway: answers on port 8787',
    ])
    expect(await runService(['uninstall'], { ...deps, ...io() })).toBe(0)
    expect(existsSync(join(h, 'Library/LaunchAgents/dev.workerdeck.gateway.8787.plist'))).toBe(false)
    expect(launchd.calls).toContain('launchctl bootout gui/501/dev.workerdeck.gateway.8787')
  })

  it('keeps PATH stable and escapes the plist', () => {
    expect(servicePath('/n/bin/node', '/a:/Users/x/.local/state/fnm_multishells/1_2/bin:/a:/b/_npx/9/bin')).toBe(
      '/n/bin:/a:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
    const plist = renderPlist({ label: 'l', programArguments: ['a&b', '<c>'], path: '/p', stateDir: '/s', workingDirectory: '/s' })
    expect(plist).toContain('<string>a&amp;b</string>')
    expect(plist).toContain('<string>&lt;c&gt;</string>')
  })
})
