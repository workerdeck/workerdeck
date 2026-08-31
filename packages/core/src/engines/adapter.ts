import type { EngineCapabilities, ModelOption, ProfileEngine, ProfileInfo, SdkSessionSummary } from '@workerdeck/protocol'
import type { Runner, RunnerSnapshot } from '../runner-interface.ts'
import type { SessionRunnerConfig } from './claude/runner.ts'

export type EngineAvailability = { available: true } | { available: false; reason: string } | { available: 'unknown' }

export type ModelCatalog = {
  models: ModelOption[]
  provenance: string
}

export type EngineRunnerRequest = {
  config: SessionRunnerConfig
  profile?: ProfileInfo
  restore?: RunnerSnapshot
  id?: string
}

export interface EngineAdapter {
  readonly engine: ProfileEngine
  readonly capabilities: EngineCapabilities
  readonly catalog: ModelCatalog
  checkAvailability(profile: ProfileInfo, env: Record<string, string | undefined>): Promise<EngineAvailability>
  createRunner(request: EngineRunnerRequest): Runner | Promise<Runner>
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

export const getEngineAdapter = (engine: ProfileEngine | undefined): EngineAdapter => {
  return ADAPTERS[engine ?? 'claude']
}
