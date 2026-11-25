import { existsSync } from 'node:fs'
import { ENGINE_CAPABILITIES, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '../adapter.ts'
import type { EngineRunnerConfig } from '../../runner-interface.ts'
import { composeInstructions } from '../../lib/instructions.ts'
import { connectAcpAgent } from '../acp/connection.ts'
import { AcpRunner } from '../acp/runner.ts'
import { AGY_CATALOG } from './catalog.ts'
import { AGY_TRACE_ENV, agyArgs, agyChildEnv, agyKeyFile, resolveAgyExecutable } from './connect.ts'
import { AGY_DIALECT } from './dialect.ts'

export const AGY_NOT_INSTALLED = 'agy (Antigravity CLI) is not installed - see https://antigravity.google/docs/getting-started'

export type AgyAdapterConfig = EngineRunnerConfig & { agyPathOverride?: string }

async function checkAgyAvailability(profile: ProfileInfo, env: Record<string, string | undefined>): Promise<EngineAvailability> {
  if (!resolveAgyExecutable(env)) {
    return { available: false, reason: AGY_NOT_INSTALLED }
  }
  if (!profile.agyHome) {
    return { available: 'unknown' }
  }
  if (!existsSync(agyKeyFile(profile.agyHome))) {
    return {
      available: false,
      reason: `profile '${profile.name}' has no Gemini API key: save one to ${agyKeyFile(profile.agyHome)} (mode 0600)`,
    }
  }
  return { available: true }
}

export const agyAdapter: EngineAdapter<AgyAdapterConfig> = {
  engine: 'agy',
  capabilities: ENGINE_CAPABILITIES.agy,
  catalog: AGY_CATALOG,
  checkAvailability: (profile, env) => checkAgyAvailability(profile, env),
  createRunner({ config, profile, restore, id }) {
    if (restore) {
      throw new Error('the agy engine cannot rebuild a parked session')
    }
    const base = config.env ?? process.env
    const executable = resolveAgyExecutable(base, config.agyPathOverride)
    if (!executable) {
      throw new Error(AGY_NOT_INSTALLED)
    }
    const { env, auth } = agyChildEnv(base, profile?.agyHome)
    const args = agyArgs(profile?.agyHome)
    return new AcpRunner(
      {
        ...config,
        instructions: composeInstructions(profile?.session?.instructions, config.instructions),
        childEnv: env,
        authMethod: auth.methodId ?? undefined,
        dialect: AGY_DIALECT,
        connectFn: (options) => connectAcpAgent({ executable, args, ...options, label: 'agy', traceEnv: AGY_TRACE_ENV }),
      },
      id,
    )
  },
}
