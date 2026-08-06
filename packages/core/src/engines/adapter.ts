import type {
  EngineCapabilities,
  ModelOption,
  ProfileEngine,
  ProfileInfo,
} from '@workerdeck/protocol'
import type { Runner, RunnerSnapshot } from '../runner-interface.ts'
import type { SessionRunnerConfig } from '../runner.ts'

/**
 * A probe's verdict on one profile's credentials. 'unknown' means the probe
 * could not run at all — which is NOT evidence of a missing login and must
 * never be surfaced as one (the `checkClaudeAuth` discipline, generalized).
 */
export type EngineAvailability =
  | { available: true }
  | { available: false; reason: string }
  | { available: 'unknown' }

/**
 * A model catalog shipped with the release — the answer to "what can a create
 * form offer" with no process spawned, correct from a gateway's first request.
 *
 * Never contains a 'default' sentinel row (a choice, not a model — forms add
 * their own "Profile default" row mapping to an unset model). Staleness is
 * bounded by the release cadence: the release checklist re-runs each catalog's
 * extraction procedure (documented in its file header) and diffs.
 */
export type ModelCatalog = {
  models: ModelOption[]
  /** Source + date, for the release-checklist refresh. Not served. */
  provenance: string
}

export type EngineRunnerRequest = {
  config: SessionRunnerConfig
  profile?: ProfileInfo
  /** Rebuild a parked session instead of starting fresh. Engines that cannot
   * rehydrate throw. */
  restore?: RunnerSnapshot
}

/**
 * One engine, as the server consumes it: its capability record, its shipped
 * model catalog, a credential probe, and a runner factory. The claude adapter
 * wraps `SessionRunner` without behaviour change; the codex adapter owns the
 * `codex app-server` integration; the provider adapter is a pseudo-adapter —
 * its runners are built by the host's `createEngineRunner` hook, so its
 * `createRunner` throws and the server routes around it.
 */
export interface EngineAdapter {
  readonly engine: ProfileEngine
  /** Must deep-equal ENGINE_CAPABILITIES[engine] — asserted by a core test, so
   * the protocol's browser-safe defaults can never drift from the adapter. */
  readonly capabilities: EngineCapabilities
  readonly catalog: ModelCatalog
  /**
   * Probe whether `profile`'s credentials are usable under `env` — the full
   * session environment the real assembly path produces, never a delta (codex
   * replaces the child env wholesale, and a delta would strand HOME/PATH and
   * the auth chain with it). Never rejects.
   */
  checkAvailability(
    profile: ProfileInfo,
    env: Record<string, string | undefined>,
  ): Promise<EngineAvailability>
  /** Build a Runner. Throwing fails the create (session POST 500s, job fails). */
  createRunner(request: EngineRunnerRequest): Runner | Promise<Runner>
}

import { claudeAdapter } from './claude/adapter.ts'
import { codexAdapter } from './codex/adapter.ts'
import { providerAdapter } from './provider/adapter.ts'

const ADAPTERS: Record<ProfileEngine, EngineAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  provider: providerAdapter,
}

/** The in-repo adapter for an engine. An absent `engine` means 'claude'. */
export function getEngineAdapter(engine: ProfileEngine | undefined): EngineAdapter {
  return ADAPTERS[engine ?? 'claude']
}
