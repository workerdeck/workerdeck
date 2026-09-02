import { PROTOCOL_VERSION } from '@workerdeck/protocol'

// The operator's environment reaches the child whole — WorkerDeck resolves no credential of its
// own — and the profile's CODEX_HOME is the one key it pins, last, so a profile always wins over
// an inherited value. Every path that spawns or connects to an app-server goes through here.
export function codexChildEnv(base: Record<string, string | undefined>, codexHome?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (codexHome) {
    env.CODEX_HOME = codexHome
  }
  return env
}

// `experimentalApi` gates the granular approval policy and there is no non-experimental fallback, so it is not per-call-site.
export const INITIALIZE_PARAMS = {
  clientInfo: {
    name: 'workerdeck',
    title: 'WorkerDeck',
    version: `protocol-${PROTOCOL_VERSION}`,
  },
  capabilities: { experimentalApi: true },
} as const
