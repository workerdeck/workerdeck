import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { parseArgs } from '../config.ts'
import { runGuard } from './guard.ts'

const HELP = `usage: workerdeck service <install|uninstall|start|stop|restart|status> [options] [-- gateway flags]

Runs the gateway as a macOS LaunchAgent: it starts at login, restarts after a crash and keeps
running when every editor and terminal is closed. Same user, so CLI Keychain logins keep working.

  install [--port N] [--state-dir PATH] [-- flags]   write the agent and start it; flags after --
                                                     go to the gateway (e.g. -- --remote --keep-awake always)
  uninstall [--force]   stop it and remove the agent
  start                 start an installed agent
  stop [--force]        stop it until the next start or login
  restart [--force]     restart it in place
  status                show the agent and whether the gateway answers

stop, restart and uninstall refuse while a turn is running (workerdeck guard); --force skips that.
exit 0 = done, 1 = refused or failed
`

export type ExecResult = { code: number; stdout: string; stderr: string }

export type ServiceDeps = {
  exec?: (command: string, args: string[]) => Promise<ExecResult>
  fetch?: typeof fetch
  portTaken?: (port: number) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  uid?: number
  // The command line that starts this very CLI, so the agent runs the same build: node, its flags, the entry script.
  self?: { node: string; execArgv: string[]; script: string }
  guard?: (argv: string[]) => Promise<number>
  out?: (text: string) => void
  err?: (text: string) => void
  startTimeoutMs?: number
}

class ServiceError extends Error {}

export type ServiceTarget = { port: number; stateDir: string; label: string; plist: string }

const LABEL_PREFIX = 'dev.workerdeck.gateway'

export function serviceLabel(port: number): string {
  return `${LABEL_PREFIX}.${port}`
}

function run(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      done({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// An npx cache path disappears on the next cache clean, and an fnm per-shell path with the shell that made it.
function ephemeral(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path) || /fnm_multishells/.test(path)
}

export function servicePath(node: string, current: string | undefined): string {
  const entries = [dirname(node), ...(current ?? '').split(delimiter), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set(entries.filter((entry) => entry !== '' && !ephemeral(entry)))].join(delimiter)
}

export type PlistInput = {
  label: string
  programArguments: string[]
  path: string
  stateDir: string
  workingDirectory: string
}

export function renderPlist({ label, programArguments, path, stateDir, workingDirectory }: PlistInput): string {
  const args = programArguments.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')
  const log = xml(join(stateDir, 'logs', 'gateway.log'))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new ServiceError(`${name} needs a value`)
  }
  args.splice(index, 2)
  return value
}

function takeSwitch(args: string[], name: string): boolean {
  const index = args.indexOf(name)
  if (index < 0) {
    return false
  }
  args.splice(index, 1)
  return true
}

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServiceError(`not a valid port: ${raw}`)
  }
  return port
}

// The gateway's own flags may name the port and state dir too; theirs win, and the agent is keyed on the port.
function targetOf(own: string[], gateway: string[], env: NodeJS.ProcessEnv, home: string): ServiceTarget {
  const named = (flag: string, short?: string): string | undefined => {
    for (let i = gateway.length - 2; i >= 0; i--) {
      if (gateway[i] === flag || (short !== undefined && gateway[i] === short)) {
        return gateway[i + 1]
      }
    }
    return undefined
  }
  const port = parsePort(named('--port', '-p') ?? takeOption(own, '--port') ?? env.WORKERDECK_PORT ?? '8787')
  const label = serviceLabel(port)
  const plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const rawStateDir = named('--state-dir') ?? takeOption(own, '--state-dir') ?? installedStateDir(plist) ?? env.WORKERDECK_STATE_DIR
  const stateDir = rawStateDir ? resolve(rawStateDir) : join(home, '.workerdeck')
  return { port, stateDir, label, plist }
}

function installedStateDir(plist: string): string | undefined {
  try {
    const match = /<string>--state-dir<\/string>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, 'utf8'))
    return match?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  } catch {
    return undefined
  }
}

async function readKey(stateDir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.WORKERDECK_AUTH_KEY) {
    return env.WORKERDECK_AUTH_KEY
  }
  try {
    return (await readFile(join(stateDir, 'auth-key'), 'utf8')).split('\n', 1)[0]!.trim() || undefined
  } catch {
    return undefined
  }
}

async function answers(port: number, http: typeof fetch): Promise<boolean> {
  try {
    const res = await http(`http://127.0.0.1:${port}/auth/status`, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

function bindFails(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'EADDRINUSE'))
    server.listen({ port, host }, () => server.close(() => done(false)))
  })
}

// A gateway may bind one address only (the tailnet IP), which a probe of 127.0.0.1 never reaches. A specific address
// held elsewhere still lets a wildcard bind succeed under SO_REUSEADDR, so every local address is tried on its own.
export async function portTaken(port: number): Promise<boolean> {
  const hosts = new Set(['0.0.0.0', '::'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!(entry.family === 'IPv6' && entry.scopeid)) {
        hosts.add(entry.address)
      }
    }
  }
  const results = await Promise.all([...hosts].map((host) => bindFails(port, host)))
  return results.some(Boolean)
}

export async function runService(argv: string[], deps: ServiceDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`))
  const err = deps.err ?? ((text: string) => process.stderr.write(`[workerdeck] ${text}\n`))
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    out(HELP)
    return command === undefined ? 1 : 0
  }
  try {
    if ((deps.platform ?? process.platform) !== 'darwin') {
      throw new ServiceError('workerdeck service runs on macOS only for now; on Linux, use a systemd user unit (docs: Run an instance)')
    }
    const split = rest.indexOf('--')
    const own = split < 0 ? [...rest] : rest.slice(0, split)
    const gateway = split < 0 ? [] : rest.slice(split + 1)
    const env = deps.env ?? process.env
    const home = deps.home ?? homedir()
    const force = takeSwitch(own, '--force')
    const target = targetOf(own, gateway, env, home)
    if (own.length > 0) {
      throw new ServiceError(`unknown option: ${own[0]} (gateway flags go after --)`)
    }
    const ctx: Ctx = {
      target,
      env,
      force,
      exec: deps.exec ?? run,
      http: deps.fetch ?? fetch,
      portTaken: deps.portTaken ?? portTaken,
      domain: `gui/${deps.uid ?? process.getuid?.() ?? 501}`,
      guard: deps.guard ?? runGuard,
      out,
      startTimeoutMs: deps.startTimeoutMs ?? 20_000,
    }
    const commands: Record<string, () => Promise<number>> = {
      install: () => install(ctx, gateway, deps.self ?? selfCommand()),
      uninstall: () => uninstall(ctx),
      start: () => start(ctx),
      stop: () => stop(ctx),
      restart: () => restart(ctx),
      status: () => status(ctx),
    }
    const handler = commands[command]
    if (!handler) {
      throw new ServiceError(`unknown service command: ${command}`)
    }
    return await handler()
  } catch (error) {
    if (error instanceof ServiceError) {
      err(error.message)
      return 1
    }
    throw error
  }
}

type Ctx = {
  target: ServiceTarget
  env: NodeJS.ProcessEnv
  force: boolean
  exec: (command: string, args: string[]) => Promise<ExecResult>
  http: typeof fetch
  portTaken: (port: number) => Promise<boolean>
  domain: string
  guard: (argv: string[]) => Promise<number>
  out: (text: string) => void
  startTimeoutMs: number
}

function selfCommand(): { node: string; execArgv: string[]; script: string } {
  const script = process.argv[1]
  if (!script) {
    throw new ServiceError('cannot tell which workerdeck to run')
  }
  return { node: process.execPath, execArgv: process.execArgv, script: realpathSync(script) }
}


async function loaded(ctx: Ctx): Promise<{ loaded: boolean; pid?: number; lastExit?: string }> {
  const result = await ctx.exec('launchctl', ['print', `${ctx.domain}/${ctx.target.label}`])
  if (result.code !== 0) {
    return { loaded: false }
  }
  const pid = /^\s*pid = (\d+)/m.exec(result.stdout)?.[1]
  const lastExit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1]
  return { loaded: true, ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit } : {}) }
}

async function waitAnswering(ctx: Ctx): Promise<boolean> {
  const deadline = Date.now() + ctx.startTimeoutMs
  while (Date.now() < deadline) {
    if (await answers(ctx.target.port, ctx.http)) {
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// Same rule as a hand restart: never end a turn in flight without being told to.
async function guarded(ctx: Ctx): Promise<void> {
  if (ctx.force || !(await answers(ctx.target.port, ctx.http))) {
    return
  }
  const key = await readKey(ctx.target.stateDir, ctx.env)
  const verdict = await ctx.guard(['--url', `http://127.0.0.1:${ctx.target.port}/v1`, ...(key ? ['--token', key] : [])])
  if (verdict === 1) {
    throw new ServiceError('a turn is running; wait for it or pass --force')
  }
  if (verdict !== 0) {
    throw new ServiceError('could not tell whether a turn is running; pass --force to go ahead anyway')
  }
}

async function install(ctx: Ctx, gateway: string[], self: { node: string; execArgv: string[]; script: string }): Promise<number> {
  const { target } = ctx
  if (ephemeral(self.script) || ephemeral(self.node)) {
    throw new ServiceError('this workerdeck runs from a temporary path (npx or a per-shell node); install it first: npm install -g workerdeck')
  }
  if (existsSync(target.plist) || (await loaded(ctx)).loaded) {
    throw new ServiceError(`already installed (${target.label}); run workerdeck service uninstall first to change it`)
  }
  if ((await answers(target.port, ctx.http)) || (await ctx.portTaken(target.port))) {
    throw new ServiceError(`port ${target.port} is already in use (a gateway on any address counts); stop it first, then install`)
  }
  try {
    parseArgs(gateway)
  } catch (error) {
    throw new ServiceError(`the gateway would not start with these flags: ${(error as Error).message}`)
  }
  const flags = [...gateway]
  if (!flags.includes('--port') && !flags.includes('-p')) {
    flags.push('--port', String(target.port))
  }
  if (!flags.includes('--state-dir')) {
    flags.push('--state-dir', target.stateDir)
  }
  await mkdir(join(target.stateDir, 'logs'), { recursive: true })
  await mkdir(dirname(target.plist), { recursive: true })
  await writeFile(
    target.plist,
    renderPlist({
      label: target.label,
      programArguments: [self.node, ...self.execArgv, self.script, ...flags],
      path: servicePath(self.node, ctx.env.PATH),
      stateDir: target.stateDir,
      workingDirectory: dirname(self.script),
    }),
  )
  const boot = await ctx.exec('launchctl', ['bootstrap', ctx.domain, target.plist])
  if (boot.code !== 0) {
    await rm(target.plist, { force: true })
    throw new ServiceError(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}`)
  }
  if (!(await waitAnswering(ctx))) {
    ctx.out(`installed ${target.label}, but nothing answers on port ${target.port} yet; see ${join(target.stateDir, 'logs', 'gateway.log')}`)
    return 1
  }
  ctx.out(`installed ${target.label}: the gateway runs on port ${target.port} and starts at every login`)
  ctx.out(`log: ${join(target.stateDir, 'logs', 'gateway.log')}`)
  return 0
}

async function uninstall(ctx: Ctx): Promise<number> {
  const { target } = ctx
  const state = await loaded(ctx)
  if (!state.loaded && !existsSync(target.plist)) {
    ctx.out(`nothing to remove: ${target.label} is not installed`)
    return 0
  }
  if (state.loaded) {
    await guarded(ctx)
    await ctx.exec('launchctl', ['bootout', `${ctx.domain}/${target.label}`])
  }
  await rm(target.plist, { force: true })
  ctx.out(`removed ${target.label}; the gateway is stopped and will not start at login`)
  return 0
}

async function start(ctx: Ctx): Promise<number> {
  const { target } = ctx
  if (!existsSync(target.plist)) {
    throw new ServiceError(`${target.label} is not installed; run workerdeck service install`)
  }
  if (!(await loaded(ctx)).loaded) {
    const boot = await ctx.exec('launchctl', ['bootstrap', ctx.domain, target.plist])
    if (boot.code !== 0) {
      throw new ServiceError(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}`)
    }
  }
  if (!(await waitAnswering(ctx))) {
    throw new ServiceError(`nothing answers on port ${target.port}; see ${join(target.stateDir, 'logs', 'gateway.log')}`)
  }
  ctx.out(`started ${target.label} on port ${target.port}`)
  return 0
}

async function stop(ctx: Ctx): Promise<number> {
  const { target } = ctx
  if (!(await loaded(ctx)).loaded) {
    ctx.out(`${target.label} is not running`)
    return 0
  }
  await guarded(ctx)
  await ctx.exec('launchctl', ['bootout', `${ctx.domain}/${target.label}`])
  ctx.out(`stopped ${target.label}; it starts again at the next login or with workerdeck service start`)
  return 0
}

async function restart(ctx: Ctx): Promise<number> {
  const { target } = ctx
  if (!(await loaded(ctx)).loaded) {
    return await start(ctx)
  }
  await guarded(ctx)
  const kick = await ctx.exec('launchctl', ['kickstart', '-k', `${ctx.domain}/${target.label}`])
  if (kick.code !== 0) {
    throw new ServiceError(`launchctl kickstart failed: ${kick.stderr.trim() || `exit ${kick.code}`}`)
  }
  if (!(await waitAnswering(ctx))) {
    throw new ServiceError(`nothing answers on port ${target.port} after the restart; see ${join(target.stateDir, 'logs', 'gateway.log')}`)
  }
  ctx.out(`restarted ${target.label}`)
  return 0
}

async function status(ctx: Ctx): Promise<number> {
  const { target } = ctx
  const installed = existsSync(target.plist)
  const state = await loaded(ctx)
  ctx.out(`agent: ${target.label} ${installed ? `installed (${target.plist})` : 'not installed'}`)
  ctx.out(
    state.loaded
      ? `launchd: loaded${state.pid ? `, pid ${state.pid}` : ', not running'}${state.lastExit ? `, last exit ${state.lastExit}` : ''}`
      : 'launchd: not loaded',
  )
  ctx.out(`gateway: ${(await answers(target.port, ctx.http)) ? 'answers' : 'nothing answers'} on port ${target.port}`)
  return 0
}
