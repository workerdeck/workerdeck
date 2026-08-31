export type SidebarSection = 'sessions' | 'gateways' | 'jobs' | 'profiles'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 300

// Sessions keeps the key it had when it was the only sidebar, so stored widths survive.
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
  } catch {}
}

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
  } catch {}
}

// Separate from the filters themselves: closing the bar hides the controls, it does not clear them.
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
  } catch {}
}
