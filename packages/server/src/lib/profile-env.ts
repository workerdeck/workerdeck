/**
 * Pure profile/environment/path rules: which engine a profile runs, where the
 * CLI's config resolution lands, the CLAUDE_CONFIG_DIR pin, and the cwd-roots
 * policy. No state, no I/O beyond reads of the filesystem the rules are about.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import type { ProfileConfigSnapshot, ProfileEngine, ProfileInfo } from '@workerdeck/protocol'

/** A profile runs the model-agnostic engine rather than Claude Code. `engine` is
 * optional so profiles written before provider support keep meaning 'claude'. */
export function isProviderProfile(profile: ProfileInfo): boolean {
  return profile.engine === 'provider'
}

/** The engine a profile runs, absent meaning 'claude' (pre-provider profiles). */
export function engineOf(profile: ProfileInfo | undefined): ProfileEngine {
  return profile?.engine ?? 'claude'
}

/** Where the CLI's own resolution lands for a given environment: an explicit
 * CLAUDE_CONFIG_DIR, else ~/.claude. */
export function cliConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Auto-created profile when none are declared: the operator's own config dir. */
export function detectDefaultProfiles(): ProfileInfo[] {
  const dir = cliConfigDir(process.env)
  return existsSync(dir) ? [{ name: 'default', configDir: dir }] : []
}

/** Compare config dirs by what they name on disk: declared paths arrive with
 * trailing slashes or symlinked prefixes (`/var` vs `/private/var` on macOS); a
 * path that doesn't exist falls back to plain normalization. */
export function canonicalDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

/**
 * The env a Claude session under `profile` is spawned with, starting from
 * `base` (the host hook's env, else the server's own). The pin is skipped when
 * `base` would already land the CLI in the profile's dir, and that skip is
 * load-bearing, not an optimisation: CLAUDE_CONFIG_DIR *set at all* switches
 * the CLI's credential source to `<dir>/.credentials.json` — on macOS a
 * claude.ai login lives in the login Keychain, consulted only while the
 * variable is UNSET, so pinning even the CLI's own default `~/.claude` turns a
 * working login into "Not logged in". When `base` names a *different* dir than
 * the profile, the pin stands: the profile must win over hook- or operator-set
 * env, or sessions under two profiles quietly collapse into one identity.
 */
export function claudeSessionEnv(profile: ProfileInfo, base: Record<string, string | undefined>): Record<string, string | undefined> {
  return canonicalDir(profile.configDir!) === canonicalDir(cliConfigDir(base)) ? base : { ...base, CLAUDE_CONFIG_DIR: profile.configDir! }
}

export function cwdAllowed(cwd: string, roots: string[] | undefined): boolean {
  if (!roots || roots.length === 0) {
    return true
  }
  const resolved = resolvePath(cwd)
  return roots.some((root) => {
    const r = resolvePath(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
}

/**
 * Curated, view-only snapshot of a profile's config dir for GET /profiles/:name.
 * Best-effort: a missing or unparseable settings.json just omits the settings block.
 * Env var VALUES are never read into the response — names only.
 *
 * Provider profiles have no config dir, so the snapshot is empty for them: their
 * configuration is the `provider` block already on ProfileInfo.
 */
export function readProfileConfig(profile: ProfileInfo): ProfileConfigSnapshot {
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
  } catch {
    // settings.json absent or unparseable — snapshot ships without the block
  }
  return snapshot
}
