import type { SessionInfo } from './index.ts'

/**
 * How a sessions list is filtered, grouped and sorted — the whole of the view
 * config, kept pure and separate from the components so every surface renders
 * one derived list and nothing else decides what is visible.
 *
 * Framework-free like `transcript.ts`, and for the same reason: more than one
 * party has to agree. In the VS Code extension the webview renders the list and
 * the extension host counts the activity-bar badge over the same rows (a badge
 * that ignored the filter would announce work in sessions the list is
 * deliberately hiding); in the dashboard the list and its subset line derive
 * from it; on iOS it is mirrored to Swift the way the reducer is.
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
  /** Show only sessions inside the host's own folders. Inert where there is no
   * such notion (no folder open, a dashboard with no workspace), which is why it
   * can default on. */
  scoped: boolean
  groupBy: GroupBy
  sortBy: SortBy
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  search: '',
  gateways: [],
  adapters: [],
  states: [],
  scoped: true,
  groupBy: 'state',
  sortBy: 'recent',
}

/**
 * One folder the surrounding host has open, as a place sessions can live in.
 *
 * `hostId` present = the folder belongs to exactly that gateway. Absent = a real
 * local folder, which only a loopback gateway's cwds can be inside: a remote
 * gateway's paths are on another machine, where an identical-looking path means
 * nothing.
 */
export type ScopeRoot = { hostId?: string; path: string }

/** The host's own folders — the sessions list's intrinsic scope. */
export type WorkspaceScope = { label: string; roots: ScopeRoot[] }

/** A session with everything the list needs to filter, group and label it. */
export type SessionRow = {
  hostId: string
  hostName: string
  /** Its gateway is loopback — its cwds are paths on this machine. */
  local: boolean
  adapter: string
  state: SessionState
  info: SessionInfo
  /** Transcript rows since this session was last on screen. 0 = nothing new (or
   * never visited, which is not the same as unread). */
  unseen: number
}

export type SessionGroup = { key: string; label?: string; rows: SessionRow[] }

/** The adapters actually present, for the filter chips — derived rather than
 * enumerated, so a new engine needs no change here. */
export function adaptersOf(rows: readonly SessionRow[]): string[] {
  return [...new Set(rows.map((r) => r.adapter))].sort()
}

export function sessionLabel(info: SessionInfo): string {
  return info.title ?? info.id.slice(0, 8)
}

/**
 * This session is a job run — the queue created it, and `JobInfo.sessionId`
 * points at it.
 *
 * A job run is an ordinary registry session in every other respect, which is
 * what makes this worth spelling once: a client that renders jobs on their own
 * surface should not list them again among the sessions, and a client with no
 * jobs surface (the extension, the phone) should, or they would be invisible.
 * The queue stamps `meta.jobId`; nothing else may write that key.
 */
export function isJobRun(info: SessionInfo): boolean {
  return typeof info.meta?.jobId === 'string'
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

/** Trailing separators dropped and separators unified, so containment is a
 * plain prefix test on both a posix and a Windows gateway. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isWithin(root: string, path: string): boolean {
  const base = normalizePath(root)
  const dir = normalizePath(path)
  // The separator matters: /a/project must not swallow /a/project-2.
  return dir === base || dir.startsWith(`${base}/`)
}

/**
 * Is this session inside one of the host's folders? A gateway-tagged root only
 * ever matches its own gateway; an untagged one only matches a loopback gateway,
 * because a remote gateway's identical-looking path is a different machine's
 * directory.
 */
export function inScope(row: SessionRow, scope: WorkspaceScope): boolean {
  return scope.roots.some(
    (root) =>
      (root.hostId ? root.hostId.toLowerCase() === row.hostId.toLowerCase() : row.local) &&
      isWithin(root.path, row.info.cwd),
  )
}

/** Whether the scope filter is actually hiding anything — it is inert with no
 * folder open, and that is the difference between a default and a filter. */
export function scopeActive(config: ViewConfig, scope: WorkspaceScope | undefined): boolean {
  return config.scoped && scope !== undefined
}

export function filterRows(
  rows: readonly SessionRow[],
  config: ViewConfig,
  scope?: WorkspaceScope,
): SessionRow[] {
  const needle = config.search.trim().toLowerCase()
  const scoping = scopeActive(config, scope) ? scope : undefined
  return rows.filter(
    (row) =>
      (config.gateways.length === 0 || config.gateways.includes(row.hostId)) &&
      (config.adapters.length === 0 || config.adapters.includes(row.adapter)) &&
      (config.states.length === 0 || config.states.includes(row.state)) &&
      (!scoping || inScope(row, scoping)) &&
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

/**
 * What the list is hiding, and why — the one "you are seeing a subset" signal.
 *
 * There used to be two: a dot on the funnel and a scope line above the list.
 * They competed (the scope line said one thing, the dot counted a superset of
 * it) and neither said how much was missing. This is the single rule both the
 * count and the wording come from: absent when nothing is hidden, and otherwise
 * naming every cause, so the line is never "12 of 30" with no way to guess why.
 *
 * Search is a cause like any other. Its box is visible, but the *consequence*
 * of it — rows gone from the list — is the thing being reported, and leaving it
 * out would make the arithmetic wrong.
 */
export type SubsetSummary = { shown: number; total: number; causes: string[] }

export function subsetSummary(
  config: ViewConfig,
  scope: WorkspaceScope | undefined,
  shown: number,
  total: number,
): SubsetSummary | undefined {
  if (shown >= total) return undefined
  const causes: string[] = []
  if (scope && scopeActive(config, scope)) causes.push(scope.label)
  // The facets collapse to a count: naming three of them would wrap the line in
  // a sidebar, and the funnel beside it is where their detail already lives.
  const facets =
    (config.gateways.length ? 1 : 0) +
    (config.adapters.length ? 1 : 0) +
    (config.states.length ? 1 : 0)
  if (facets > 0) causes.push(`${facets} filter${facets === 1 ? '' : 's'}`)
  if (config.search.trim()) causes.push('search')
  return { shown, total, causes }
}

/**
 * Is anything OTHER than the workspace scope narrowing the list?
 *
 * The distinction an empty list turns on: "this project has no sessions" wants a
 * different sentence, and a different way out, from "your filters match none".
 * Scope is excluded because it is on by default — it is the state, not a choice
 * someone made.
 */
export function hasFacetFilter(config: ViewConfig): boolean {
  return (
    config.search.trim().length > 0 ||
    config.gateways.length > 0 ||
    config.adapters.length > 0 ||
    config.states.length > 0
  )
}

/** "Show me everything": every filter off, including scope. The group/sort
 * choices are a layout preference and survive. */
export function clearFilters(config: ViewConfig): ViewConfig {
  return {
    ...DEFAULT_VIEW_CONFIG,
    scoped: false,
    groupBy: config.groupBy,
    sortBy: config.sortBy,
  }
}
