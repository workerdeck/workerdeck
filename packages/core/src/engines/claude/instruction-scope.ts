import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

const ANCESTOR_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']
const ANCESTOR_CLAUDE_DIR_FILES = ['.claude/CLAUDE.md', '.claude/AGENTS.md']

// The CLI turns every backslash into a slash before matching, so a glob character can only be made literal by a class.
function escapeGlob(path: string): string {
  return path.replaceAll('\\', '/').replace(/[*?[{}()]/g, (char) => `[${char}]`)
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function ancestorsOf(dir: string): string[] {
  const out: string[] = []
  let current = dir
  for (let parent = dirname(current); parent !== current; parent = dirname(current)) {
    out.push(parent)
    current = parent
  }
  return out
}

export type InstructionHome = { home?: string; configDir?: string }

// `~/.claude` is this session's user memory only when it is the CLI's config dir. On a profile with a config dir of
// its own the CLI reads `~/.claude/CLAUDE.md` as a project file at `$HOME`, which also stops the AGENTS.md fallback.
function homeClaudeDirOwned(home: string, configDir: string | undefined): boolean {
  return configDir === undefined || realOrSelf(resolve(configDir)) === realOrSelf(resolve(home, '.claude'))
}

function claudeDirPatterns(dir: string): string[] {
  const escaped = escapeGlob(dir).replace(/\/$/, '')
  return [...ANCESTOR_CLAUDE_DIR_FILES.map((file) => `${escaped}/${file}`), `${escaped}/.claude/rules/**`]
}

export function foreignHomeExcludes({ home = homedir(), configDir }: InstructionHome = {}): string[] {
  if (homeClaudeDirOwned(home, configDir)) {
    return []
  }
  return [...new Set([resolve(home), realOrSelf(resolve(home))])].flatMap(claudeDirPatterns)
}

export function ancestorInstructionExcludes(cwd: string, { home = homedir(), configDir }: InstructionHome = {}): string[] {
  const start = resolve(cwd)
  const homes = new Set([resolve(home), realOrSelf(resolve(home))])
  const dirs = new Set([...ancestorsOf(start), ...ancestorsOf(realOrSelf(start))])
  const patterns: string[] = []
  for (const dir of dirs) {
    const escaped = escapeGlob(dir).replace(/\/$/, '')
    patterns.push(...ANCESTOR_FILES.map((file) => `${escaped}/${file}`))
    if (!homes.has(dir) || !homeClaudeDirOwned(home, configDir)) {
      patterns.push(...claudeDirPatterns(dir))
    }
  }
  return patterns
}

export function withInstructionExcludes(settings: Options['settings'], excludes: string[]): Options['settings'] {
  if (typeof settings === 'string') {
    if (!settings.trimStart().startsWith('{')) {
      throw new Error("instructionScope 'cwd' cannot merge into a settings file path; pass extraOptions.settings as an object")
    }
    settings = JSON.parse(settings) as Exclude<Options['settings'], string | undefined>
  }
  const own = settings?.claudeMdExcludes ?? []
  return { ...settings, claudeMdExcludes: [...own, ...excludes] }
}
