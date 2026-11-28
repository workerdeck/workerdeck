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
import { gatewayArgv } from './argv.ts'
import { serviceArgvCurrent, serviceCommand, serviceInstallCommand, serviceLogPath, serviceOwned, servicePlistPath } from './service.ts'
import { bindsPublicly, HOST_SECTION, keyRequired, managedUrl, readHostSettings, settingsProblem, type HostSettings } from './settings.ts'

export const MANAGED_HOST_ID = 'workerdeck-managed'

export const SERVICE_CONTEXT_KEY = 'workerdeck.host.service'

const READY_INTERVAL_MS = 400
const DRAIN_GRACE_MS = 30_000
const HARD_GRACE_MS = 5_000

export type HostState =
  | { kind: 'disabled' }
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'running'; url: string; owned: boolean; service: boolean; pid: number | undefined }
  | { kind: 'stopping' }
  | { kind: 'error'; message: string }

export type CliResult = { code: number; stdout: string; stderr: string }

export function cliError(result: CliResult): string {
  const text = (result.stderr || result.stdout).trim()
  return text.replace(/^\[workerdeck\] /gm, '') || `the workerdeck CLI exited with code ${result.code}`
}

export type SupervisorDeps = {
  sessionsOf: (hostId: string) => SessionInfo[]
  refresh: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HostSupervisor implements vscode.Disposable {
  readonly #store: HostStore
  readonly #deps: SupervisorDeps
  readonly #onDidChangeState = new vscode.EventEmitter<HostState>()
  readonly onDidChangeState = this.#onDidChangeState.event

  readonly #log = new LogTail()
  readonly #version: string
  #state: HostState = { kind: 'disabled' }
  #restartOffered = false
  // Set while a command changes a setting and restarts by itself, so the generic offer stays quiet.
  #switchingSettings = false
  #child: ChildProcess | undefined
  #childViaNpx = false
  #busy: Promise<void> = Promise.resolve()

  constructor(context: vscode.ExtensionContext, store: HostStore, deps: SupervisorDeps) {
    this.#store = store
    this.#deps = deps
    this.#version = (context.extension.packageJSON as { version?: string }).version ?? 'latest'
  }

  get state(): HostState {
    return this.#state
  }

  #set(state: HostState): void {
    this.#state = state
    void vscode.commands.executeCommand('setContext', SERVICE_CONTEXT_KEY, serviceOwned(readHostSettings().port))
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
      if (adopted || !settings.autoStart || serviceOwned(settings.port)) {
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
      if (serviceOwned(settings.port)) {
        await this.#serviceStart(settings)
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
    if (
      state.kind !== 'running' ||
      !(state.owned || state.service) ||
      !vscode.window.state.focused ||
      this.#restartOffered ||
      this.#switchingSettings
    ) {
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
      if (serviceOwned(settings.port)) {
        return await this.#serviceRestart(settings)
      }
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
    this.#switchingSettings = true
    try {
      await config.update('remote', remote, vscode.ConfigurationTarget.Global)
      if (await this.restart()) {
        return true
      }
      await config.update('remote', previous, vscode.ConfigurationTarget.Global)
      return false
    } finally {
      this.#switchingSettings = false
    }
  }

  // MESH.md 5.2: the gateway becomes a LaunchAgent (`workerdeck service`), so it outlives VS Code and holds idle sleep off.
  async keepAvailable(): Promise<void> {
    const settings = readHostSettings()
    if (process.platform !== 'darwin') {
      void vscode.window.showWarningMessage(
        'WorkerDeck: keeping this computer available runs the server as a macOS login item; it is macOS only for now.',
      )
      return
    }
    if (!settings.enabled) {
      void vscode.window.showInformationMessage(
        'WorkerDeck: turn Host Mode on first; the login item runs the server Host Mode is set up for.',
      )
      return
    }
    if (serviceOwned(settings.port)) {
      void vscode.window.showInformationMessage(`WorkerDeck: the server on port ${settings.port} already runs as a login item.`)
      return
    }
    if (this.#refuseService(settings)) {
      return
    }
    const answer = await vscode.window.showInformationMessage(
      'WorkerDeck: Keep this computer available?',
      {
        modal: true,
        detail:
          'The server moves out of VS Code into a login item: it starts when you log in, keeps running with VS Code closed and ' +
          'restarts if it crashes. It holds idle sleep off for as long as it runs (`workerdeck.host.keepAwake` becomes `always`).',
      },
      'Keep Available',
    )
    if (answer !== 'Keep Available') {
      return
    }
    const config = vscode.workspace.getConfiguration(HOST_SECTION)
    const previous = config.get<string>('keepAwake', 'work')
    this.#switchingSettings = true
    try {
      await config.update('keepAwake', 'always', vscode.ConfigurationTarget.Global)
      if (await this.#queue(() => this.#handOver(readHostSettings()))) {
        return
      }
      await config.update('keepAwake', previous, vscode.ConfigurationTarget.Global)
    } finally {
      this.#switchingSettings = false
    }
    await this.sync()
  }

  async stopKeepingAvailable(): Promise<void> {
    const settings = readHostSettings()
    if (!serviceOwned(settings.port)) {
      void vscode.window.showInformationMessage(`WorkerDeck: no login item runs the server on port ${settings.port}.`)
      return
    }
    const removed = await this.#queue(async () => {
      if (!(await this.#confirmBusy('Stop'))) {
        return false
      }
      this.#set({ kind: 'stopping' })
      const result = await this.#serviceCli('WorkerDeck: removing the login item…', serviceCommand('uninstall'))
      if (result.code !== 0) {
        void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(result)}`)
        await this.#readopt(settings)
        return false
      }
      await this.#unregister()
      this.#set({ kind: 'stopped' })
      void this.#deps.refresh()
      return true
    })
    if (!removed) {
      return
    }
    const config = vscode.workspace.getConfiguration(HOST_SECTION)
    if (config.get<string>('keepAwake', 'work') === 'always') {
      this.#switchingSettings = true
      try {
        await config.update('keepAwake', 'work', vscode.ConfigurationTarget.Global)
      } finally {
        this.#switchingSettings = false
      }
    }
    await this.sync()
  }

  async #handOver(settings: HostSettings): Promise<boolean> {
    if (!(await this.#stopNow(settings, true, 'Stop'))) {
      return false
    }
    this.#set({ kind: 'starting' })
    if (!(await this.#installService(settings))) {
      this.#set({ kind: 'stopped' })
      return false
    }
    await this.#readopt(settings)
    return true
  }

  // A service child gets no WORKERDECK_AUTH_KEY, and the key never goes on argv, so the gateway reads
  // <state-dir>/auth-key. It only does that in remote mode or on a public bind; `requireAuthKey` alone needs the env.
  #refuseService(settings: HostSettings): boolean {
    const problem = settingsProblem(settings)
    if (problem) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${problem}`)
      return true
    }
    if (settings.requireAuthKey && !settings.remote && !bindsPublicly(settings)) {
      void vscode.window.showErrorMessage(
        'WorkerDeck: a login item cannot carry the key `workerdeck.host.requireAuthKey` asks for on loopback. ' +
          'Turn on Remote Access (which always requires the key) or turn `workerdeck.host.requireAuthKey` off first.',
      )
      return true
    }
    const launch = resolveLaunch({
      binaryPath: settings.binaryPath,
      npxSpec: settings.npxSpec ?? `workerdeck@${this.#version}`,
      allowNpx: settings.useNpx,
    })
    if ('error' in launch) {
      void this.#offerInstall(launch.error)
      return true
    }
    if (launch.viaNpx) {
      void this.#offerInstall(
        'a login item needs an installed workerdeck, not one npx fetches: run `npm install -g workerdeck` or set `workerdeck.host.binaryPath`',
      )
      return true
    }
    return false
  }

  async #installService(settings: HostSettings): Promise<boolean> {
    try {
      await this.#resolveAuthKey(settings)
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${errorMessage(err)}`)
      return false
    }
    const result = await this.#serviceCli(
      'WorkerDeck: installing the server as a login item…',
      serviceInstallCommand(gatewayArgv(settings)),
    )
    if (result.code === 0) {
      return true
    }
    const installed = serviceOwned(settings.port)
    void (installed ? vscode.window.showWarningMessage : vscode.window.showErrorMessage)(`WorkerDeck: ${cliError(result)}`)
    return installed
  }

  async #serviceStart(settings: HostSettings): Promise<void> {
    this.#set({ kind: 'starting' })
    const result = await this.#serviceCli('WorkerDeck: starting the login item…', serviceCommand('start'))
    if (result.code !== 0) {
      this.#set({ kind: 'error', message: cliError(result) })
      void this.#reportFailure()
      return
    }
    await this.#readopt(settings)
  }

  async #serviceStop(settings: HostSettings, confirm: boolean, verb: 'Stop' | 'Restart'): Promise<boolean> {
    if (confirm && !(await this.#confirmBusy(verb))) {
      return false
    }
    this.#set({ kind: 'stopping' })
    const result = await this.#serviceCli('WorkerDeck: stopping the server…', serviceCommand('stop'))
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(result)}`)
      await this.#readopt(settings)
      return false
    }
    await this.#unregister()
    this.#set({ kind: 'stopped' })
    void this.#deps.refresh()
    return true
  }

  async #serviceRestart(settings: HostSettings): Promise<boolean> {
    const argv = gatewayArgv(settings)
    const plist = await readFile(servicePlistPath(settings.port), 'utf8').catch(() => '')
    const current = serviceArgvCurrent(plist, argv)
    if (!current && this.#refuseService(settings)) {
      return false
    }
    if (!(await this.#confirmBusy('Restart'))) {
      return false
    }
    this.#set({ kind: 'starting' })
    if (current) {
      const result = await this.#serviceCli('WorkerDeck: restarting the server…', serviceCommand('restart'))
      if (result.code !== 0) {
        void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(result)}`)
      }
    } else {
      const removed = await this.#serviceCli('WorkerDeck: reinstalling the login item with the new settings…', serviceCommand('uninstall'))
      if (removed.code !== 0) {
        void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(removed)}`)
        await this.#readopt(settings)
        return false
      }
      if (!(await this.#installService(settings))) {
        await this.#launch(settings)
        return false
      }
    }
    await this.#readopt(settings)
    return this.#state.kind === 'running'
  }

  async #readopt(settings: HostSettings): Promise<void> {
    if (!(await this.#adopt(settings))) {
      await this.#unregister()
      this.#set({ kind: 'stopped' })
    }
  }

  async #serviceCli(title: string, args: string[]): Promise<CliResult> {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, () =>
      this.runCli(args),
    )
  }

  async #confirmBusy(verb: 'Stop' | 'Restart'): Promise<boolean> {
    return await confirmDisruption(verb, summarizeBusy(this.#deps.sessionsOf(MANAGED_HOST_ID)))
  }

  #logPath(settings: HostSettings): string {
    return serviceOwned(settings.port) ? serviceLogPath(settings.stateDir) : logPath(settings.stateDir)
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
    await this.#log.follow(this.#logPath(readHostSettings()))
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
    void this.#log.follow(this.#logPath(settings))
    const service = serviceOwned(settings.port)
    const lock = service ? undefined : await ownedLock(settings.stateDir)
    const owned = lock?.port === settings.port
    this.#set({ kind: 'running', url, owned, service, pid: owned ? lock?.pid : undefined })
    void this.#deps.refresh()
    return true
  }

  async #currentKey(settings: HostSettings): Promise<string | undefined> {
    if (!keyRequired(settings)) {
      return undefined
    }
    return await readStateKey(settings.stateDir)
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
      const args = [...launch.args, ...gatewayArgv(settings)]
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
        this.#set({ kind: 'running', url, owned: this.#child === child, service: false, pid: child.pid })
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
    if (serviceOwned(settings.port)) {
      return await this.#serviceStop(settings, confirm, verb)
    }
    const lock = await ownedLock(settings.stateDir)
    const pid = this.#child?.pid ?? (lock?.port === settings.port ? lock.pid : undefined)
    const group = this.#child ? this.#childViaNpx : lock?.group === true
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
    if (confirm && !(await this.#confirmBusy(verb))) {
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

  // The key never reaches argv: `ps` is world-readable on every platform this runs on. The file is kept when the key
  // is turned off, so turning it back on does not unpair every device.
  async #resolveAuthKey(settings: HostSettings): Promise<string | undefined> {
    if (!keyRequired(settings)) {
      return undefined
    }
    const stored = await readStateKey(settings.stateDir)
    const key = stored ?? generateKey()
    if (key !== stored) {
      await writeStateKey(settings.stateDir, key)
    }
    return key
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
