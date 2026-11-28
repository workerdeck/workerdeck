import { AGENT_SLEEP_AFTER_MS_DEFAULT } from '@workerdeck/protocol'
import type { HostSettings } from './settings.ts'

const AGENT_SLEEP_AFTER_MINUTES = AGENT_SLEEP_AFTER_MS_DEFAULT / 60_000

export function gatewayArgv(settings: HostSettings): string[] {
  const args = ['--port', String(settings.port), '--host', settings.bindAddress, '--state-dir', settings.stateDir]
  if (settings.remote) {
    args.push('--remote')
  } else if (settings.requireAuthKey) {
    args.push('--require-auth-key')
  }
  if (settings.publicUrl) {
    args.push('--public-url', settings.publicUrl)
  }
  if (settings.configPath) {
    args.push('--config', settings.configPath)
  }
  if (!settings.dashboard) {
    args.push('--no-web')
  }
  if (settings.shell) {
    args.push('--shell')
    if (settings.shellAgentWrite !== 'read-only') {
      args.push('--shell-agent-write', settings.shellAgentWrite)
    }
  }
  if (settings.hotReload) {
    args.push('--hot-reload')
  }
  for (const root of settings.cwdRoots) {
    args.push('--cwd-root', root)
  }
  if (settings.engineSleepAfterMinutes > 0) {
    args.push('--engine-sleep-after', `${settings.engineSleepAfterMinutes}m`)
  }
  if (settings.agentSleepAfterMinutes !== AGENT_SLEEP_AFTER_MINUTES) {
    args.push('--agent-sleep-after', settings.agentSleepAfterMinutes > 0 ? `${settings.agentSleepAfterMinutes}m` : 'never')
  }
  for (const [model, effort] of Object.entries(settings.effortDefaults)) {
    args.push('--effort-default', `${model}=${effort}`)
  }
  if (settings.agentContextReset !== 'off') {
    args.push('--agent-context-reset', settings.agentContextReset)
  }
  if (settings.agentSharing !== 'private') {
    args.push('--agent-sharing', settings.agentSharing)
  }
  if (settings.keepAwake === 'always') {
    args.push('--keep-awake', 'always')
  } else if (settings.keepAwake === 'off') {
    args.push('--no-keep-awake')
  }
  return args
}
