import { errorMessage } from '@workerdeck/protocol'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { SessionInfo } from '@workerdeck/protocol'
import { clientForUrl, probe } from '../gateway.ts'
import type { HostStore } from '../hosts.ts'
import { confirmDisruption, summarizeBusy } from './busy.ts'
import { clearLock, logPath, ownedLock, pidAlive, writeLock } from './lock.ts'
import { LogTail } from './log-tail.ts'
import { generateKey, readStateKey, writeStateKey } from './key-store.ts'
import { resolveLaunch, type LaunchSpec } from './runtime.ts'
import {
  AGENT_SLEEP_AFTER_MINUTES,
  bindsPublicly,
  keyRequired,
  managedUrl,
  readHostSettings,
  settingsProblem,
  type HostSettings,
} from './settings.ts'

export const MANAGED_HOST_ID = 'workerdeck-managed'

// Before 4.8 the key lived here; `#resolveAuthKey` moves it into `<state-dir>/auth-key` once.
const AUTH_KEY_SECRET = 'workerdeck.host.managedAuthKey'
const READY_INTERVAL_MS = 400
const DRAIN_GRACE_MS = 30_000
const HARD_GRACE_MS = 5_000

export type HostState =
  | { kind: 'disabled' }
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'running'; url: string; owned: boolean; pid: number | undefined }
  | { kind: 'stopping' }
  | { kind: 'error'; message: string }

export type CliResult = { code: number; stdout: string; stderr: string }

export type SupervisorDeps = {
  sessionsOf: (hostId: string) => SessionInfo[]
  refresh: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HostSupervisor implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext
  readonly #store: HostStore
  readonly #deps: SupervisorDeps
  readonly #onDidChangeState = new vscode.EventEmitter<HostState>()
  readonly onDidChangeState = this.#onDidChangeState.event

  readonly #log = new LogTail()
  readonly #version: string
  #state: HostState = { kind: 'disabled' }
  #restartOffered = false
  // Set while Enable/Disable Remote Access changes the setting and restarts itself, so the generic offer stays quiet.
  #switchingRemote = false
  #child: ChildProcess | undefined
  #childViaNpx = false
  #busy: Promise<void> = Promise.resolve()

  constructor(context: vscode.ExtensionContext, store: HostStore, deps: SupervisorDeps) {
    this.#context = context
    this.#store = store
    this.#deps = deps
    this.#version = (context.extension.packageJSON as { version?: string }).version ?? 'latest'
  }

  get state(): HostState {
    return this.#state
  }

  #set(state: HostState): void {
    this.#state = state
    this.#onDidChangeState.fire(state)
  }

  // Every transition is serialized: a config change landing mid-start must not race the start it triggered.
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(work, work)
    this.#busy = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  sync(): Promise<void> {
    return this.#queue(async () => {
      const settings = readHostSettings()
      if (!settings.enabled) {
        await this.#unregister()
        this.#set({ kind: 'disabled' })
        return
      }
      const problem = settingsProblem(settings)
      if (problem) {
        this.#set({ kind: 'error', message: problem })
        return
      }
      const adopted = await this.#adopt(settings)
      if (adopted || !settings.autoStart) {
        if (!adopted && this.#state.kind !== 'error') {
          this.#set({ kind: 'stopped' })
        }
        return
      }
      await this.#launch(settings)
    })
  }

  start(): Promise<void> {
    return this.#queue(async () => {
      const settings = readHostSettings()
      if (!settings.enabled) {
        const answer = await vscode.window.showInformationMessage(
          'WorkerDeck: Host Mode is off. Turn it on to run a server on this machine.',
          'Enable Host Mode',
        )
        if (answer === 'Enable Host Mode') {
          await vscode.workspace.getConfiguration('workerdeck.host').update('enabled', true, vscode.ConfigurationTarget.Global)
        }
        return
      }
      const problem = settingsProblem(settings)
      if (problem) {
        this.#set({ kind: 'error', message: problem })
        void vscode.window.showErrorMessage(`WorkerDeck: ${problem}`)
        return
      }
      if (await this.#adopt(settings)) {
        return
      }
      await this.#launch(settings)
    })
  }

  stop(options: { confirm?: boolean } = {}): Promise<void> {
    return this.#queue(async () => {
      await this.#stopNow(readHostSettings(), options.confirm ?? true, 'Stop')
    })
  }

  // Only the focused window asks, and only about a server VS Code launched: every window sees the same settings
  // change, and a server started by hand in a terminal never read these settings at all.
  offerRestart(): void {
    const state = this.#state
    if (state.kind !== 'running' || !state.owned || !vscode.window.state.focused || this.#restartOffered || this.#switchingRemote) {
      return
    }
    this.#restartOffered = true
    void vscode.window
      .showInformationMessage('WorkerDeck: the server picks up the changed Host Mode settings on its next start.', 'Restart Now')
      .then((answer) => {
        this.#restartOffered = false
        if (answer === 'Restart Now') {
          void this.restart()
        }
      })
  }

  restart(): Promise<boolean> {
    return this.#queue(async () => {
      const settings = readHostSettings()
      if (!(await this.#stopNow(settings, true, 'Restart'))) {
        return false
      }
      await this.#launch(settings)
      return true
    })
  }

  // Runs the same CLI the server is launched with, so the remote and pairing logic exists once, in `workerdeck`.
  async runCli(args: string[]): Promise<CliResult> {
    const settings = readHostSettings()
    const launch = resolveLaunch({
      binaryPath: settings.binaryPath,
      npxSpec: settings.npxSpec ?? `workerdeck@${this.#version}`,
      allowNpx: settings.useNpx,
    })
    if ('error' in launch) {
      return { code: 127, stdout: '', stderr: launch.error }
    }
    const full = [...launch.args, ...args, '--port', String(settings.port), '--state-dir', settings.stateDir]
    return await new Promise((resolve) => {
      execFile(launch.command, full, { timeout: launch.readyTimeoutMs + 60_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }

  // Changes `workerdeck.host.remote` and restarts through the busy confirmation; a declined restart puts it back.
  async switchRemote(remote: boolean): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('workerdeck.host')
    const previous = config.get<boolean>('remote', false)
    if (previous === remote && this.#state.kind === 'running') {
      return true
    }
    this.#switchingRemote = true
    try {
      await config.update('remote', remote, vscode.ConfigurationTarget.Global)
      if (await this.restart()) {
        return true
      }
      await config.update('remote', previous, vscode.ConfigurationTarget.Global)
      return false
    } finally {
      this.#switchingRemote = false
    }
  }

  // Addressed through <state-dir>/gateway.pid rather than the ownership lock: only a gateway started with
  // --hot-reload writes that file, so its presence IS the capability, and a server started by hand in a terminal
  // reloads from here exactly like one VS Code launched. The pid, never the group: the swap happens inside the
  // gateway process, and -pid would reach the npx launcher and every engine child with it.
  async hotReload(): Promise<void> {
    const settings = readHostSettings()
    if (process.platform === 'win32') {
      void vscode.window.showWarningMessage('WorkerDeck: hot reload needs POSIX signals, which Windows does not have.')
      return
    }
    let pid: number
    try {
      pid = Number.parseInt(await readFile(join(settings.stateDir, 'gateway.pid'), 'utf8'), 10)
    } catch {
      void vscode.window.showWarningMessage(
        'WorkerDeck: this gateway was not started with --hot-reload, so there is nothing to reload in place. ' +
          'Turn on workerdeck.host.hotReload (source checkouts only) or use Restart Server.',
      )
      return
    }
    try {
      process.kill(pid, 'SIGUSR2')
    } catch {
      void vscode.window.showWarningMessage(`WorkerDeck: no process ${pid} to reload - the pidfile is stale.`)
      return
    }
    void vscode.window.setStatusBarMessage('$(sync) WorkerDeck: gateway reloaded', 2000)
  }

  async openDashboard(): Promise<void> {
    const state = this.#state
    if (state.kind !== 'running') {
      void vscode.window.showInformationMessage('WorkerDeck: the server is not running.')
      return
    }
    await vscode.env.openExternal(vscode.Uri.parse(state.url))
  }

  async copyAuthKey(): Promise<void> {
    const key = await this.#currentKey(readHostSettings())
    if (!key) {
      void vscode.window.showInformationMessage('WorkerDeck: this server has no auth key.')
      return
    }
    await vscode.env.clipboard.writeText(key)
    void vscode.window.setStatusBarMessage('$(key) WorkerDeck: auth key copied', 2000)
  }

  async showLog(): Promise<void> {
    await this.#log.follow(logPath(readHostSettings().stateDir))
    this.#log.show()
  }

  async #adopt(settings: HostSettings): Promise<boolean> {
    const url = managedUrl(settings)
    const result = await this.#probeUrl(url)
    if (result === 'unreachable') {
      return false
    }
    if (result === 'unauthorized') {
      const message = `something else is serving ${url} with a different auth key - change \`workerdeck.host.port\` or stop it first.`
      this.#set({ kind: 'error', message })
      return true
    }
    await this.#register(url, settings.name)
    void this.#log.follow(logPath(settings.stateDir))
    const lock = await ownedLock(settings.stateDir)
    const owned = lock?.port === settings.port
    this.#set({ kind: 'running', url, owned, pid: owned ? lock?.pid : undefined })
    void this.#deps.refresh()
    return true
  }

  async #currentKey(settings: HostSettings): Promise<string | undefined> {
    if (!keyRequired(settings)) {
      return undefined
    }
    return (await readStateKey(settings.stateDir)) ?? (await this.#context.secrets.get(AUTH_KEY_SECRET))
  }

  async #probeUrl(url: string): Promise<'connected' | 'unauthorized' | 'unreachable'> {
    const key = await this.#currentKey(readHostSettings())
    const client = clientForUrl(url, key ? { authorization: `Bearer ${key}` } : {})
    return client ? probe(client) : 'unreachable'
  }

  async #launch(settings: HostSettings): Promise<void> {
    const launch = resolveLaunch({
      binaryPath: settings.binaryPath,
      npxSpec: settings.npxSpec ?? `workerdeck@${this.#version}`,
      allowNpx: settings.useNpx,
    })
    if ('error' in launch) {
      this.#set({ kind: 'error', message: launch.error })
      void this.#offerInstall(launch.error)
      return
    }

    this.#set({ kind: 'starting' })
    void this.#log.follow(logPath(settings.stateDir))
    const url = managedUrl(settings)
    let authKey: string | undefined
    try {
      authKey = await this.#resolveAuthKey(settings)
      const args = [...launch.args, ...this.#argv(settings)]
      await mkdir(settings.stateDir, { recursive: true })
      const log = await open(logPath(settings.stateDir), 'a')
      try {
        // The log file, not a pipe: the server must outlive this window, and a child writing to the
        // closed pipe of a dead extension host dies with EPIPE.
        this.#childViaNpx = launch.viaNpx
        this.#child = spawn(launch.command, args, {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, ...(authKey ? { WORKERDECK_AUTH_KEY: authKey } : {}) },
        })
      } finally {
        await log.close()
      }
    } catch (err) {
      this.#set({ kind: 'error', message: errorMessage(err) })
      return
    }

    const child = this.#child
    if (launch.viaNpx) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'WorkerDeck: fetching and starting the server…', cancellable: false },
        () => this.#awaitReady(settings, url, child, launch, authKey !== undefined),
      )
      return
    }
    await this.#awaitReady(settings, url, child, launch, authKey !== undefined)
  }

  async #awaitReady(settings: HostSettings, url: string, child: ChildProcess, launch: LaunchSpec, keyed: boolean): Promise<void> {
    let exited: number | null | undefined
    child.once('exit', (code) => {
      exited = code
      if (this.#child === child) {
        this.#child = undefined
      }
    })
    child.once('error', (err) => {
      this.#set({ kind: 'error', message: err.message })
    })
    child.unref()

    const deadline = Date.now() + launch.readyTimeoutMs
    while (Date.now() < deadline) {
      const result = await this.#probeUrl(url)
      if (result === 'connected') {
        // Only a window whose own child won the port writes the lock; the loser of a two-window race adopts.
        if (this.#child === child) {
          await writeLock(settings.stateDir, {
            pid: child.pid ?? 0,
            group: launch.viaNpx,
            port: settings.port,
            bindAddress: settings.bindAddress,
            url,
            startedAt: Date.now(),
          })
        }
        await this.#register(url, settings.name)
        this.#set({ kind: 'running', url, owned: this.#child === child, pid: child.pid })
        void this.#deps.refresh()
        this.#announce(settings, keyed)
        return
      }
      if (result === 'unauthorized') {
        this.#set({ kind: 'error', message: `${url} answered with a different auth key - stop whatever else is on that port.` })
        return
      }
      if (exited !== undefined) {
        // Losing the port race is the expected outcome in a second window, not a failure.
        if (await this.#adopt(settings)) {
          return
        }
        this.#set({ kind: 'error', message: `the server exited with code ${exited ?? 'null'} - see the server log.` })
        void this.#reportFailure()
        return
      }
      await sleep(READY_INTERVAL_MS)
    }
    this.#set({ kind: 'error', message: `the server did not answer on ${url} within ${Math.round(launch.readyTimeoutMs / 1000)}s.` })
    void this.#reportFailure()
  }

  async #stopNow(settings: HostSettings, confirm: boolean, verb: 'Stop' | 'Restart'): Promise<boolean> {
    const lock = await ownedLock(settings.stateDir)
    const pid = this.#child?.pid ?? (lock?.port === settings.port ? lock.pid : undefined)
    const group = this.#child ? this.#childViaNpx : (lock?.group ?? true)
    if (pid === undefined) {
      if (this.#state.kind === 'running') {
        void vscode.window.showWarningMessage(
          'WorkerDeck: this server was not started by VS Code. Stop it where you started it - VS Code will not kill a process it does not own.',
        )
        return false
      }
      await this.#unregister()
      this.#set({ kind: 'stopped' })
      return true
    }
    if (confirm && !(await confirmDisruption(verb, summarizeBusy(this.#deps.sessionsOf(MANAGED_HOST_ID))))) {
      return false
    }

    this.#set({ kind: 'stopping' })
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'WorkerDeck: stopping the server…' }, async () => {
      // SIGTERM drains: the CLI lets turns in flight finish, and a second SIGTERM is its "stop now".
      this.#signal(pid, 'SIGTERM', group)
      if (await this.#waitForExit(pid, DRAIN_GRACE_MS)) {
        return
      }
      this.#signal(pid, 'SIGTERM', group)
      if (await this.#waitForExit(pid, HARD_GRACE_MS)) {
        return
      }
      this.#signal(pid, 'SIGKILL', true)
      await this.#waitForExit(pid, HARD_GRACE_MS)
    })

    this.#child = undefined
    await clearLock(settings.stateDir)
    await this.#unregister()
    this.#set({ kind: 'stopped' })
    void this.#deps.refresh()
    return true
  }

  // `npx` is a launcher: the server is its grandchild, so its whole detached process group is the target. Any other
  // launch is the server itself, and a group signal would kill its engine children mid-drain, before the server
  // closes them itself. SIGKILL always takes the group, so a hard stop orphans nothing.
  #signal(pid: number, signal: NodeJS.Signals, group: boolean): void {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore' }).on('error', () => {})
      return
    }
    if (!group) {
      try {
        process.kill(pid, signal)
      } catch {}
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {}
    }
  }

  async #waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) {
        return true
      }
      await sleep(200)
    }
    return !pidAlive(pid)
  }

  #argv(settings: HostSettings): string[] {
    const args = ['--port', String(settings.port), '--host', settings.bindAddress, '--state-dir', settings.stateDir]
    if (settings.remote) {
      args.push('--remote')
    }
    if (settings.configPath) {
      args.push('--config', settings.configPath)
    }
    if (!settings.dashboard) {
      args.push('--no-web')
    }
    if (settings.shell) {
      args.push('--shell')
      if (settings.shellAgentWrite !== 'read-only') {
        args.push('--shell-agent-write', settings.shellAgentWrite)
      }
    }
    if (settings.hotReload) {
      args.push('--hot-reload')
    }
    for (const root of settings.cwdRoots) {
      args.push('--cwd-root', root)
    }
    if (settings.engineSleepAfterMinutes > 0) {
      args.push('--engine-sleep-after', `${settings.engineSleepAfterMinutes}m`)
    }
    if (settings.agentSleepAfterMinutes !== AGENT_SLEEP_AFTER_MINUTES) {
      args.push('--agent-sleep-after', settings.agentSleepAfterMinutes > 0 ? `${settings.agentSleepAfterMinutes}m` : 'never')
    }
    for (const [model, effort] of Object.entries(settings.effortDefaults)) {
      args.push('--effort-default', `${model}=${effort}`)
    }
    if (settings.agentContextReset !== 'off') {
      args.push('--agent-context-reset', settings.agentContextReset)
    }
    if (settings.agentSharing !== 'private') {
      args.push('--agent-sharing', settings.agentSharing)
    }
    return args
  }

  // The key never reaches argv: `ps` is world-readable on every platform this runs on. The file is kept when the key
  // is turned off, so turning it back on does not unpair every device.
  async #resolveAuthKey(settings: HostSettings): Promise<string | undefined> {
    if (!keyRequired(settings)) {
      return undefined
    }
    const stored = await readStateKey(settings.stateDir)
    const legacy = await this.#context.secrets.get(AUTH_KEY_SECRET)
    let key = stored ?? legacy
    if (stored && legacy && stored !== legacy) {
      key = await this.#chooseKey(settings, stored, legacy)
    }
    if (key === undefined) {
      key = generateKey()
    }
    if (key !== stored) {
      await writeStateKey(settings.stateDir, key)
    }
    if (legacy !== undefined) {
      await this.#context.secrets.delete(AUTH_KEY_SECRET)
    }
    return key
  }

  async #chooseKey(settings: HostSettings, stored: string, legacy: string): Promise<string> {
    const useFile = 'Use the State-Dir Key'
    const useVsCode = 'Use the VS Code Key'
    const answer = await vscode.window.showWarningMessage(
      'WorkerDeck: this server has two different keys.',
      {
        modal: true,
        detail:
          `VS Code kept one in the keychain, and ${settings.stateDir}/auth-key holds another (a server started from a ` +
          'terminal writes it). From now on the server uses one key, kept in that file. Devices and editors paired ' +
          'with the other key have to pair again.',
      },
      useFile,
      useVsCode,
    )
    if (answer === useFile) {
      return stored
    }
    if (answer === useVsCode) {
      return legacy
    }
    throw new Error('no key chosen; the server was not started')
  }

  async #register(url: string, name: string): Promise<void> {
    const existing = this.#store.get(MANAGED_HOST_ID)
    const key = await this.#currentKey(readHostSettings())
    if (existing?.baseUrl === url && existing.name === name && existing.managed && (await this.#store.authKey(MANAGED_HOST_ID)) === key) {
      return
    }
    await this.#store.save({ id: MANAGED_HOST_ID, name, baseUrl: url, managed: true }, key)
  }

  async #unregister(): Promise<void> {
    if (this.#store.get(MANAGED_HOST_ID)) {
      await this.#store.remove(MANAGED_HOST_ID)
    }
  }

  #announce(settings: HostSettings, keyed: boolean): void {
    if (!bindsPublicly(settings)) {
      return
    }
    void vscode.window
      .showWarningMessage(
        `WorkerDeck is serving on ${settings.bindAddress}:${settings.port} - reachable from other machines.${keyed ? ' It is protected by a generated auth key.' : ''}`,
        'Copy Auth Key',
      )
      .then(async (answer) => {
        if (answer === 'Copy Auth Key') {
          await this.copyAuthKey()
        }
      })
  }

  async #offerInstall(message: string): Promise<void> {
    const answer = await vscode.window.showErrorMessage(`WorkerDeck: ${message}.`, 'Install Globally', 'Set Path')
    if (answer === 'Install Globally') {
      const terminal = vscode.window.createTerminal('Install WorkerDeck')
      terminal.show()
      terminal.sendText(`npm install -g workerdeck@${this.#version}`)
    } else if (answer === 'Set Path') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'workerdeck.host.binaryPath')
    }
  }

  async #reportFailure(): Promise<void> {
    const message = this.#state.kind === 'error' ? this.#state.message : 'the server failed to start.'
    this.#log.note(message)
    const answer = await vscode.window.showErrorMessage(`WorkerDeck: ${message}`, 'Show Log')
    if (answer === 'Show Log') {
      await this.showLog()
    }
  }

  dispose(): void {
    this.#log.dispose()
    this.#onDidChangeState.dispose()
  }
}
