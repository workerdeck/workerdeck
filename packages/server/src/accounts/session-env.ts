import type { ProfileInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'
import { CREDENTIAL_ENV_KEYS } from './setup-token.ts'
import { readAccountToken } from './token-store.ts'

// A connected profile's token must win over the gateway's own key or auth token, which the CLI would otherwise prefer.
export function accountSessionEnv(profile: ProfileInfo, env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (engineOf(profile) !== 'claude') {
    return env
  }
  const token = profile.configDir ? readAccountToken(profile.configDir) : undefined
  if (token === undefined && profile.connectors !== false) {
    return env
  }
  const out = { ...env }
  if (token !== undefined) {
    for (const key of CREDENTIAL_ENV_KEYS) {
      delete out[key]
    }
    out.CLAUDE_CODE_OAUTH_TOKEN = token
  }
  if (profile.connectors === false) {
    out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  }
  return out
}
