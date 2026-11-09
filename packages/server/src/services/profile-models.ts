import { probeClaudeModels, type ClaudeModelsProbe, type Runner } from '@workerdeck/core'
import type { ModelOption, ProfileInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'

export type ProfileModelsOptions = {
  probe?: boolean | { probe?: ClaudeModelsProbe; timeoutMs?: number }
  sessionEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
  onError?: (error: unknown) => void
}

export class ProfileModels {
  readonly #models = new Map<string, ModelOption[]>()
  readonly #opts: ProfileModelsOptions

  constructor(opts: ProfileModelsOptions) {
    this.#opts = opts
  }

  get(name: string): ModelOption[] | undefined {
    return this.#models.get(name)
  }

  watch(runner: Runner): () => void {
    const info = runner.info()
    if (!info.profile || engineOf(info) !== 'claude') {
      return () => {}
    }
    const profile = info.profile
    return runner.subscribe((event) => {
      if (event.type === 'capabilities' && event.models.length > 0) {
        this.#models.set(profile, event.models)
      }
    })
  }

  probe(profile: ProfileInfo): Promise<void> {
    const { probe, sessionEnvFor } = this.#opts
    if (!probe || engineOf(profile) !== 'claude') {
      return Promise.resolve()
    }
    const conf = probe === true ? {} : probe
    const run = conf.probe ?? ((env) => probeClaudeModels(env, { timeoutMs: conf.timeoutMs }))
    return run(sessionEnvFor(profile))
      .then((models) => {
        if (models && models.length > 0) {
          this.#models.set(profile.name, models)
        }
      })
      .catch((error: unknown) => this.#opts.onError?.(error))
  }

  preflight(profiles: ProfileInfo[]): void {
    for (const profile of profiles) {
      void this.probe(profile)
    }
  }

  forget(name: string): void {
    this.#models.delete(name)
  }
}
