import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const BARE_KEY = /[A-Za-z0-9_-]/

function skipWs(text: string, pos: number): number {
  let i = pos
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++
  }
  return i
}

type Parsed<T> = { value: T; end: number } | undefined

function parseBasicString(text: string, pos: number): Parsed<string> {
  let out = ''
  let i = pos + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      return { value: out, end: i + 1 }
    }
    if (ch === '\\') {
      const esc = text[i + 1]
      if (esc === 'b') {
        out += '\b'
      } else if (esc === 't') {
        out += '\t'
      } else if (esc === 'n') {
        out += '\n'
      } else if (esc === 'f') {
        out += '\f'
      } else if (esc === 'r') {
        out += '\r'
      } else if (esc === '"') {
        out += '"'
      } else if (esc === '\\') {
        out += '\\'
      } else if (esc === 'u' || esc === 'U') {
        const width = esc === 'u' ? 4 : 8
        const hex = text.slice(i + 2, i + 2 + width)
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) {
          return undefined
        }
        const code = Number.parseInt(hex, 16)
        if (code > 0x10ffff) {
          return undefined
        }
        out += String.fromCodePoint(code)
        i += width
      } else {
        return undefined
      }
      i += 2
      continue
    }
    out += ch
    i++
  }
  return undefined
}

function parseLiteralString(text: string, pos: number): Parsed<string> {
  const close = text.indexOf("'", pos + 1)
  if (close === -1) {
    return undefined
  }
  return { value: text.slice(pos + 1, close), end: close + 1 }
}

function parseKeyPath(text: string, pos: number): Parsed<string[]> {
  const keys: string[] = []
  let i = pos
  for (;;) {
    i = skipWs(text, i)
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const str = ch === '"' ? parseBasicString(text, i) : parseLiteralString(text, i)
      if (!str) {
        return undefined
      }
      keys.push(str.value)
      i = str.end
    } else if (ch !== undefined && BARE_KEY.test(ch)) {
      let end = i
      while (end < text.length && BARE_KEY.test(text[end])) {
        end++
      }
      keys.push(text.slice(i, end))
      i = end
    } else {
      return undefined
    }
    i = skipWs(text, i)
    if (text[i] !== '.') {
      return { value: keys, end: i }
    }
    i++
  }
}

// Returns the bracket depth carried onto the next line (0 = the value is complete); undefined
// refuses the whole file rather than guess what codex would read.
function scanValueLine(text: string, pos: number, depth: number): { depth: number; value?: string } | undefined {
  let i = skipWs(text, pos)
  if (depth === 0 && (text[i] === '"' || text[i] === "'")) {
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      return undefined
    }
    const str = text[i] === '"' ? parseBasicString(text, i) : parseLiteralString(text, i)
    if (!str) {
      return undefined
    }
    const rest = skipWs(text, str.end)
    if (rest < text.length && text[rest] !== '#') {
      return undefined
    }
    return { depth: 0, value: str.value }
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '#') {
      break
    }
    if (ch === '"' || ch === "'") {
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        return undefined
      }
      const str = ch === '"' ? parseBasicString(text, i) : parseLiteralString(text, i)
      if (!str) {
        return undefined
      }
      i = str.end
      continue
    }
    if (ch === '[' || ch === '{') {
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
      if (depth < 0) {
        return undefined
      }
    }
    i++
  }
  return { depth }
}

export function parseProjectTrustEntries(source: string): Map<string, string> | undefined {
  const entries = new Map<string, string>()
  let section: string[] = []
  let carryDepth = 0
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (carryDepth > 0) {
      const scanned = scanValueLine(line, 0, carryDepth)
      if (!scanned) {
        return undefined
      }
      carryDepth = scanned.depth
      continue
    }
    const start = skipWs(line, 0)
    if (start >= line.length || line[start] === '#') {
      continue
    }
    if (line[start] === '[') {
      const array = line.startsWith('[[', start)
      const path = parseKeyPath(line, start + (array ? 2 : 1))
      if (!path) {
        return undefined
      }
      const close = array ? ']]' : ']'
      if (!line.startsWith(close, path.end)) {
        return undefined
      }
      const rest = skipWs(line, path.end + close.length)
      if (rest < line.length && line[rest] !== '#') {
        return undefined
      }
      if (array && path.value[0] === 'projects') {
        return undefined
      }
      section = path.value
      continue
    }
    const key = parseKeyPath(line, start)
    if (!key) {
      return undefined
    }
    if (line[key.end] !== '=') {
      return undefined
    }
    const scanned = scanValueLine(line, key.end + 1, 0)
    if (!scanned) {
      return undefined
    }
    carryDepth = scanned.depth
    const full = [...section, ...key.value]
    if (full[0] !== 'projects') {
      continue
    }
    // `projects = {...}` / `projects."<p>" = {...}`: whole-entry forms this reader does not
    // interpret — refuse rather than miss a trust_level inside.
    if (full.length < 3) {
      return undefined
    }
    if (full.length === 3 && full[2] === 'trust_level') {
      if (carryDepth !== 0 || scanned.value === undefined) {
        return undefined
      }
      const project = full[1] as string
      const existing = entries.get(project)
      if (existing !== undefined && existing !== scanned.value) {
        return undefined
      }
      entries.set(project, scanned.value)
    }
  }
  if (carryDepth > 0) {
    return undefined
  }
  return entries
}

function mainRepositoryTrusted(gitRootDir: string, canonical: Map<string, string>): boolean {
  const gitPath = join(gitRootDir, '.git')
  try {
    if (!statSync(gitPath).isFile()) {
      return false
    }
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(gitPath, 'utf8'))
    if (!match) {
      return false
    }
    const gitdir = resolve(gitRootDir, match[1])
    const at = gitdir.lastIndexOf(`${sep}.git${sep}`)
    if (at <= 0) {
      return false
    }
    let main = gitdir.slice(0, at)
    try {
      main = realpathSync(main)
    } catch {}
    return canonical.get(main) === 'trusted'
  } catch {
    return false
  }
}

export function untrustedProjectNotice(options: { cwd: string; codexHome: string }): string | undefined {
  let cwd: string
  try {
    cwd = realpathSync(options.cwd)
  } catch {
    return undefined
  }
  let home = resolve(options.codexHome)
  try {
    home = realpathSync(options.codexHome)
  } catch {}
  const chain: string[] = []
  let dir = cwd
  for (;;) {
    chain.push(dir)
    if (existsSync(join(dir, '.git'))) {
      break
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  const anchor = chain[chain.length - 1] as string
  const gitRoot = existsSync(join(anchor, '.git')) ? anchor : undefined
  const layers = (gitRoot ? chain : [cwd]).filter((layer) => {
    if (!existsSync(join(layer, '.codex', 'config.toml'))) {
      return false
    }
    try {
      // The cwd whose `.codex` IS the codex home: that config is the base config and always loads.
      return realpathSync(join(layer, '.codex')) !== home
    } catch {
      return false
    }
  })
  if (layers.length === 0) {
    return undefined
  }
  const homeConfigPath = join(options.codexHome, 'config.toml')
  let source = ''
  try {
    source = readFileSync(homeConfigPath, 'utf8')
  } catch (error) {
    // Absent = knowably no trust entries; unreadable = unknowable, silence.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return undefined
    }
  }
  const entries = parseProjectTrustEntries(source)
  if (!entries) {
    return undefined
  }
  for (const value of entries.values()) {
    if (value !== 'trusted' && value !== 'untrusted') {
      return undefined
    }
  }
  // Two spellings of one directory with conflicting verdicts keep the trusted one — the
  // direction that stays silent.
  const canonical = new Map<string, string>()
  for (const [key, value] of entries) {
    let path = key
    try {
      path = realpathSync(key)
    } catch {}
    if (canonical.get(path) === 'trusted') {
      continue
    }
    canonical.set(path, value)
  }
  const rootTrusted = gitRoot !== undefined && (canonical.get(gitRoot) === 'trusted' || mainRepositoryTrusted(gitRoot, canonical))
  const ignored = layers.filter((layer) => {
    const entry = canonical.get(layer)
    if (entry !== undefined) {
      return entry !== 'trusted'
    }
    return !rootTrusted
  })
  if (ignored.length === 0) {
    return undefined
  }
  const trustDir = gitRoot ?? cwd
  const configs = ignored.map((layer) => join(layer, '.codex', 'config.toml'))
  const what = configs.length === 1 ? `its project config (${configs[0]}) is` : `its project configs (${configs.join(', ')}) are`
  return (
    `codex does not trust this directory, so ${what} being ignored — MCP servers and ` +
    `settings declared there will be missing from this session. To trust it, run codex once ` +
    `in ${trustDir} and accept the trust prompt, or add [projects."${trustDir}"] with ` +
    `trust_level = "trusted" to ${homeConfigPath}.`
  )
}
