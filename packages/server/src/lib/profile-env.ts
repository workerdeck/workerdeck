import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import type { ProfileConfigSnapshot, ProfileEngine, ProfileInfo } from '@workerdeck/protocol'

export const isProviderProfile = (profile: ProfileInfo): boolean => {
  return profile.engine === 'provider'
}

export const engineOf = (profile: ProfileInfo | undefined): ProfileEngine => {
  return profile?.engine ?? 'claude'
}

export const cliConfigDir = (env: Record<string, string | undefined>): string => {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export const detectDefaultProfiles = (): ProfileInfo[] => {
  const dir = cliConfigDir(process.env)
  return existsSync(dir) ? [{ name: 'default', configDir: dir }] : []
}

export const canonicalDir = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

// Skipping the pin is load-bearing: CLAUDE_CONFIG_DIR set at all moves the CLI off the macOS Keychain.
export const claudeSessionEnv = (profile: ProfileInfo, base: Record<string, string | undefined>): Record<string, string | undefined> => {
  return canonicalDir(profile.configDir!) === canonicalDir(cliConfigDir(base)) ? base : { ...base, CLAUDE_CONFIG_DIR: profile.configDir! }
}

export const cwdAllowed = (cwd: string, roots: string[] | undefined): boolean => {
  if (!roots || roots.length === 0) {
    return true
  }
  const resolved = resolvePath(cwd)
  return roots.some((root) => {
    const r = resolvePath(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
}

// Env var VALUES are never read into this snapshot — names only.
export const readProfileConfig = (profile: ProfileInfo): ProfileConfigSnapshot => {
  const dir = profile.configDir
  if (!dir) {
    return { hasUserMemory: false, skills: [], agents: [], commands: [] }
  }
  const listDirs = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  const listMd = (path: string): string[] => {
    try {
      return readdirSync(path)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }
  const snapshot: ProfileConfigSnapshot = {
    hasUserMemory: existsSync(join(dir, 'CLAUDE.md')),
    skills: listDirs(join(dir, 'skills')),
    agents: listMd(join(dir, 'agents')),
    commands: listMd(join(dir, 'commands')),
  }
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>
    const permissions = (raw.permissions ?? {}) as Record<string, unknown>
    const count = (rules: unknown): number => (Array.isArray(rules) ? rules.length : 0)
    snapshot.settings = {
      model: typeof raw.model === 'string' ? raw.model : undefined,
      defaultPermissionMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined,
      permissionRules: {
        allow: count(permissions.allow),
        ask: count(permissions.ask),
        deny: count(permissions.deny),
      },
      envKeys: raw.env && typeof raw.env === 'object' ? Object.keys(raw.env).sort() : undefined,
      hooks: raw.hooks && typeof raw.hooks === 'object' ? Object.keys(raw.hooks).sort() : undefined,
    }
  } catch {}
  return snapshot
}
