import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { EngineAdapter } from '../adapter.ts'

/**
 * The model-agnostic provider engine as a pseudo-adapter: capabilities and an
 * env-var probe live here, but its runners are assembled by the host's
 * `createEngineRunner` hook (which is where provider credentials are resolved
 * and model SDKs are imported — neither belongs in this repo's import graph).
 * The server routes provider creates to the hook; `createRunner` here throws
 * so a mis-routed call fails loudly instead of quietly building nothing.
 *
 * The catalog is empty by the same token: provider model ids are operator-
 * declared per profile (`provider.models`), not shipped with releases.
 */
export const providerAdapter: EngineAdapter = {
  engine: 'provider',
  capabilities: ENGINE_CAPABILITIES.provider,
  catalog: { models: [], provenance: 'provider model ids are operator-declared (provider.models)' },
  async checkAvailability(profile, env) {
    const keyEnv = profile.provider?.apiKeyEnv
    // No declared key variable = nothing this probe can check (the host hook
    // may resolve credentials some other way) — unknown, not unavailable.
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
