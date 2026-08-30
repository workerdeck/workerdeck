/**
 * The scope rules — opaque tags assigned at create, immutable after, and the
 * only intra-deployment scoping primitive there is. WorkerDeck stores and
 * enforces the tags; the embedder's `authorizeSession` decides what they mean.
 */

/** Most tags one session (or one principal) may carry, and the longest a key or
 * value may be. Not a security property — a bound so an opaque map cannot become
 * an unbounded store that every list response then carries. */
const MAX_SCOPE_KEYS = 16
const MAX_SCOPE_LEN = 200

/** A `Record<string, string>` or nothing. Duck-typed the same way
 * `allowedProfiles` is: a malformed value is ignored, never half-applied. */
export function readScope(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, v]) => typeof v !== 'string')) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** Validate a caller-supplied scope. Returns an error string, or null when it is
 * well-formed (including when it is absent). */
export function checkScope(value: unknown): string | null {
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

/** Key-order-independent equality — a host runner that rebuilt the record
 * rather than echoing the reference must still pass the build-time check. */
export function sameScope(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  const right = Object.entries(b ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  return left.length === right.length && left.every(([key, value], i) => right[i]![0] === key && right[i]![1] === value)
}

/**
 * The default visibility rule, used whenever the host supplies no
 * `authorizeSession`: every key the principal pins must match the session's, and
 * an unset principal scope sees everything.
 *
 * The asymmetry is intended — a session may carry tags the principal says
 * nothing about (an app that tags `{space, user, conversation}` while the
 * principal only pins `{space, user}` still works), but a session missing a key
 * the principal pins is not this caller's.
 */
export function scopeMatches(principal: Record<string, string> | undefined, session: Record<string, string> | undefined): boolean {
  if (!principal) {
    return true
  }
  return Object.entries(principal).every(([key, value]) => session?.[key] === value)
}
