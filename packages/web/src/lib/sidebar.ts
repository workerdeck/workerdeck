import { readPref, writePref } from './storage.ts'

export type SidebarSection = 'sessions' | 'gateways' | 'jobs' | 'profiles'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 300

// Sessions keeps the key it had when it was the only sidebar, so stored widths survive.
function widthKey(section: SidebarSection): string {
  return section === 'sessions' ? 'workerdeck.sessions-sidebar-width' : `workerdeck.${section}-sidebar-width`
}

function collapsedKey(section: SidebarSection): string {
  return section === 'sessions' ? 'workerdeck.sessions-sidebar-collapsed' : `workerdeck.${section}-sidebar-collapsed`
}

export function getSidebarWidth(section: SidebarSection): number {
  const stored = Number(readPref(widthKey(section)))
  return stored ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored)) : SIDEBAR_DEFAULT
}

export function setSidebarWidth(section: SidebarSection, width: number): void {
  writePref(widthKey(section), String(width))
}

export function getSidebarCollapsed(section: SidebarSection): boolean {
  return readPref(collapsedKey(section)) === '1'
}

export function setSidebarCollapsed(section: SidebarSection, collapsed: boolean): void {
  writePref(collapsedKey(section), collapsed ? '1' : '0')
}

// Separate from the filters themselves: closing the bar hides the controls, it does not clear them.
const FILTERS_KEY = 'workerdeck.sessions-filters-shown'

export function getFiltersShown(): boolean {
  return readPref(FILTERS_KEY) === '1'
}

export function setFiltersShown(shown: boolean): void {
  writePref(FILTERS_KEY, shown ? '1' : '0')
}
