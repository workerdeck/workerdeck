/**
 * The workspace's file-rail layout, remembered across navigations.
 *
 * The rail is component state inside `SessionWorkspace` — deliberately, since
 * where to persist it is the embedder's call. On a router-driven dashboard the
 * session view unmounts every time you go back to the list, so without this the
 * rail resets to its default width on every visit.
 */
const KEY = 'workerdeck.rail'

export type Rail = { width: number; collapsed: boolean }

const DEFAULT: Rail = { width: 260, collapsed: false }

export function getRail(): Rail {
  try {
    const raw = localStorage.getItem(KEY)
    const stored = raw ? (JSON.parse(raw) as Partial<Rail>) : {}
    return {
      // Clamped to the splitter's own bounds: a stored width from an older
      // build (or a hand-edited entry) must not render an unusable rail.
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
  } catch {
    /* private mode — the layout still holds for this page */
  }
}
