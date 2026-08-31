const KEY = 'workerdeck.rail'

export type Rail = { width: number; collapsed: boolean }

const DEFAULT: Rail = { width: 260, collapsed: false }

export function getRail(): Rail {
  try {
    const raw = localStorage.getItem(KEY)
    const stored = raw ? (JSON.parse(raw) as Partial<Rail>) : {}
    return {
      width: Math.min(520, Math.max(180, Number(stored.width) || DEFAULT.width)),
      collapsed: stored.collapsed === true,
    }
  } catch {
    return DEFAULT
  }
}

export function setRail(rail: Rail): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rail))
  } catch {}
}
