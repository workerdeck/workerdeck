// Every preference this dashboard keeps lives in localStorage, and every one of them has to
// survive a browser that throws on access (Safari private mode, storage disabled by policy).
// These four functions are the only place that try/catch is written.

/** The stored string, or undefined if absent — or if storage itself is unavailable. */
export function readPref(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** Write a preference; `undefined` removes it. Never throws. */
export function writePref(key: string, value: string | undefined): void {
  try {
    if (value === undefined) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {}
}

/**
 * A stored JSON value, or `fallback` when it is absent or unparseable. Callers state the
 * shape they expect — usually a partial they then merge over their own defaults, since
 * nothing validates what a previous version (or a hand edit) left behind.
 */
export function readJson<T>(key: string, fallback: T): T {
  const raw = readPref(key)
  if (raw === undefined) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  writePref(key, JSON.stringify(value))
}
