import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProfileInfo } from '@workerdeck/protocol'

export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

// Skipping the pin is load-bearing: CLAUDE_CONFIG_DIR set at all moves the CLI off the macOS Keychain.
export function claudeSessionEnv(profile: ProfileInfo, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const configDir = profile.configDir
  if (configDir === undefined || canonicalDir(configDir) === canonicalDir(claudeConfigDir(base))) {
    return base
  }
  return { ...base, CLAUDE_CONFIG_DIR: configDir }
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
