import type { SessionInfo } from '@workerdeck/protocol'
import type { SidebarState } from '../../src/bridge-protocol.ts'

/**
 * How the sessions list is filtered, grouped and sorted — the whole of the view
 * config, kept pure and separate from the components so the sidebar renders one
 * derived list and nothing else decides what is visible.
 *
 * Sessions are shown across ALL gateways by default; the gateway is a facet like
 * any other, not the frame the list lives in.
 */

/** Coarse lifecycle bucket — what a person actually filters on. Raw statuses are
 * too many and too engine-shaped ('starting' vs 'running' is not a decision). */
export type SessionState = 'attention' | 'working' | 'idle' | 'ended'

export const STATE_ORDER: readonly SessionState[] = ['attention', 'working', 'idle', 'ended']

export const STATE_LABELS: Record<SessionState, string> = {
  attention: 'Needs attention',
  working: 'Working',
  idle: 'Idle',
  ended: 'Ended',
}

export function sessionState(info: SessionInfo): SessionState {
  if (info.pendingPermissionCount > 0 || info.status === 'awaiting_approval') return 'attention'
  if (info.status === 'running' || info.status === 'starting') return 'working'
  if (info.status === 'failed' || info.status === 'closed') return 'ended'
  return 'idle'
}

/** The facets a session can be grouped or sorted by. */
export type Facet = 'gateway' | 'adapter' | 'state'
export type GroupBy = 'none' | Facet
export type SortBy = 'recent' | 'name' | Facet

export type ViewConfig = {
  search: string
  /** Empty = no filter. Ids, not names: names are editable. */
  gateways: string[]
  adapters: string[]
  states: SessionState[]
  groupBy: GroupBy
  sortBy: SortBy
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  search: '',
  gateways: [],
  adapters: [],
  states: [],
  groupBy: 'state',
  sortBy: 'recent',
}

/** A session with everything the list needs to filter, group and label it. */
export type SessionRow = {
  hostId: string
  hostName: string
  adapter: string
  state: SessionState
  info: SessionInfo
}

export type SessionGroup = { key: string; label?: string; rows: SessionRow[] }

/** Every connected gateway's sessions, flattened. Recency order is preserved
 * from the model, so it survives as the tiebreak through every sort. */
export function buildRows(state: SidebarState | undefined): SessionRow[] {
  if (!state) return []
  const rows: SessionRow[] = []
  for (const host of state.hosts) {
    for (const info of state.sessions[host.id] ?? []) {
      rows.push({
        hostId: host.id,
        hostName: host.name,
        adapter: info.engine ?? 'claude',
        state: sessionState(info),
        info,
      })
    }
  }
  return rows
}

/** The adapters actually present, for the filter chips — derived rather than
 * enumerated, so a new engine needs no change here. */
export function adaptersOf(rows: readonly SessionRow[]): string[] {
  return [...new Set(rows.map((r) => r.adapter))].sort()
}

export function sessionLabel(info: SessionInfo): string {
  return info.title ?? info.id.slice(0, 8)
}

function matchesSearch(row: SessionRow, needle: string): boolean {
  if (!needle) return true
  return (
    sessionLabel(row.info).toLowerCase().includes(needle) ||
    row.info.cwd.toLowerCase().includes(needle) ||
    row.hostName.toLowerCase().includes(needle) ||
    row.adapter.toLowerCase().includes(needle) ||
    row.info.id.startsWith(needle)
  )
}

export function filterRows(rows: readonly SessionRow[], config: ViewConfig): SessionRow[] {
  const needle = config.search.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (config.gateways.length === 0 || config.gateways.includes(row.hostId)) &&
      (config.adapters.length === 0 || config.adapters.includes(row.adapter)) &&
      (config.states.length === 0 || config.states.includes(row.state)) &&
      matchesSearch(row, needle),
  )
}

function facetKey(row: SessionRow, facet: Facet): string {
  return facet === 'gateway' ? row.hostId : facet === 'adapter' ? row.adapter : row.state
}

function facetLabel(row: SessionRow, facet: Facet): string {
  return facet === 'gateway'
    ? row.hostName
    : facet === 'adapter'
      ? row.adapter
      : STATE_LABELS[row.state]
}

/** Comparable rank for a facet: states run worst-first (attention before ended),
 * the rest alphabetically by their visible label. */
function facetRank(row: SessionRow, facet: Facet): string {
  if (facet === 'state') return String(STATE_ORDER.indexOf(row.state))
  return facetLabel(row, facet).toLowerCase()
}

const byRecency = (a: SessionRow, b: SessionRow) =>
  (b.info.lastActivityAt ?? b.info.createdAt) - (a.info.lastActivityAt ?? a.info.createdAt)

function compare(a: SessionRow, b: SessionRow, sortBy: SortBy): number {
  if (sortBy === 'recent') return byRecency(a, b)
  if (sortBy === 'name') {
    return (
      sessionLabel(a.info).localeCompare(sessionLabel(b.info), undefined, {
        sensitivity: 'base',
      }) || byRecency(a, b)
    )
  }
  return facetRank(a, sortBy).localeCompare(facetRank(b, sortBy)) || byRecency(a, b)
}

/**
 * The list as rendered: filtered, grouped, and sorted within each group. Groups
 * themselves come out in the sort's own order — grouping by state and sorting by
 * name should still put "Needs attention" first, so groups are ordered by their
 * facet rank, never by the row sort.
 */
export function groupRows(rows: readonly SessionRow[], config: ViewConfig): SessionGroup[] {
  const sorted = [...rows].sort((a, b) => compare(a, b, config.sortBy))
  if (config.groupBy === 'none') return sorted.length ? [{ key: 'all', rows: sorted }] : []
  const facet = config.groupBy
  const groups = new Map<string, SessionGroup & { rank: string }>()
  for (const row of sorted) {
    const key = facetKey(row, facet)
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else {
      groups.set(key, {
        key,
        label: facetLabel(row, facet),
        rank: facetRank(row, facet),
        rows: [row],
      })
    }
  }
  return [...groups.values()].sort((a, b) => a.rank.localeCompare(b.rank))
}

/** Whether the config hides anything — what the header icon's dot reports. */
export function isFiltering(config: ViewConfig): boolean {
  return (
    config.search.trim().length > 0 ||
    config.gateways.length > 0 ||
    config.adapters.length > 0 ||
    config.states.length > 0
  )
}

/** Toggle one value of a multi-select facet filter (empty array = "all"). */
export function toggleFilter<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}
