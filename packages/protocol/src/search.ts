export type HostSearchRequest = {
  path: string
  query: string
  isRegex?: boolean
  matchCase?: boolean
  wholeWord?: boolean
  includes?: string[]
  excludes?: string[]
  useIgnoreFiles?: boolean
  maxResults?: number
}

export type HostSearchRange = {
  line: number
  column: number
  endLine: number
  endColumn: number
}

export type HostSearchMatch = HostSearchRange & { text: string }

export type HostSearchLine = {
  line: number
  start: number
  text: string
  matches: HostSearchMatch[]
}

export type HostSearchFile = {
  type: 'file'
  path: string
  relative: string
  lines: HostSearchLine[]
}

export type HostSearchDone = {
  type: 'done'
  files: number
  matches: number
  truncated: boolean
}

export type HostSearchFailure = {
  type: 'error'
  message: string
}

export type HostSearchEvent = HostSearchFile | HostSearchDone | HostSearchFailure

export type ReplaceOptions = {
  query: string
  replace: string
  isRegex?: boolean
  matchCase?: boolean
  preserveCase?: boolean
}

export const HOST_SEARCH_MAX_RESULTS = 20_000

export function searchGlobs(text: string, root?: string): string[] {
  const globs: string[] = []
  for (const raw of splitGlobList(text)) {
    let pattern = raw.replaceAll('\\', '/')
    if (root && pattern.startsWith('/')) {
      const base = root.endsWith('/') ? root : `${root}/`
      if (pattern === root || pattern === base.slice(0, -1)) {
        continue
      }
      if (!pattern.startsWith(base)) {
        continue
      }
      pattern = `./${pattern.slice(base.length)}`
    }
    pattern = pattern.replace(/\/+$/, '')
    if (pattern === '' || pattern === '.') {
      continue
    }
    const anchored = pattern.startsWith('./')
    const body = anchored ? pattern.slice(2) : pattern.startsWith('**/') || pattern === '**' ? pattern : `**/${pattern}`
    for (const glob of [body, `${body}/**`]) {
      const tidy = glob.replaceAll('**/**', '**')
      if (!globs.includes(tidy)) {
        globs.push(tidy)
      }
    }
  }
  return globs
}

function splitGlobList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{') {
      depth++
    } else if (char === '}' && depth > 0) {
      depth--
    }
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

export function searchRegExp(options: Pick<ReplaceOptions, 'query' | 'isRegex' | 'matchCase'>): RegExp | undefined {
  const source = options.isRegex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = `${options.matchCase ? '' : 'i'}mu`
  try {
    return new RegExp(source, flags)
  } catch {
    try {
      return new RegExp(source, flags.replace('u', ''))
    } catch {
      return undefined
    }
  }
}

export function replacementFor(matched: string, options: ReplaceOptions): string {
  let value = options.replace
  if (options.isRegex) {
    const regex = searchRegExp(options)
    const whole = regex && new RegExp(`^(?:${regex.source})$`, regex.flags.replace('m', ''))
    const groups = whole?.exec(matched) ?? regex?.exec(matched)
    value = expandReplacePattern(options.replace, groups ?? [matched])
  }
  return options.preserveCase ? withCaseOf(matched, value) : value
}

type CaseOp = 'upper' | 'lower'

function expandReplacePattern(pattern: string, groups: ArrayLike<string | undefined>): string {
  let out = ''
  let once: CaseOp | undefined
  let span: CaseOp | undefined
  function emit(text: string): void {
    for (const char of text) {
      let next = span === 'upper' ? char.toUpperCase() : span === 'lower' ? char.toLowerCase() : char
      if (once) {
        next = once === 'upper' ? char.toUpperCase() : char.toLowerCase()
        once = undefined
      }
      out += next
    }
  }
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    const next = pattern[i + 1]
    if (char === '\\' && next !== undefined) {
      i++
      if (next === 'n') {
        emit('\n')
      } else if (next === 't') {
        emit('\t')
      } else if (next === 'u') {
        once = 'upper'
      } else if (next === 'l') {
        once = 'lower'
      } else if (next === 'U') {
        span = 'upper'
      } else if (next === 'L') {
        span = 'lower'
      } else if (next === 'E') {
        span = undefined
      } else {
        emit(next === '\\' ? '\\' : `\\${next}`)
      }
      continue
    }
    if (char === '$' && next !== undefined) {
      if (next === '$') {
        i++
        emit('$')
        continue
      }
      if (next === '&') {
        i++
        emit(groups[0] ?? '')
        continue
      }
      const digits = /^\d{1,2}/.exec(pattern.slice(i + 1))?.[0]
      if (digits) {
        const index = digits.length === 2 && Number(digits) >= groups.length ? Number(digits[0]) : Number(digits)
        if (index < groups.length) {
          i += String(index).length
          emit(groups[index] ?? '')
          continue
        }
      }
    }
    emit(char)
  }
  return out
}

function withCaseOf(matched: string, value: string): string {
  if (matched === '' || value === '') {
    return value
  }
  const hyphens = splitsAlike(matched, value, '-')
  const underscores = splitsAlike(matched, value, '_')
  if (hyphens !== underscores) {
    const separator = hyphens ? '-' : '_'
    const from = matched.split(separator)
    return value
      .split(separator)
      .map((part, i) => withCaseOf(from[i]!, part))
      .join(separator)
  }
  if (matched.toUpperCase() === matched) {
    return value.toUpperCase()
  }
  if (matched.toLowerCase() === matched) {
    return value.toLowerCase()
  }
  const first = matched[0]!
  if (first.toLowerCase() !== first) {
    return value[0]!.toUpperCase() + value.slice(1)
  }
  if (first.toUpperCase() !== first) {
    return value[0]!.toLowerCase() + value.slice(1)
  }
  return value
}

function splitsAlike(matched: string, value: string, separator: string): boolean {
  return matched.includes(separator) && value.includes(separator) && matched.split(separator).length === value.split(separator).length
}
