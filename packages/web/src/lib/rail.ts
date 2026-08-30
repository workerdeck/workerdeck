/**
 * The workspace's file-rail layout. The rail is component state inside
 * `SessionWorkspace` — where to persist it is the embedder's call — and this view
 * unmounts on every trip back to the list.
 */
const KEY = 'workerdeck.rail'

export type Rail = { width: number; collapsed: boolean }

const DEFAULT: Rail = { width: 260, collapsed: false }

export const getRail = (): Rail => {
  try {
    const raw = localStorage.getItem(KEY)
    const stored = raw ? (JSON.parse(raw) as Partial<Rail>) : {}
    return {
      // Clamped to the splitter's bounds: a stale or hand-edited width must not render an unusable rail.
      width: Math.min(520, Math.max(180, Number(stored.width) || DEFAULT.width)),
      collapsed: stored.collapsed === true,
    }
  } catch {
    return DEFAULT
  }
}

export const setRail = (rail: Rail): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(rail))
  } catch {
    /* private mode — the layout still holds for this page */
  }
}
