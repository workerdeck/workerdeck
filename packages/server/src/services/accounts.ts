import { randomUUID } from 'node:crypto'
import { resolveBundledClaudeExecutable } from '@workerdeck/core'
import type { ConnectAccountResponse, ProfileAccount, ProfileInfo } from '@workerdeck/protocol'
import { SetupTokenError, startClaudeSetupToken, type SetupTokenAttempt } from '../accounts/setup-token.ts'
import { deleteAccount, readAccount, writeAccount } from '../accounts/token-store.ts'
import type { Refusal } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { AuthContext } from './auth.ts'
import type { ProfileService } from './profiles.ts'
import { loadPty } from './shell-env.ts'
import type { PtyModule } from './shell-types.ts'

const ATTEMPT_TTL_MS = 10 * 60 * 1000

export type AccountOptions = {
  // Widens who may connect a profile beyond `canManageProfiles`, e.g. the profile's own user in a multi-user host.
  canConnect?: (principal: unknown, profile: ProfileInfo) => boolean | Promise<boolean>
  claudeExecutable?: string
  pty?: PtyModule
  attemptTtlMs?: number
}

type Attempt = { id: string; flow: SetupTokenAttempt; timer: NodeJS.Timeout; busy: boolean }

type Outcome<T> = ({ ok: true } & T) | ({ ok: false } & Refusal)

export type AccountServiceDeps = {
  options: AccountOptions | undefined
  profiles: ProfileService
  // The profile's own session env without any account token, so the CLI signs in against the profile's config dir.
  baseEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
  onChange: (profile: ProfileInfo) => void
}

export class AccountService {
  readonly #deps: AccountServiceDeps
  readonly #attempts = new Map<string, Attempt>()

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
    if (engineOf(profile) !== 'claude') {
      return { status: 400, error: `profile '${profile.name}' is not a Claude profile` }
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
    this.cancel(profile.name)
    const ttl = this.#deps.options?.attemptTtlMs ?? ATTEMPT_TTL_MS
    const id = randomUUID()
    const timer = setTimeout(() => this.#end(profile.name, id), ttl)
    timer.unref()
    this.#attempts.set(profile.name, { id, flow, timer, busy: false })
    return { ok: true, attemptId: id, authorizeUrl: flow.authorizeUrl, expiresAt: new Date(Date.now() + ttl).toISOString() }
  }

  async complete(profile: ProfileInfo, attemptId: string, code: string): Promise<Outcome<{ account: ProfileAccount }>> {
    const attempt = this.#attempts.get(profile.name)
    if (!attempt || attempt.id !== attemptId) {
      return { ok: false, status: 409, error: 'this sign-in attempt is no longer open; start a new one' }
    }
    if (attempt.busy) {
      return { ok: false, status: 409, error: 'this sign-in attempt is already completing' }
    }
    attempt.busy = true
    try {
      const { token } = await attempt.flow.complete(code)
      const account = writeAccount(profile.configDir!, token)
      this.#deps.onChange(profile)
      return { ok: true, account }
    } catch (error) {
      return { ok: false, status: 400, error: error instanceof SetupTokenError ? error.message : 'the account could not be stored' }
    } finally {
      this.#end(profile.name, attemptId)
    }
  }

  disconnect(profile: ProfileInfo): boolean {
    this.cancel(profile.name)
    const existed = profile.configDir ? deleteAccount(profile.configDir) : false
    if (existed) {
      this.#deps.onChange(profile)
    }
    return existed
  }

  cancel(name: string): void {
    const attempt = this.#attempts.get(name)
    if (attempt) {
      this.#end(name, attempt.id)
    }
  }

  close(): void {
    for (const name of [...this.#attempts.keys()]) {
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
