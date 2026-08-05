import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import { checkClaudeAuth } from '../../claude-auth.ts'
import { SessionRunner } from '../../runner.ts'
import type { EngineAdapter } from '../adapter.ts'
import { CLAUDE_CATALOG } from './catalog.ts'

/**
 * The Claude engine as an adapter — a thin, behaviourally inert wrapper:
 * `SessionRunner` unchanged, `checkClaudeAuth` as the probe, the static
 * catalog for create forms. Exists so catalogs, capabilities and availability
 * have one shape across engines; the runner itself is exactly what
 * `registry.prepare()` builds.
 */
export const claudeAdapter: EngineAdapter = {
  engine: 'claude',
  capabilities: ENGINE_CAPABILITIES.claude,
  catalog: CLAUDE_CATALOG,
  async checkAvailability(profile, env) {
    const status = await checkClaudeAuth(env)
    if (status === 'logged_in') return { available: true }
    if (status === 'logged_out') {
      return {
        available: false,
        reason:
          `no usable Claude credentials for this profile's environment — log in under its ` +
          `config dir (CLAUDE_CONFIG_DIR=${profile.configDir ?? '~/.claude'} claude auth login) ` +
          'or set ANTHROPIC_API_KEY',
      }
    }
    return { available: 'unknown' }
  },
  createRunner({ config, restore }) {
    if (restore) throw new Error('the Claude engine cannot rebuild a parked session')
    return new SessionRunner(config)
  },
}
