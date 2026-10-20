export type ExcludeValue = boolean | { when?: string }

export type ExcludeRule = { pattern: RegExp; when?: string }

const NO_SEP = '[^/]'

export function excludeRules(config: Record<string, ExcludeValue>): ExcludeRule[] {
  const rules: ExcludeRule[] = []
  for (const [glob, value] of Object.entries(config)) {
    if (value === true) {
      rules.push({ pattern: globToRegExp(glob) })
    } else if (value && typeof value === 'object' && typeof value.when === 'string') {
      rules.push({ pattern: globToRegExp(glob), when: value.when })
    }
  }
  return rules
}

export function isExcluded(rules: readonly ExcludeRule[], path: string, name: string, siblings: ReadonlySet<string>): boolean {
  return rules.some(({ pattern, when }) => pattern.test(path) && (when === undefined || siblings.has(sibling(when, name))))
}

function sibling(when: string, name: string): string {
  const dot = name.lastIndexOf('.')
  return when.replaceAll('$(basename)', dot > 0 ? name.slice(0, dot) : name)
}

// VS Code's glob.ts: segments joined by '/', '**' spans whole segments (and, last, the folder itself), matched against the whole path.
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob.replace(/^\.\//, '').replace(/\/+$/, ''))}$`)
}

function globSource(glob: string): string {
  const segments = splitSegments(glob)
  let source = ''
  let afterGlobstar = false
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      if (!afterGlobstar) {
        source += `(?:/|${NO_SEP}+/${last ? `|/${NO_SEP}+` : ''})*?`
      }
      afterGlobstar = true
      return
    }
    afterGlobstar = false
    source += segmentToRegExp(segment)
    if (!last && (segments[index + 1] !== '**' || index + 2 < segments.length)) {
      source += '/'
    }
  })
  return source
}

function splitSegments(glob: string): string[] {
  const segments = ['']
  let depth = 0
  for (const char of glob) {
    if (char === '{' || char === '[') {
      depth++
    } else if ((char === '}' || char === ']') && depth > 0) {
      depth--
    }
    if (char === '/' && depth === 0) {
      segments.push('')
    } else {
      segments[segments.length - 1] += char
    }
  }
  return segments
}

function segmentToRegExp(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!
    if (char === '*') {
      while (segment[i + 1] === '*') {
        i++
      }
      out += `${NO_SEP}*?`
    } else if (char === '?') {
      out += NO_SEP
    } else if (char === '{') {
      const close = segment.indexOf('}', i)
      if (close < 0) {
        out += '\\{'
        continue
      }
      const options = segment.slice(i + 1, close).split(',')
      out += `(?:${options.map(globSource).join('|')})`
      i = close
    } else if (char === '[') {
      const close = segment.indexOf(']', i + 1)
      if (close < 0) {
        out += '\\['
        continue
      }
      const body = segment.slice(i + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      const chars = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&')
      out += negated ? `[^/${chars}]` : `[${chars}]`
      i = close
    } else {
      out += char.replace(/[.+^$()|\\]/g, '\\$&')
    }
  }
  return out
}
