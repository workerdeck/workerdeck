import { probeClaudeModels, type ClaudeModelsProbe, type Runner } from '@workerdeck/core'
import type { ModelOption, ProfileInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'

export type ProfileModelsOptions = {
  probe?: boolean | { probe?: ClaudeModelsProbe; timeoutMs?: number }
  sessionEnvFor: (profile: ProfileInfo) => Record<string, string | undefined>
  onError?: (error: unknown) => void
}

type Held = { models: ModelOption[]; ticket: number }

// A producer takes a ticket when it starts and writes only while its profile's generation is the one it started under
// and no later-started producer has written: a retarget fences out an older account's probe and sessions. A runner
// older than this manager (carried over by a hot reload) never teaches: its account may predate a retarget we never saw.
export class ProfileModels {
  readonly #since = Date.now()
  readonly #held = new Map<string, Held>()
  readonly #generations = new Map<string, number>()
  readonly #opts: ProfileModelsOptions
  #tickets = 0

  constructor(opts: ProfileModelsOptions) {
    this.#opts = opts
  }

  get(name: string): ModelOption[] | undefined {
    return this.#held.get(name)?.models
  }

  watch(runner: Runner): () => void {
    const info = runner.info()
    if (!info.profile || engineOf(info) !== 'claude' || info.createdAt < this.#since) {
      return () => {}
    }
    const profile = info.profile
    const generation = this.#generation(profile)
    return runner.subscribe((event) => {
      if (event.type === 'capabilities') {
        this.#write(profile, generation, (this.#tickets += 1), event.models)
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
    const generation = this.#generation(profile.name)
    const ticket = (this.#tickets += 1)
    return run(sessionEnvFor(profile))
      .then((models) => this.#write(profile.name, generation, ticket, models))
      .catch((error: unknown) => this.#opts.onError?.(error))
  }

  preflight(profiles: ProfileInfo[]): void {
    for (const profile of profiles) {
      void this.probe(profile)
    }
  }

  forget(name: string): void {
    this.#generations.set(name, this.#generation(name) + 1)
    this.#held.delete(name)
  }

  refresh(profile: ProfileInfo): Promise<void> {
    this.forget(profile.name)
    return this.probe(profile)
  }

  #generation(name: string): number {
    return this.#generations.get(name) ?? 0
  }

  #write(name: string, generation: number, ticket: number, models: ModelOption[] | undefined): void {
    if (!models || models.length === 0 || generation !== this.#generation(name)) {
      return
    }
    const held = this.#held.get(name)
    if (held && held.ticket > ticket) {
      return
    }
    this.#held.set(name, { models, ticket })
  }
}
