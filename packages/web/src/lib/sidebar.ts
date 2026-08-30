/**
 * Per-section sidebar geometry. Each nav entry remembers its **own** width and
 * collapsed state — one shared number is wrong the moment two sections want
 * different widths. Clamped to the splitter's bounds on read, like `rail.ts`.
 */
export type SidebarSection = 'sessions' | 'gateways' | 'jobs' | 'profiles'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 520
/** Also what a double-click on the splitter snaps back to. */
export const SIDEBAR_DEFAULT = 300

/** Sessions keeps the key it had when it was the only sidebar, so stored widths survive. */
const widthKey = (section: SidebarSection): string =>
  section === 'sessions' ? 'workerdeck.sessions-sidebar-width' : `workerdeck.${section}-sidebar-width`

const collapsedKey = (section: SidebarSection): string =>
  section === 'sessions' ? 'workerdeck.sessions-sidebar-collapsed' : `workerdeck.${section}-sidebar-collapsed`

export const getSidebarWidth = (section: SidebarSection): number => {
  try {
    const stored = Number(localStorage.getItem(widthKey(section)))
    return stored ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored)) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export const setSidebarWidth = (section: SidebarSection, width: number): void => {
  try {
    localStorage.setItem(widthKey(section), String(width))
  } catch {
    /* private mode — the layout still holds for this page */
  }
}

/**
 * Distinct from the width rather than encoded as "width 0": expanding has to
 * restore the width the reader chose, and a collapsed rail is a different layout.
 */
export const getSidebarCollapsed = (section: SidebarSection): boolean => {
  try {
    return localStorage.getItem(collapsedKey(section)) === '1'
  } catch {
    return false
  }
}

export const setSidebarCollapsed = (section: SidebarSection, collapsed: boolean): void => {
  try {
    localStorage.setItem(collapsedKey(section), collapsed ? '1' : '0')
  } catch {
    /* private mode — the preference just won't persist */
  }
}

/**
 * Whether the sessions filter bar is open — **separate from the filters
 * themselves**: closing the bar hides the controls, it does not clear them. The
 * subset line under the bar is what says a filter is on.
 */
const FILTERS_KEY = 'workerdeck.sessions-filters-shown'

export const getFiltersShown = (): boolean => {
  try {
    return localStorage.getItem(FILTERS_KEY) === '1'
  } catch {
    return false
  }
}

export const setFiltersShown = (shown: boolean): void => {
  try {
    localStorage.setItem(FILTERS_KEY, shown ? '1' : '0')
  } catch {
    /* private mode — the preference just won't persist */
  }
}
