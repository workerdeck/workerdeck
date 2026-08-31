import { checkClaudeAuth } from '@workerdeck/core'
import type { ClaudeAuthProbe, EngineAdapter, EngineAvailability } from '@workerdeck/core'
import type { ProfileEngine, ProfileInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'
import type { Refusal } from './profiles.ts'

const AVAILABILITY_TTL_MS = 60_000

export type AvailabilityTrackerOptions = {
  checkCredentials?: boolean | { probe?: ClaudeAuthProbe; timeoutMs?: number }
  requireAvailableProfile?: boolean
  adapterFor: (engine: ProfileEngine | undefined) => EngineAdapter
  sessionEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
}

export class AvailabilityTracker {
  readonly #verdicts = new Map<string, { verdict: EngineAvailability; at: number }>()
  readonly #warned = new Set<string>()
  readonly #opts: AvailabilityTrackerOptions

  constructor(opts: AvailabilityTrackerOptions) {
    this.#opts = opts
  }

  get(name: string): EngineAvailability | undefined {
    return this.#verdicts.get(name)?.verdict
  }

  probe(profile: ProfileInfo): void {
    const { checkCredentials, adapterFor, sessionEnvFor } = this.#opts
    if (!checkCredentials) {
      return
    }
    const conf = checkCredentials === true ? {} : checkCredentials
    // Mark in-flight immediately so concurrent GET /profiles don't re-spawn.
    this.#verdicts.set(profile.name, {
      verdict: this.#verdicts.get(profile.name)?.verdict ?? { available: 'unknown' },
      at: Date.now(),
    })
    const adapter = adapterFor(profile.engine)
    const claudeProbe: ClaudeAuthProbe | undefined =
      engineOf(profile) !== 'claude'
        ? undefined
        : (conf.probe ?? (conf.timeoutMs !== undefined ? (env) => checkClaudeAuth(env, { timeoutMs: conf.timeoutMs }) : undefined))
    const run: Promise<EngineAvailability> = claudeProbe
      ? claudeProbe(sessionEnvFor(profile)).then((status): EngineAvailability =>
          status === 'logged_in'
            ? { available: true }
            : status === 'logged_out'
              ? { available: false, reason: 'no usable Claude credentials for this profile' }
              : { available: 'unknown' },
        )
      : adapter.checkAvailability(profile, sessionEnvFor(profile))
    void run
      .then((verdict) => {
        this.#verdicts.set(profile.name, { verdict, at: Date.now() })
        if (verdict.available === false && !this.#warned.has(profile.name)) {
          this.#warned.add(profile.name)
          console.warn(
            `[workerdeck] Profile '${profile.name}' is unavailable: ${verdict.reason} ` + '(`checkCredentials: false` disables this check)',
          )
        }
        if (verdict.available === true) {
          this.#warned.delete(profile.name)
        }
      })
      .catch(() => {})
  }

  checkAvailable(profile: ProfileInfo | undefined): Refusal | null {
    if (!this.#opts.requireAvailableProfile || !profile) {
      return null
    }
    const verdict = this.get(profile.name)
    if (!verdict || verdict.available !== false) {
      return null
    }
    return {
      status: 503,
      error: `profile '${profile.name}' is unavailable: ${verdict.reason ?? 'no usable credentials'}`,
    }
  }

  preflight(profiles: ProfileInfo[]): void {
    for (const profile of profiles) {
      this.probe(profile)
    }
  }

  refresh(profiles: ProfileInfo[]): void {
    if (!this.#opts.checkCredentials) {
      return
    }
    const now = Date.now()
    for (const profile of profiles) {
      const cached = this.#verdicts.get(profile.name)
      if (!cached || now - cached.at > AVAILABILITY_TTL_MS) {
        this.probe(profile)
      }
    }
  }
}
