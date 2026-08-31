import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { EngineAdapter } from '../adapter.ts'

export const providerAdapter: EngineAdapter = {
  engine: 'provider',
  capabilities: ENGINE_CAPABILITIES.provider,
  catalog: { models: [], provenance: 'provider model ids are operator-declared (provider.models)' },
  async checkAvailability(profile, env) {
    const keyEnv = profile.provider?.apiKeyEnv
    // The host hook may resolve credentials some other way: unknown, not unavailable.
    if (!keyEnv) {
      return { available: 'unknown' }
    }
    const value = env[keyEnv]
    if (value !== undefined && value !== '') {
      return { available: true }
    }
    return {
      available: false,
      reason: `${keyEnv} is not set in the server environment (profile '${profile.name}' names it as apiKeyEnv)`,
    }
  },
  createRunner() {
    throw new Error("provider-engine runners are built by the host's createEngineRunner hook, not the adapter")
  },
}
