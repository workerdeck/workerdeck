import type { CreateSessionRequest, EngineCapabilities, ModelOption, ProfileEngine, ProfileInfo, SdkSessionSummary } from '@workerdeck/protocol'
import type { EngineRunnerConfig, Runner, RunnerSnapshot } from '../runner-interface.ts'

export type EngineAvailability = { available: true } | { available: false; reason: string } | { available: 'unknown' }

export type ModelCatalog = {
  models: ModelOption[]
  provenance: string
}

export type EngineRunnerRequest<C extends EngineRunnerConfig = EngineRunnerConfig> = {
  config: C
  profile?: ProfileInfo
  restore?: RunnerSnapshot
  id?: string
}

export interface EngineAdapter<C extends EngineRunnerConfig = EngineRunnerConfig> {
  readonly engine: ProfileEngine
  readonly capabilities: EngineCapabilities
  readonly catalog: ModelCatalog
  checkAvailability(profile: ProfileInfo, env: Record<string, string | undefined>): Promise<EngineAvailability>
  createRunner(request: EngineRunnerRequest<C>): Runner | Promise<Runner>
  // Engine-specific create checks the capability record cannot express; the gateway answers a 400 with the message.
  refuseRequest?(request: CreateSessionRequest): string | null
  // Returns `base` itself when the profile needs nothing pinned, so a caller can leave an unset env unset.
  sessionEnv?(profile: ProfileInfo, base: Record<string, string | undefined>): Record<string, string | undefined>
  listSessions?(options: {
    profile?: ProfileInfo
    env: Record<string, string | undefined>
    dir?: string
    limit?: number
    offset?: number
  }): Promise<SdkSessionSummary[]>
}

import { claudeAdapter } from './claude/adapter.ts'
import { codexAdapter } from './codex/adapter.ts'
import { providerAdapter } from './provider/adapter.ts'

const ADAPTERS: Record<ProfileEngine, EngineAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  provider: providerAdapter,
}

export function getEngineAdapter(engine: ProfileEngine | undefined): EngineAdapter {
  return ADAPTERS[engine ?? 'claude']
}
