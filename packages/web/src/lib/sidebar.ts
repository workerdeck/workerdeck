/**
 * Per-section sidebar geometry, remembered across navigations and reloads.
 *
 * Every nav entry now has a sidebar of its own — sessions, gateways, jobs,
 * profiles — and each remembers its **own** width and collapsed state. One
 * shared number would be wrong the moment two sections want different widths,
 * which they do: a job list is narrow, a session list is not.
 *
 * Same contract as `rail.ts`: clamped to the splitter's bounds on read, so a
 * width stored by an older build (or a hand-edited entry) can never render a
 * sidebar too narrow to use or wide enough to crowd out the detail pane.
 */
export type SidebarSection = 'sessions' | 'gateways' | 'jobs' | 'profiles'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 520
const DEFAULT = 300

/**
 * Sessions keeps the key it had when it was the only sidebar, so a width chosen
 * before this file was per-section survives the upgrade rather than snapping
 * back to the default.
 */
const widthKey = (section: SidebarSection) =>
  section === 'sessions'
    ? 'workerdeck.sessions-sidebar-width'
    : `workerdeck.${section}-sidebar-width`

const collapsedKey = (section: SidebarSection) =>
  section === 'sessions'
    ? 'workerdeck.sessions-sidebar-collapsed'
    : `workerdeck.${section}-sidebar-collapsed`

export function getSidebarWidth(section: SidebarSection): number {
  try {
    const stored = Number(localStorage.getItem(widthKey(section)))
    return stored ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored)) : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function setSidebarWidth(section: SidebarSection, width: number): void {
  try {
    localStorage.setItem(widthKey(section), String(width))
  } catch {
    /* private mode — the layout still holds for this page */
  }
}

/**
 * Whether the section's sidebar is collapsed to its icon rail.
 *
 * Distinct from the width above rather than encoded as "width 0": expanding has
 * to restore the width the reader chose, and a collapsed rail is a different
 * layout, not a narrow one.
 */
export function getSidebarCollapsed(section: SidebarSection): boolean {
  try {
    return localStorage.getItem(collapsedKey(section)) === '1'
  } catch {
    return false
  }
}

export function setSidebarCollapsed(section: SidebarSection, collapsed: boolean): void {
  try {
    localStorage.setItem(collapsedKey(section), collapsed ? '1' : '0')
  } catch {
    /* private mode — the preference just won't persist */
  }
}

/**
 * Whether the sessions filter bar is open.
 *
 * Sessions-only, and **separate from the filters themselves** — closing the bar
 * hides the controls, it does not clear what they were set to. Defaults closed,
 * because the list is the thing worth showing in a sidebar this narrow; the
 * subset line under it is what says a filter is on.
 */
const FILTERS_KEY = 'workerdeck.sessions-filters-shown'

export function getFiltersShown(): boolean {
  try {
    return localStorage.getItem(FILTERS_KEY) === '1'
  } catch {
    return false
  }
}

export function setFiltersShown(shown: boolean): void {
  try {
    localStorage.setItem(FILTERS_KEY, shown ? '1' : '0')
  } catch {
    /* private mode — the preference just won't persist */
  }
}
