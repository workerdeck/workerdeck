import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
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
  /**
   * The Agent SDK's on-disk session store, mapped browser-safe. The SDK reads
   * the store of the *process* environment — it takes no config dir — so a
   * profile pin cannot narrow this listing; that matches the route's
   * pre-adapter behavior exactly (the listing was always process-global).
   */
  async listSessions({ dir, limit, offset }) {
    const sessions = await sdkListSessions({ dir, limit, offset })
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      createdAt: s.createdAt,
      customTitle: s.customTitle,
      firstPrompt: s.firstPrompt,
      gitBranch: s.gitBranch,
      cwd: s.cwd,
    }))
  },
}
