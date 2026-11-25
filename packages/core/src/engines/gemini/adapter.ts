import { existsSync } from 'node:fs'
import { ENGINE_CAPABILITIES, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '../adapter.ts'
import type { EngineRunnerConfig } from '../../runner-interface.ts'
import { composeInstructions } from '../../lib/instructions.ts'
import { connectAcpAgent } from '../acp/connection.ts'
import { AcpRunner } from '../acp/runner.ts'
import { GEMINI_CATALOG } from './catalog.ts'
import { GEMINI_TRACE_ENV, geminiArgs, geminiChildEnv, geminiKeyFile, resolveAgyExecutable } from './connect.ts'
import { GEMINI_DIALECT } from './dialect.ts'

export const GEMINI_NOT_INSTALLED = 'agy (Antigravity CLI) is not installed - see https://antigravity.google/docs/getting-started'

export type GeminiAdapterConfig = EngineRunnerConfig & { agyPathOverride?: string }

async function checkGeminiAvailability(profile: ProfileInfo, env: Record<string, string | undefined>): Promise<EngineAvailability> {
  if (!resolveAgyExecutable(env)) {
    return { available: false, reason: GEMINI_NOT_INSTALLED }
  }
  if (!profile.geminiHome) {
    return { available: 'unknown' }
  }
  if (!existsSync(geminiKeyFile(profile.geminiHome))) {
    return {
      available: false,
      reason: `profile '${profile.name}' has no Gemini API key: save one to ${geminiKeyFile(profile.geminiHome)} (mode 0600)`,
    }
  }
  return { available: true }
}

export const geminiAdapter: EngineAdapter<GeminiAdapterConfig> = {
  engine: 'gemini',
  capabilities: ENGINE_CAPABILITIES.gemini,
  catalog: GEMINI_CATALOG,
  checkAvailability: (profile, env) => checkGeminiAvailability(profile, env),
  createRunner({ config, profile, restore, id }) {
    if (restore) {
      throw new Error('the Gemini engine cannot rebuild a parked session')
    }
    const base = config.env ?? process.env
    const executable = resolveAgyExecutable(base, config.agyPathOverride)
    if (!executable) {
      throw new Error(GEMINI_NOT_INSTALLED)
    }
    const { env, auth } = geminiChildEnv(base, profile?.geminiHome)
    const args = geminiArgs(profile?.geminiHome)
    return new AcpRunner(
      {
        ...config,
        instructions: composeInstructions(profile?.session?.instructions, config.instructions),
        childEnv: env,
        authMethod: auth.methodId ?? undefined,
        dialect: GEMINI_DIALECT,
        connectFn: (options) => connectAcpAgent({ executable, args, ...options, label: 'agy', traceEnv: GEMINI_TRACE_ENV }),
      },
      id,
    )
  },
}
