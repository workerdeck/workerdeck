import { randomUUID } from 'node:crypto'
import { resolveBundledClaudeExecutable, resolveBundledCodexExecutable } from '@workerdeck/core'
import { accountExpiry, type AccountExpiry, type ConnectAccountResponse, type ProfileAccount, type ProfileInfo } from '@workerdeck/protocol'
import { CodexLoginError, codexLogout, startCodexDeviceLogin, type CodexDeviceLogin } from '../accounts/codex-device.ts'
import { SetupTokenError, startClaudeSetupToken, type SetupTokenAttempt } from '../accounts/setup-token.ts'
import { deleteAccount, readAccount, writeAccount } from '../accounts/token-store.ts'
import type { EngineAvailability } from '@workerdeck/core'
import type { Refusal } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { AuthContext } from './auth.ts'
import type { ProfileService } from './profiles.ts'
import { loadPty } from './shell-env.ts'
import type { PtyModule } from './shell-types.ts'

const ATTEMPT_TTL_MS = 10 * 60 * 1000
const CODEX_ATTEMPT_TTL_MS = 15 * 60 * 1000
const CODEX_WAIT_MS = 25_000
const EXPIRY_CHECK_MS = 12 * 60 * 60 * 1000

export type AccountOptions = {
  // Widens who may connect a profile beyond `canManageProfiles`, e.g. the profile's own user in a multi-user host.
  canConnect?: (principal: unknown, profile: ProfileInfo) => boolean | Promise<boolean>
  claudeExecutable?: string
  codexExecutable?: string
  pty?: PtyModule
  attemptTtlMs?: number
  // How long one code-less complete waits on a codex device login before answering `pending`.
  codexWaitMs?: number
}

type Attempt = { id: string; timer: NodeJS.Timeout; busy: boolean } & (
  | { engine: 'claude'; flow: SetupTokenAttempt }
  | { engine: 'codex'; flow: CodexDeviceLogin }
)

type Outcome<T> = ({ ok: true } & T) | ({ ok: false } & Refusal)

export type AccountServiceDeps = {
  options: AccountOptions | undefined
  requireApiKey?: boolean
  profiles: ProfileService
  // The profile's own session env without any account token, so the CLI signs in against the profile's config dir.
  baseEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
  onChange: (profile: ProfileInfo) => void | Promise<void>
}

export class AccountService {
  readonly #deps: AccountServiceDeps
  readonly #attempts = new Map<string, Attempt>()
  readonly #expiryWarned = new Map<string, AccountExpiry>()
  #expiryTimer: NodeJS.Timeout | undefined

  constructor(deps: AccountServiceDeps) {
    this.#deps = deps
  }

  status(profile: ProfileInfo): ProfileAccount | undefined {
    if (engineOf(profile) !== 'claude' || !profile.configDir) {
      return undefined
    }
    try {
      return readAccount(profile.configDir)
    } catch {
      return undefined
    }
  }

  async guard(auth: AuthContext, profile: ProfileInfo): Promise<Refusal | null> {
    const { profiles, options } = this.#deps
    const engine = engineOf(profile)
    if (engine !== 'claude' && engine !== 'codex') {
      return { status: 400, error: `profile '${profile.name}' is not a Claude or Codex profile` }
    }
    if (engine === 'codex' && !profile.codexHome) {
      return { status: 400, error: `profile '${profile.name}' has no codexHome of its own to sign in to` }
    }
    const refused = profiles.declaredGuard(profile) ?? profiles.configDirGuard(profile)
    if (refused) {
      return refused
    }
    if (auth.canManageProfiles || (options?.canConnect && (await options.canConnect(auth.principal, profile)) === true)) {
      return null
    }
    return { status: 403, error: `not allowed to connect an account to profile '${profile.name}'` }
  }

  async connect(profile: ProfileInfo): Promise<Outcome<ConnectAccountResponse>> {
    if (this.#deps.requireApiKey) {
      return { ok: false, status: 403, error: 'this server requires API-key auth (requireApiKey), so an account cannot be connected' }
    }
    return engineOf(profile) === 'codex' ? await this.#connectCodex(profile) : await this.#connectClaude(profile)
  }

  async #connectClaude(profile: ProfileInfo): Promise<Outcome<ConnectAccountResponse>> {
    const pty = this.#deps.options?.pty ?? (await loadPty())
    if (!pty) {
      return { ok: false, status: 501, error: 'connecting an account needs the optional @lydell/node-pty dependency' }
    }
    const executable = this.#deps.options?.claudeExecutable ?? resolveBundledClaudeExecutable()
    if (!executable) {
      return { ok: false, status: 501, error: 'the Claude Code executable could not be found' }
    }
    this.cancel(profile.name)
    let flow: SetupTokenAttempt
    try {
      flow = await startClaudeSetupToken({ pty, executable, env: this.#deps.baseEnvFor(profile), cwd: profile.configDir })
    } catch (error) {
      return { ok: false, status: 502, error: error instanceof SetupTokenError ? error.message : 'claude setup-token failed to start' }
    }
    const opened = this.#open(profile.name, { engine: 'claude', flow }, this.#deps.options?.attemptTtlMs ?? ATTEMPT_TTL_MS)
    return { ok: true, attemptId: opened.id, authorizeUrl: flow.authorizeUrl, expiresAt: opened.expiresAt }
  }

  async #connectCodex(profile: ProfileInfo): Promise<Outcome<ConnectAccountResponse>> {
    const executable = this.#deps.options?.codexExecutable ?? resolveBundledCodexExecutable()
    if (!executable) {
      return { ok: false, status: 501, error: 'the codex executable could not be found' }
    }
    this.cancel(profile.name)
    let flow: CodexDeviceLogin
    try {
      flow = await startCodexDeviceLogin({
        executable,
        env: this.#deps.baseEnvFor(profile),
        codexHome: profile.codexHome,
        cwd: profile.codexHome,
      })
    } catch (error) {
      return { ok: false, status: 502, error: error instanceof CodexLoginError ? error.message : 'codex login failed to start' }
    }
    const opened = this.#open(profile.name, { engine: 'codex', flow }, this.#deps.options?.attemptTtlMs ?? CODEX_ATTEMPT_TTL_MS)
    return { ok: true, attemptId: opened.id, authorizeUrl: flow.verificationUrl, userCode: flow.userCode, expiresAt: opened.expiresAt }
  }

  #open(name: string, started: Pick<Attempt, 'engine' | 'flow'>, ttl: number): { id: string; expiresAt: string } {
    this.cancel(name)
    const id = randomUUID()
    const timer = setTimeout(() => this.#end(name, id), ttl)
    timer.unref()
    this.#attempts.set(name, { id, timer, busy: false, ...started } as Attempt)
    return { id, expiresAt: new Date(Date.now() + ttl).toISOString() }
  }

  async complete(profile: ProfileInfo, attemptId: string, code: string | undefined): Promise<Outcome<{ pending: boolean }>> {
    const attempt = this.#attempts.get(profile.name)
    if (!attempt || attempt.id !== attemptId) {
      return { ok: false, status: 409, error: 'this sign-in attempt is no longer open; start a new one' }
    }
    if (attempt.busy) {
      return { ok: false, status: 409, error: 'this sign-in attempt is already completing' }
    }
    if (attempt.engine === 'claude' && !code) {
      return { ok: false, status: 400, error: 'code is required' }
    }
    attempt.busy = true
    let pending = false
    try {
      if (attempt.engine === 'claude') {
        const { token } = await attempt.flow.complete(code!)
        writeAccount(profile.configDir!, token)
      } else {
        pending = !(await settledWithin(attempt.flow.done, this.#deps.options?.codexWaitMs ?? CODEX_WAIT_MS))
      }
      if (!pending) {
        await this.#deps.onChange(profile)
      }
      return { ok: true, pending }
    } catch (error) {
      const known = error instanceof SetupTokenError || error instanceof CodexLoginError
      return { ok: false, status: 400, error: known ? error.message : 'the account could not be stored' }
    } finally {
      attempt.busy = false
      if (!pending) {
        this.#end(profile.name, attemptId)
      }
    }
  }

  async disconnect(profile: ProfileInfo): Promise<Outcome<{ existed: boolean }>> {
    this.cancel(profile.name)
    if (engineOf(profile) === 'codex') {
      const executable = this.#deps.options?.codexExecutable ?? resolveBundledCodexExecutable()
      if (!executable) {
        return { ok: false, status: 501, error: 'the codex executable could not be found' }
      }
      const signedOut = await codexLogout({ executable, env: this.#deps.baseEnvFor(profile), codexHome: profile.codexHome })
      await this.#deps.onChange(profile)
      return signedOut
        ? { ok: true, existed: true }
        : { ok: false, status: 502, error: 'codex logout did not succeed; the profile may still be signed in' }
    }
    const existed = profile.configDir ? deleteAccount(profile.configDir) : false
    if (existed) {
      await this.#deps.onChange(profile)
    }
    return { ok: true, existed }
  }

  expiredVerdict(profile: ProfileInfo): EngineAvailability | undefined {
    const account = this.status(profile)
    if (!account || this.#deps.requireApiKey || accountExpiry(account) !== 'expired') {
      return undefined
    }
    return {
      available: false,
      reason: `the Claude account token connected to this profile expired on ${account.expiresAt.slice(0, 10)}; reconnect it`,
    }
  }

  watchExpiry(profiles: () => ProfileInfo[]): void {
    clearInterval(this.#expiryTimer)
    this.warnExpiring(profiles())
    this.#expiryTimer = setInterval(() => this.warnExpiring(profiles()), EXPIRY_CHECK_MS)
    this.#expiryTimer.unref()
  }

  // A once-per-state log line per profile, so an operator reading the gateway log learns before sessions start failing.
  warnExpiring(profiles: ProfileInfo[], now = Date.now()): void {
    for (const profile of profiles) {
      const account = this.status(profile)
      const state = account ? accountExpiry(account, now) : 'valid'
      if (state === 'valid') {
        this.#expiryWarned.delete(profile.name)
        continue
      }
      if (this.#expiryWarned.get(profile.name) === state) {
        continue
      }
      this.#expiryWarned.set(profile.name, state)
      const when = new Date(account!.expiresAt).toISOString().slice(0, 10)
      console.warn(
        state === 'expired'
          ? `[workerdeck] The Claude account token on profile '${profile.name}' expired on ${when}; reconnect it.`
          : `[workerdeck] The Claude account token on profile '${profile.name}' expires on ${when}; reconnect it before then.`,
      )
    }
  }

  cancel(name: string): void {
    const attempt = this.#attempts.get(name)
    if (attempt) {
      this.#end(name, attempt.id)
    }
  }

  close(): void {
    clearInterval(this.#expiryTimer)
    this.#expiryTimer = undefined
    for (const name of Array.from(this.#attempts.keys())) {
      this.cancel(name)
    }
  }

  #end(name: string, id: string): void {
    const attempt = this.#attempts.get(name)
    if (attempt?.id !== id) {
      return
    }
    this.#attempts.delete(name)
    clearTimeout(attempt.timer)
    attempt.flow.cancel()
  }
}

function settledWithin(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms)
    done.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
