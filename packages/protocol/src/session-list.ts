import type { SessionInfo, SubagentInfo } from './index.ts'

export type SessionState = 'attention' | 'working' | 'idle' | 'ended'

export const STATE_ORDER: readonly SessionState[] = ['attention', 'working', 'idle', 'ended']

export const STATE_LABELS: Record<SessionState, string> = {
  attention: 'Needs attention',
  working: 'Working',
  idle: 'Idle',
  ended: 'Ended',
}

export function sessionState(info: SessionInfo): SessionState {
  if (info.pendingPermissionCount > 0 || info.status === 'awaiting_approval') {
    return 'attention'
  }
  if (info.status === 'failed' || info.status === 'closed') {
    return 'ended'
  }
  if (info.status === 'running' || info.status === 'starting') {
    return 'working'
  }
  if (runningSubagents(info).length > 0) {
    return 'working'
  }
  return 'idle'
}

export function runningSubagents(info: SessionInfo): SubagentInfo[] {
  return (info.subagents ?? []).filter((sub) => sub.status === 'running')
}

export function isAgentRecord(sub: SubagentInfo): boolean {
  return (sub.agentType?.trim() ?? '') !== ''
}

export function subagentLabel(sub: SubagentInfo): string {
  const agent = sub.agentType?.trim()
  const description = sub.description?.trim()
  if (agent && description) {
    return `${agent} · ${description}`
  }
  return agent || description || 'Sub-agent'
}

export type Facet = 'gateway' | 'adapter' | 'state' | 'project'
export type GroupBy = 'none' | Facet
export type SortBy = 'recent' | 'name' | Facet

export type ViewConfig = {
  search: string
  gateways: string[]
  adapters: string[]
  states: SessionState[]
  projects?: string[]
  scoped: boolean
  groupBy: GroupBy
  sortBy: SortBy
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  search: '',
  gateways: [],
  adapters: [],
  states: [],
  projects: [],
  scoped: true,
  groupBy: 'state',
  sortBy: 'recent',
}

export type ScopeRoot = { hostId?: string; path: string }

export type WorkspaceScope = { label: string; roots: ScopeRoot[] }

export type SessionRow = {
  hostId: string
  hostName: string
  local: boolean
  adapter: string
  state: SessionState
  info: SessionInfo
  /**
   * Messages this client has not read — `unseenCount` against its watermark, so the
   * unit is prose (`SessionInfo.proseCount`) wherever the gateway reports it. A session
   * that is only running tools contributes 0: the badge answers "is there something to
   * read", not "is anything happening", which is what `state` is for.
   */
  unseen: number
}

export type SessionGroup = { key: string; label?: string; rows: SessionRow[] }

export function adaptersOf(rows: readonly SessionRow[]): string[] {
  return [...new Set(rows.map((r) => r.adapter))].sort()
}

export function projectsOf(rows: readonly SessionRow[]): { key: string; label: string }[] {
  const byKey = new Map<string, string>()
  for (const row of rows) {
    byKey.set(projectKey(row), projectLabel(row))
  }
  return [...byKey].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

export function sessionLabel(info: SessionInfo): string {
  return info.title ?? info.id.slice(0, 8)
}

export function projectKey(row: SessionRow): string {
  return `${row.hostId}:${normalizePath(row.info.project?.root ?? row.info.cwd)}`
}

export function projectLabel(row: Pick<SessionRow, 'info'>): string {
  const name = row.info.project?.name
  if (name) {
    return name
  }
  const dir = normalizePath(row.info.cwd)
  return dir.slice(dir.lastIndexOf('/') + 1) || 'No project'
}

export function projectSubpath(row: Pick<SessionRow, 'info'>): string | undefined {
  const root = row.info.project?.root
  if (root === undefined || !row.info.cwd) {
    return undefined
  }
  const base = normalizePath(root)
  const dir = normalizePath(row.info.cwd)
  if (dir === base) {
    return undefined
  }
  if (!dir.startsWith(`${base}/`)) {
    return undefined
  }
  return dir.slice(base.length + 1) || undefined
}

export function isJobRun(info: SessionInfo): boolean {
  return typeof info.meta?.jobId === 'string'
}

function matchesSearch(row: SessionRow, needle: string): boolean {
  if (!needle) {
    return true
  }
  return (
    sessionLabel(row.info).toLowerCase().includes(needle) ||
    row.info.cwd.toLowerCase().includes(needle) ||
    (row.info.project?.name.toLowerCase().includes(needle) ?? false) ||
    row.hostName.toLowerCase().includes(needle) ||
    row.adapter.toLowerCase().includes(needle) ||
    row.info.id.startsWith(needle)
  )
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isWithin(root: string, path: string): boolean {
  const base = normalizePath(root)
  const dir = normalizePath(path)
  // The separator matters: /a/project must not swallow /a/project-2.
  return dir === base || dir.startsWith(`${base}/`)
}

export function inScope(row: SessionRow, scope: WorkspaceScope): boolean {
  return scope.roots.some(
    (root) => (root.hostId ? root.hostId.toLowerCase() === row.hostId.toLowerCase() : row.local) && isWithin(root.path, row.info.cwd),
  )
}

export function scopeActive(config: ViewConfig, scope: WorkspaceScope | undefined): boolean {
  return config.scoped && scope !== undefined
}

export function filterRows(rows: readonly SessionRow[], config: ViewConfig, scope?: WorkspaceScope): SessionRow[] {
  const needle = config.search.trim().toLowerCase()
  const scoping = scopeActive(config, scope) ? scope : undefined
  return rows.filter(
    (row) =>
      (config.gateways.length === 0 || config.gateways.includes(row.hostId)) &&
      (config.adapters.length === 0 || config.adapters.includes(row.adapter)) &&
      (config.states.length === 0 || config.states.includes(row.state)) &&
      (!config.projects?.length || config.projects.includes(projectKey(row))) &&
      (!scoping || inScope(row, scoping)) &&
      matchesSearch(row, needle),
  )
}

function facetKey(row: SessionRow, facet: Facet): string {
  return facet === 'gateway' ? row.hostId : facet === 'adapter' ? row.adapter : facet === 'project' ? projectKey(row) : row.state
}

function facetLabel(row: SessionRow, facet: Facet): string {
  return facet === 'gateway'
    ? row.hostName
    : facet === 'adapter'
      ? row.adapter
      : facet === 'project'
        ? projectLabel(row)
        : STATE_LABELS[row.state]
}

function facetRank(row: SessionRow, facet: Facet): string {
  if (facet === 'state') {
    return String(STATE_ORDER.indexOf(row.state))
  }
  return facetLabel(row, facet).toLowerCase()
}

function byRecency(a: SessionRow, b: SessionRow) {
  return (b.info.lastActivityAt ?? b.info.createdAt) - (a.info.lastActivityAt ?? a.info.createdAt)
}

function compare(a: SessionRow, b: SessionRow, sortBy: SortBy): number {
  if (sortBy === 'recent') {
    return byRecency(a, b)
  }
  if (sortBy === 'name') {
    return (
      sessionLabel(a.info).localeCompare(sessionLabel(b.info), undefined, {
        sensitivity: 'base',
      }) || byRecency(a, b)
    )
  }
  return facetRank(a, sortBy).localeCompare(facetRank(b, sortBy)) || byRecency(a, b)
}

export function groupRows(rows: readonly SessionRow[], config: ViewConfig): SessionGroup[] {
  const sorted = [...rows].sort((a, b) => compare(a, b, config.sortBy))
  if (config.groupBy === 'none') {
    return sorted.length ? [{ key: 'all', rows: sorted }] : []
  }
  const facet = config.groupBy
  const groups = new Map<string, SessionGroup & { rank: string }>()
  for (const row of sorted) {
    const key = facetKey(row, facet)
    const group = groups.get(key)
    if (group) {
      group.rows.push(row)
    } else {
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

export type SubsetSummary = { shown: number; total: number; causes: string[] }

export function subsetSummary(
  config: ViewConfig,
  scope: WorkspaceScope | undefined,
  shown: number,
  total: number,
): SubsetSummary | undefined {
  if (shown >= total) {
    return undefined
  }
  const causes: string[] = []
  if (scope && scopeActive(config, scope)) {
    causes.push(scope.label)
  }
  const facets =
    (config.gateways.length ? 1 : 0) + (config.adapters.length ? 1 : 0) + (config.states.length ? 1 : 0) + (config.projects?.length ? 1 : 0)
  if (facets > 0) {
    causes.push(`${facets} filter${facets === 1 ? '' : 's'}`)
  }
  if (config.search.trim()) {
    causes.push('search')
  }
  return { shown, total, causes }
}

export function hasFacetFilter(config: ViewConfig): boolean {
  return (
    config.search.trim().length > 0 ||
    config.gateways.length > 0 ||
    config.adapters.length > 0 ||
    config.states.length > 0 ||
    (config.projects?.length ?? 0) > 0
  )
}

export function clearFilters(config: ViewConfig): ViewConfig {
  return {
    ...DEFAULT_VIEW_CONFIG,
    scoped: false,
    groupBy: config.groupBy,
    sortBy: config.sortBy,
  }
}
