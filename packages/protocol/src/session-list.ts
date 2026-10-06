import { projectAccent } from './agents.ts'
import { SHELL_LINGER_MS, SHELL_PROMOTE_MS } from './index.ts'
import type { GatewayRelayMeta, SessionInfo, ShellInfo, SubagentInfo } from './index.ts'

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

export function visibleSubagents(info: SessionInfo, show: SubagentDisplay): SubagentInfo[] {
  if (show === 'none') {
    return []
  }
  const subagents = info.subagents ?? []
  return show === 'all' ? [...subagents] : subagents.filter((sub) => sub.status === 'running')
}

export function isAgentRecord(sub: SubagentInfo): boolean {
  return sub.isAgent === true || (sub.agentType?.trim() ?? '') !== ''
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
export type GroupBy = 'none' | 'state' | 'adapter' | 'project' | 'custom'
export type SortBy = 'recent' | 'name' | Facet

export const GROUP_BY: readonly GroupBy[] = ['none', 'state', 'adapter', 'project', 'custom']

// `members` are `sessionKey` values, in the order the group draws them. `color` is the badge colour (one of
// `PROJECT_ACCENTS` from the pickers, any CSS colour accepted); `icon` an image the operator chose, as a small data URL,
// drawn instead of the colour.
export type CustomGroup = { id: string; name: string; members: string[]; color?: string; icon?: string }

// The largest `icon` data URL a client stores: a 64 px PNG fits many times over, a raw photo does not.
export const CUSTOM_GROUP_ICON_MAX = 48_000

// How much of one of a card's child lists it draws. A layout preference, not a facet filter.
export type StepDisplay = 'all' | 'active' | 'none'

export type SubagentDisplay = StepDisplay

export type ViewConfig = {
  search: string
  gateways: string[]
  adapters: string[]
  states: SessionState[]
  projects?: string[]
  scoped: boolean
  groupBy: GroupBy
  sortBy: SortBy
  subagents: SubagentDisplay
  shells?: StepDisplay
  tasks?: StepDisplay
  customGroups?: CustomGroup[]
  // `teamKey` values: the teams this client draws folded. A viewing preference, never sent to the gateway.
  collapsedTeams?: string[]
  earlierOpen?: boolean
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
  subagents: 'active',
  shells: 'active',
  tasks: 'active',
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
  // Messages this client has not read - `unseenCount` against its watermark, so the
  // unit is prose (`SessionInfo.proseCount`) wherever the gateway reports it. A session
  // that is only running tools contributes 0: the badge answers "is there something to
  // read", not "is anything happening", which is what `state` is for.
  unseen: number
  // Set by `groupRows` on a lead: its members, in team order, drawn under it and never top-level.
  members?: SessionRow[]
  // Set by `groupRows` on a lead: the most urgent state across the lead and its members.
  teamState?: SessionState
  // A lead drawn only because a filter matched one of its members.
  context?: true
}

export type SessionGroup = {
  key: string
  label?: string
  // Set on a project group once there is more than one gateway: `label` split into its two parts.
  gateway?: string
  project?: string
  rows: SessionRow[]
  // Set on a project group: where a session started from its header runs.
  hostId?: string
  cwd?: string
  // Set on a custom group; the ungrouped bucket has neither this nor a place in `customGroups`.
  custom?: string
  // The trailing fold of ended sessions that belong to no agent.
  earlier?: true
}

// `all` is the unfiltered list: a member matched by a filter pulls its lead in from there as a context row.
// `relayHosts` maps a relay gateway name to this client's host id for it, so a member whose lead lives on another
// configured gateway (`AgentRef.lead` = `gateway:agentId`) still draws under that lead.
export type GroupOptions = { gatewayCount?: number; all?: readonly SessionRow[]; relayHosts?: Readonly<Record<string, string>> }

export type HostRelays = Readonly<Record<string, GatewayRelayMeta | undefined>>

// Each configured gateway's relay identity (from its `GatewayMeta.relay`, keyed by host id), inverted for `relayHosts`.
export function relayHostsOf(relays: HostRelays): Record<string, string> {
  const hosts: Record<string, string> = {}
  for (const [hostId, relay] of Object.entries(relays)) {
    if (relay) {
      hosts[relay.gateway] = hostId
    }
  }
  return hosts
}

export const UNGROUPED_KEY = 'custom:ungrouped'

export function sessionKey(row: Pick<SessionRow, 'hostId' | 'info'>): string {
  return `${row.hostId}:${row.info.id}`
}

// A stored `groupBy: 'gateway'` predates the merge into project groups, which name their gateway once there is more than one.
export function normalizeViewConfig(stored: Partial<ViewConfig> | undefined): ViewConfig {
  const config = { ...DEFAULT_VIEW_CONFIG, ...stored }
  const groupBy = config.groupBy as string
  return GROUP_BY.includes(groupBy as GroupBy)
    ? config
    : { ...config, groupBy: groupBy === 'gateway' ? 'project' : DEFAULT_VIEW_CONFIG.groupBy }
}

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
  return row.info.project?.shortcode || projectName(row)
}

export function projectName(row: Pick<SessionRow, 'info'>): string {
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

export function promotedShells(info: SessionInfo, now: number): ShellInfo[] {
  return (info.shells ?? []).filter((shell) => {
    if (shell.status === 'running') {
      return now - shell.startedAt >= SHELL_PROMOTE_MS
    }
    // A *reported* non-zero exit, not merely "no zero": a killed shell and one reconciled from a restart carry no
    // exitCode at all, and `!== 0` kept both on the card for a minute drawn as failures. The linger exists for the
    // dev server that died on its own, which is the only case the operator has not already been told about.
    if (shell.endedAt === undefined || typeof shell.exitCode !== 'number' || shell.exitCode === 0) {
      return false
    }
    return shell.endedAt - shell.startedAt >= SHELL_PROMOTE_MS && now - shell.endedAt < SHELL_LINGER_MS
  })
}

export function visibleShells(info: SessionInfo, show: StepDisplay, now: number): ShellInfo[] {
  if (show === 'none') {
    return []
  }
  const shells = (info.shells ?? []).filter((shell) => shell.status !== 'running' || now - shell.startedAt >= SHELL_PROMOTE_MS)
  return show === 'active' ? shells.filter((shell) => shell.status === 'running') : shells
}

function matchesSearch(row: SessionRow, needle: string): boolean {
  if (!needle) {
    return true
  }
  return (
    sessionLabel(row.info).toLowerCase().includes(needle) ||
    (row.info.agent?.name.toLowerCase().includes(needle) ?? false) ||
    row.info.cwd.toLowerCase().includes(needle) ||
    (row.info.project?.name.toLowerCase().includes(needle) ?? false) ||
    (row.info.project?.shortcode?.toLowerCase().includes(needle) ?? false) ||
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
  return facet === 'gateway' ? row.hostId : facet === 'adapter' ? row.adapter : facet === 'project' ? projectKey(row) : unitState(row)
}

function unitState(row: SessionRow): SessionState {
  return row.teamState ?? row.state
}

function facetLabel(row: SessionRow, facet: Facet, multiGateway = false): string {
  if (facet === 'project') {
    return multiGateway ? `${row.hostName} ${projectLabel(row)}` : projectLabel(row)
  }
  return facet === 'gateway' ? row.hostName : facet === 'adapter' ? row.adapter : STATE_LABELS[unitState(row)]
}

function facetRank(row: SessionRow, facet: Facet, multiGateway = false): string {
  if (facet === 'state') {
    return String(STATE_ORDER.indexOf(unitState(row)))
  }
  if (facet === 'project' && multiGateway) {
    return `${row.hostName.toLowerCase()}\u0000${projectLabel(row).toLowerCase()}`
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

// `gatewayCount` defaults to the gateways among `rows`; a host passing filtered rows passes the unfiltered count, so a
// filter never renames a project heading.
export function groupRows(rows: readonly SessionRow[], config: ViewConfig, options: GroupOptions = {}): SessionGroup[] {
  const units = teamUnits(rows, options.all ?? rows, options.relayHosts ?? {}).sort((a, b) => compare(a, b, config.sortBy))
  const foldsEarlier = config.groupBy !== 'state' && config.groupBy !== 'custom'
  const earlier = foldsEarlier ? units.filter(isEarlier) : []
  const sorted = earlier.length ? units.filter((row) => !isEarlier(row)) : units
  const trailing: SessionGroup[] = earlier.length ? [{ key: 'earlier', label: 'Earlier', rows: earlier, earlier: true }] : []
  if (config.groupBy === 'none') {
    return [...(sorted.length ? [{ key: 'all', rows: sorted }] : []), ...trailing]
  }
  if (config.groupBy === 'custom') {
    return customGroupRows(sorted, config.customGroups ?? [])
  }
  const facet = config.groupBy
  const multiGateway = (options.gatewayCount ?? new Set(rows.map((row) => row.hostId)).size) > 1
  const groups = new Map<string, SessionGroup>()
  const ranks = new Map<string, string>()
  for (const row of sorted) {
    const key = facetKey(row, facet)
    const group = groups.get(key)
    if (group) {
      group.rows.push(row)
    } else {
      ranks.set(key, facetRank(row, facet, multiGateway))
      groups.set(key, {
        key,
        label: facetLabel(row, facet, multiGateway),
        rows: [row],
        ...(facet === 'project' ? projectTarget(row) : {}),
        ...(facet === 'project' && multiGateway ? { gateway: row.hostName, project: projectLabel(row) } : {}),
      })
    }
  }
  return [...[...groups.values()].sort((a, b) => ranks.get(a.key)!.localeCompare(ranks.get(b.key)!)), ...trailing]
}

export function teamKey(row: Pick<SessionRow, 'hostId' | 'info'>): string | undefined {
  const agent = row.info.agent
  return agent ? `${row.hostId}:${agent.id}` : undefined
}

function leadKeyOf(row: SessionRow, relayHosts: Readonly<Record<string, string>>): string | undefined {
  const agent = row.info.agent
  const lead = agent?.lead
  if (lead === undefined) {
    return undefined
  }
  if (agent?.leadGateway === undefined) {
    return `${row.hostId}:${lead}`
  }
  const host = relayHosts[agent.leadGateway]
  return host === undefined ? undefined : `${host}:${lead.slice(agent.leadGateway.length + 1)}`
}

function isEarlier(row: SessionRow): boolean {
  return row.info.agent === undefined && row.state === 'ended'
}

// A member whose lead is not in the list at all (its session gone) stays top-level rather than vanish.
function teamUnits(rows: readonly SessionRow[], all: readonly SessionRow[], relayHosts: Readonly<Record<string, string>>): SessionRow[] {
  const leads = new Map<string, SessionRow>()
  for (const row of all) {
    const key = teamKey(row)
    if (key !== undefined && row.info.agent?.lead === undefined) {
      leads.set(key, row)
    }
  }
  const shown = new Set(rows.map((row) => sessionKey(row)))
  const members = new Map<string, SessionRow[]>()
  const top: SessionRow[] = []
  for (const row of rows) {
    const lead = leadKeyOf(row, relayHosts)
    if (lead !== undefined && leads.has(lead)) {
      members.set(lead, [...(members.get(lead) ?? []), row])
    } else {
      top.push(row)
    }
  }
  for (const lead of members.keys()) {
    const leadRow = leads.get(lead)!
    if (!shown.has(sessionKey(leadRow))) {
      top.push({ ...leadRow, context: true })
    }
  }
  return top.map((row) => {
    const key = teamKey(row)
    const crew = key === undefined ? undefined : members.get(key)
    if (!crew) {
      return row
    }
    const ordered = [...crew].sort(byTeamOrder)
    return { ...row, members: ordered, teamState: teamState([row, ...ordered]) }
  })
}

function byTeamOrder(a: SessionRow, b: SessionRow): number {
  const ao = a.info.agent?.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.info.agent?.order ?? Number.MAX_SAFE_INTEGER
  return ao - bo || a.info.createdAt - b.info.createdAt
}

export function teamState(rows: readonly SessionRow[]): SessionState {
  let best = STATE_ORDER.length - 1
  for (const row of rows) {
    best = Math.min(best, STATE_ORDER.indexOf(row.state))
  }
  return STATE_ORDER[best]!
}

export function isTeamCollapsed(config: ViewConfig, row: SessionRow): boolean {
  const key = teamKey(row)
  return key !== undefined && (config.collapsedTeams ?? []).includes(key)
}

export function toggleTeamCollapsed(config: ViewConfig, row: SessionRow): ViewConfig {
  const key = teamKey(row)
  if (key === undefined) {
    return config
  }
  const held = config.collapsedTeams ?? []
  return { ...config, collapsedTeams: held.includes(key) ? held.filter((k) => k !== key) : [...held, key] }
}

export type TeamSummary = { members: number; working: number; attention: number; unseen: number }

export function teamSummary(lead: SessionRow): TeamSummary {
  const members = lead.members ?? []
  return {
    members: members.length,
    working: members.filter((row) => row.state === 'working').length,
    attention: members.filter((row) => row.state === 'attention').length,
    unseen: members.reduce((sum, row) => sum + row.unseen, 0),
  }
}

function projectTarget(row: SessionRow): { hostId: string; cwd?: string } {
  const cwd = row.info.project?.root ?? row.info.cwd
  return cwd ? { hostId: row.hostId, cwd } : { hostId: row.hostId }
}

// Custom groups keep their stored order, rows in member order; a session belongs to the first group listing it.
function customGroupRows(sorted: readonly SessionRow[], custom: readonly CustomGroup[]): SessionGroup[] {
  const byKey = new Map(sorted.map((row) => [sessionKey(row), row]))
  const placed = new Set<string>()
  const groups: SessionGroup[] = custom.map((group) => {
    const rows: SessionRow[] = []
    for (const member of group.members) {
      const row = byKey.get(member)
      if (row && !placed.has(member)) {
        placed.add(member)
        rows.push(row)
      }
    }
    return { key: `custom:${group.id}`, label: group.name, rows, custom: group.id }
  })
  const rest = sorted.filter((row) => !placed.has(sessionKey(row)))
  return rest.length ? [...groups, { key: UNGROUPED_KEY, label: 'Ungrouped', rows: rest }] : groups
}

export function newCustomGroupId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function addCustomGroup(groups: readonly CustomGroup[], name: string, id = newCustomGroupId()): CustomGroup[] {
  return [...groups, { id, name, members: [] }]
}

export function renameCustomGroup(groups: readonly CustomGroup[], id: string, name: string): CustomGroup[] {
  return groups.map((group) => (group.id === id ? { ...group, name } : group))
}

// The colour a group's badge draws: its own, else a stable one derived from its id.
export function customGroupColor(group: Pick<CustomGroup, 'id' | 'color'>): string {
  return group.color ?? projectAccent(`group:${group.id}`)
}

// `null` removes the field; an `icon` over `CUSTOM_GROUP_ICON_MAX` or not an image data URL is ignored.
export function styleCustomGroup(
  groups: readonly CustomGroup[],
  id: string,
  look: { color?: string | null; icon?: string | null },
): CustomGroup[] {
  return groups.map((group) => {
    if (group.id !== id) {
      return group
    }
    const next = { ...group }
    if (look.color === null) {
      delete next.color
    } else if (look.color !== undefined) {
      next.color = look.color
    }
    if (look.icon === null) {
      delete next.icon
    } else if (look.icon !== undefined && look.icon.startsWith('data:image/') && look.icon.length <= CUSTOM_GROUP_ICON_MAX) {
      next.icon = look.icon
    }
    return next
  })
}

export function removeCustomGroup(groups: readonly CustomGroup[], id: string): CustomGroup[] {
  return groups.filter((group) => group.id !== id)
}

// `target` undefined moves the session to the ungrouped bucket; `before` is the member it lands above, else it appends.
export function moveToCustomGroup(groups: readonly CustomGroup[], key: string, target: string | undefined, before?: string): CustomGroup[] {
  return groups.map((group) => {
    const members = group.members.filter((member) => member !== key)
    if (group.id !== target) {
      return members.length === group.members.length ? group : { ...group, members }
    }
    const at = before === undefined ? -1 : members.indexOf(before)
    return { ...group, members: at < 0 ? [...members, key] : [...members.slice(0, at), key, ...members.slice(at)] }
  })
}

export function moveCustomGroup(groups: readonly CustomGroup[], id: string, before: string | undefined): CustomGroup[] {
  const moving = groups.find((group) => group.id === id)
  if (!moving || id === before) {
    return [...groups]
  }
  const rest = groups.filter((group) => group.id !== id)
  const at = before === undefined ? -1 : rest.findIndex((group) => group.id === before)
  return at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]
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

export function facetFilterCount(config: ViewConfig): number {
  return [config.gateways, config.adapters, config.states, config.projects ?? []].filter((facet) => facet.length > 0).length
}

export function displayCustomized(config: ViewConfig): boolean {
  return (
    config.subagents !== DEFAULT_VIEW_CONFIG.subagents ||
    (config.shells ?? DEFAULT_VIEW_CONFIG.shells) !== DEFAULT_VIEW_CONFIG.shells ||
    (config.tasks ?? DEFAULT_VIEW_CONFIG.tasks) !== DEFAULT_VIEW_CONFIG.tasks
  )
}

export function clearFilters(config: ViewConfig): ViewConfig {
  return {
    ...DEFAULT_VIEW_CONFIG,
    scoped: false,
    groupBy: config.groupBy,
    sortBy: config.sortBy,
    subagents: config.subagents,
    shells: config.shells,
    tasks: config.tasks,
    customGroups: config.customGroups,
  }
}
