/**
 * Availability, per profile: the adapter's probe run over the env the real
 * assembly path produces (so anything the host hook injects — a
 * CLAUDE_CODE_OAUTH_TOKEN, say — counts as logged in). Cached, and served on
 * `GET /profiles` as `available`/`unavailableReason`.
 *
 * Gated on `checkCredentials` like the old claude-only preflight (this is a
 * library; `pnpm test` must spawn nothing unless a test injects fake
 * adapters or probes). 'unknown' stays out of the cache's answers: a probe
 * that couldn't run is not evidence of a missing login. **Display-only**
 * downstream — session create against an unavailable profile still proceeds
 * and fails with the engine's own error, because the probe can be stale in
 * both directions and refusing on it would turn a probe bug into an outage.
 * (`requireAvailableProfile` is the one deliberate exception, and only on a
 * definite `false`.)
 */
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
  /** The env the real assembly path would spawn this profile's session with. */
  sessionEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
}

export class AvailabilityTracker {
  readonly #verdicts = new Map<string, { verdict: EngineAvailability; at: number }>()
  /** Profiles already warned about on the console, so re-probes don't spam. */
  readonly #warned = new Set<string>()
  readonly #opts: AvailabilityTrackerOptions

  constructor(opts: AvailabilityTrackerOptions) {
    this.#opts = opts
  }

  /** The cached verdict, if any probe has answered. */
  get(name: string): EngineAvailability | undefined {
    return this.#verdicts.get(name)?.verdict
  }

  probe(profile: ProfileInfo): void {
    const { checkCredentials, adapterFor, sessionEnvFor } = this.#opts
    if (!checkCredentials) return
    const conf = checkCredentials === true ? {} : checkCredentials
    // Mark in-flight immediately so concurrent GET /profiles don't re-spawn.
    this.#verdicts.set(profile.name, {
      verdict: this.#verdicts.get(profile.name)?.verdict ?? { available: 'unknown' },
      at: Date.now(),
    })
    const adapter = adapterFor(profile.engine)
    // The injectable claude probe predates the adapter layer and is honored
    // for claude profiles (existing tests and hosts wire it).
    const claudeProbe: ClaudeAuthProbe | undefined =
      engineOf(profile) !== 'claude'
        ? undefined
        : (conf.probe ??
          (conf.timeoutMs !== undefined
            ? (env) => checkClaudeAuth(env, { timeoutMs: conf.timeoutMs })
            : undefined))
    const run: Promise<EngineAvailability> =
      claudeProbe
        ? claudeProbe(sessionEnvFor(profile)).then(
            (status): EngineAvailability =>
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
            `[workerdeck] Profile '${profile.name}' is unavailable: ${verdict.reason} ` +
              '(`checkCredentials: false` disables this check)',
          )
        }
        if (verdict.available === true) this.#warned.delete(profile.name)
      })
      .catch(() => {
        // a probe that breaks is 'unknown', and unknown stays silent
      })
  }

  /**
   * The create-time half of `requireAvailableProfile`. Only a definite `false`
   * refuses: an unprobed profile ('unknown', or probes turned off entirely) is
   * not evidence of anything and must not become a closed door.
   */
  checkAvailable(profile: ProfileInfo | undefined): Refusal | null {
    if (!this.#opts.requireAvailableProfile || !profile) return null
    const verdict = this.get(profile.name)
    if (!verdict || verdict.available !== false) return null
    return {
      status: 503,
      error: `profile '${profile.name}' is unavailable: ${verdict.reason ?? 'no usable credentials'}`,
    }
  }

  /** Launch-time sweep, concurrent and fire-and-forget. */
  preflight(profiles: ProfileInfo[]): void {
    for (const profile of profiles) this.probe(profile)
  }

  /** Lazy re-probe on reads, so an operator who just ran `codex login` (or
   * exported a key) sees the profile go green without a restart. Serves the
   * cached verdict now; the refreshed one lands on the next request. */
  refresh(profiles: ProfileInfo[]): void {
    if (!this.#opts.checkCredentials) return
    const now = Date.now()
    for (const profile of profiles) {
      const cached = this.#verdicts.get(profile.name)
      if (!cached || now - cached.at > AVAILABILITY_TTL_MS) this.probe(profile)
    }
  }
}
