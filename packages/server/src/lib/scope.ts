const MAX_SCOPE_KEYS = 16
const MAX_SCOPE_LEN = 200

export const readScope = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, v]) => typeof v !== 'string')) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

export const checkScope = (value: unknown): string | null => {
  if (value === undefined) {
    return null
  }
  const scope = readScope(value)
  if (!scope) {
    return 'scope must be an object of string values'
  }
  const entries = Object.entries(scope)
  if (entries.length > MAX_SCOPE_KEYS) {
    return `scope may carry at most ${MAX_SCOPE_KEYS} keys`
  }
  for (const [key, val] of entries) {
    if (key.length === 0) {
      return 'scope keys must not be empty'
    }
    if (key.length > MAX_SCOPE_LEN || val.length > MAX_SCOPE_LEN) {
      return `scope keys and values must be at most ${MAX_SCOPE_LEN} characters`
    }
  }
  return null
}

export const sameScope = (a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean => {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  const right = Object.entries(b ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  return left.length === right.length && left.every(([key, value], i) => right[i]![0] === key && right[i]![1] === value)
}

export const scopeMatches = (principal: Record<string, string> | undefined, session: Record<string, string> | undefined): boolean => {
  if (!principal) {
    return true
  }
  return Object.entries(principal).every(([key, value]) => session?.[key] === value)
}
