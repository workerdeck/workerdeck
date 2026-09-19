export type FileLink = {
  path: string
  line?: number
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const TRAILING_LINE = /^(.*?):(\d+)(?::\d+)?$/
const FRAGMENT_LINE = /^L(\d+)/

// What an agent writes as a markdown link target when it means a file on the host: `./SPEC.md`,
// `docs/AUTH.md#anchor`, `/Users/me/project/src/main.ts:42`, `file:///tmp/out.txt`. Anything with a
// real scheme, and anything relative that arrives before the session's cwd is known, stays a web link.
export function parseFileLink(href: string | undefined, cwd: string | undefined): FileLink | undefined {
  const raw = href?.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) {
    return undefined
  }

  let target = raw
  if (SCHEME.test(target)) {
    if (!target.startsWith('file:')) {
      return undefined
    }
    try {
      target = decodeURIComponent(new URL(target).pathname)
    } catch {
      return undefined
    }
  }

  let line: number | undefined
  const hash = target.indexOf('#')
  if (hash !== -1) {
    line = readLine(FRAGMENT_LINE.exec(target.slice(hash + 1))?.[1])
    target = target.slice(0, hash)
  }

  const suffix = TRAILING_LINE.exec(target)
  if (suffix) {
    target = suffix[1]!
    line ??= readLine(suffix[2])
  }

  if (!target) {
    return undefined
  }

  const path = target.startsWith('/') ? normalize(target) : cwd ? normalize(`${cwd}/${target}`) : undefined
  return path ? { path, ...(line === undefined ? {} : { line }) } : undefined
}

function readLine(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join('/')}`
}
