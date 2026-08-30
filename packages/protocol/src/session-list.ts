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

import type { SessionInfo, SubagentInfo } from './index.ts'

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

export const sessionState = (info: SessionInfo): SessionState => {
  // A pending approval outranks everything, a running background agent
  // included: it is the one thing the person has to act on.
  if (info.pendingPermissionCount > 0 || info.status === 'awaiting_approval') {
    return 'attention'
  }
  // Terminal statuses are checked before the sub-agent arm, defensively: the
  // `session_closed` sweep settles every sub-agent record (the process hosting
  // them is gone), so a closed session carrying a `running` record should be
  // unreachable — but a stale record must read `ended`, never `working`.
  if (info.status === 'failed' || info.status === 'closed') {
    return 'ended'
  }
  if (info.status === 'running' || info.status === 'starting') {
    return 'working'
  }
  // A *background* agent outlives its turn by design (`task_started`, the
  // async spawn): the turn ends, `status` comes to rest at `idle`, and the
  // agent keeps burning tokens. Without this arm the row read Idle while an
  // agent was actively working in it — the status alone cannot carry it,
  // because the status is the turn's.
  if (runningSubagents(info).length > 0) {
    return 'working'
  }
  return 'idle'
}

/**
 * The sub-agents a list row draws as live.
 *
 * `sessionState` deliberately does **not** grow a `subagents` bucket — a fifth
 * state would split `working` in two for every client that filters by it,
 * including the ones that have not shipped this yet. Instead `working` *counts*
 * them: a synchronous `Task` keeps the turn in flight so the status already
 * says `working`, and a **background** agent — which outlives its turn on
 * purpose — is the carve-out the extra arm in `sessionState` exists for.
 * That is what makes "sub-agents are an annotation on a working row" true
 * rather than assumed: the row is in the working bucket whichever kind is
 * running, and this list only says more about it.
 */
export const runningSubagents = (info: SessionInfo): SubagentInfo[] => {
  return (info.subagents ?? []).filter((sub) => sub.status === 'running')
}

/**
 * Does this record name an **agent**, as opposed to a task the model merely
 * described?
 *
 * The tracker opens a record for every spawner call and for any nested event
 * whose parent it has not seen, so the list holds two different things wearing
 * one shape. One carries a `subagent_type` — a delegated agent with an identity
 * (`Explore`), whose own work is worth a surface of its own. The other carries
 * only a description, and there is no agent there to open: a row that offered a
 * screen and then showed a frame with nothing in it would be worse than a row
 * that offered nothing.
 *
 * Here rather than in a client because it decides two things a list must not
 * disagree about across surfaces — what is pressable, and what wears the
 * sub-agent colour.
 */
export const isAgentRecord = (sub: SubagentInfo): boolean => {
  return (sub.agentType?.trim() ?? '') !== ''
}

/**
 * A sub-agent's identity on one line: `Explore · find the auth check`.
 *
 * The same two fields `taskLabel` builds its transcript row from, minus the
 * `Task(…)` wrapper — a list row is already inside a session, so naming the tool
 * spends the width that the description needs. Falls back to the bare agent type,
 * then to a generic word: a row with no label at all reads as a rendering bug,
 * and an engine is free to send neither field.
 */
export const subagentLabel = (sub: SubagentInfo): string => {
  const agent = sub.agentType?.trim()
  const description = sub.description?.trim()
  if (agent && description) {
    return `${agent} · ${description}`
  }
  return agent || description || 'Sub-agent'
}

/** The facets a session can be grouped or sorted by. */
export type Facet = 'gateway' | 'adapter' | 'state' | 'project'
export type GroupBy = 'none' | Facet
export type SortBy = 'recent' | 'name' | Facet

export type ViewConfig = {
  search: string
  /** Empty = no filter. Ids, not names: names are editable. */
  gateways: string[]
  adapters: string[]
  states: SessionState[]
  /**
   * Empty = no filter. Keys are {@link projectKey} output — never names, which
   * are neither unique (two repos both called "api") nor stable (editing
   * `.workerdeck.json` renames every session at once and must not empty a
   * saved filter). Optional, unlike its three siblings, because stored view
   * configs predate it: a config restored from `localStorage`/`globalState`
   * without the key must keep filtering, so absent and empty mean the same
   * thing.
   */
  projects?: string[]
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
  projects: [],
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
export const adaptersOf = (rows: readonly SessionRow[]): string[] => {
  return [...new Set(rows.map((r) => r.adapter))].sort()
}

/**
 * The projects actually present, as `{ key, label }` for a filter control —
 * derived like {@link adaptersOf}, and paired because the two halves differ:
 * the *key* is what {@link ViewConfig.projects} holds (gateway-qualified root,
 * so a rename regroups nothing) and the *label* is what a person picks by.
 *
 * Sorted by label, deduped by key. Two projects with the same name on two
 * gateways therefore stay two entries wearing one word — which is honest: they
 * really are two different directories, and the alternative is a filter that
 * silently selects both.
 */
export const projectsOf = (rows: readonly SessionRow[]): { key: string; label: string }[] => {
  const byKey = new Map<string, string>()
  for (const row of rows) {
    byKey.set(projectKey(row), projectLabel(row))
  }
  return [...byKey].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

export const sessionLabel = (info: SessionInfo): string => {
  return info.title ?? info.id.slice(0, 8)
}

/**
 * The project facet's grouping key: gateway id + the project root, falling
 * back to the session's cwd when no project is declared.
 *
 * The root and not the name, because a name is not a key (two repos can both
 * be called "api", and a rename must regroup nothing); qualified by gateway,
 * because a remote gateway's identical-looking path is another machine's
 * directory — the same rule `ScopeRoot` states. The cwd fallback is what makes
 * grouping by project useful before anyone has written a `.workerdeck.json`:
 * undeclared sessions group by their folder, declared ones by their root, and
 * a session in `packages/ui` joins its repo's group the moment the file
 * exists. Sessions with no cwd at all (a filesystem-less engine) share one
 * per-gateway bucket — see {@link projectLabel}.
 */
export const projectKey = (row: SessionRow): string => {
  return `${row.hostId}:${normalizePath(row.info.project?.root ?? row.info.cwd)}`
}

/**
 * What a project group (or a row's project slot) is called: the declared name,
 * else the cwd's basename — the exact string clients rendered before this
 * feature existed, so an undeclared project looks like today. 'No project' is
 * only ever the no-cwd case (a sandboxed provider session), where there is no
 * folder to name.
 *
 * Takes only the `info` it reads, so a surface holding a bare `SessionInfo` —
 * a row component, an iOS cell — can call it without inventing the rest of a
 * `SessionRow`. That matters more than it looks: this string is what a client
 * renders *in place of* the cwd basename it used to draw, and two spellings of
 * it would put the list and its group headers on different names.
 */
export const projectLabel = (row: Pick<SessionRow, 'info'>): string => {
  const name = row.info.project?.name
  if (name) {
    return name
  }
  const dir = normalizePath(row.info.cwd)
  return dir.slice(dir.lastIndexOf('/') + 1) || 'No project'
}

/**
 * Where inside its project a session actually sits — the cwd with the project
 * root taken off the front, or `undefined` when it sits at the root, has no
 * declared project, or has no cwd at all.
 *
 * The companion to {@link projectLabel}, and it exists for one situation: a list
 * **grouped by project**. There the header has already said the project's name,
 * so repeating it on every row spends the row's most valuable line on the one
 * fact the reader already has. What the header cannot say is which *part* of the
 * project a session is working in, and two sessions in the same repo are told
 * apart by exactly that.
 *
 * Undefined is the honest answer for a session at the project root, and callers
 * must render nothing rather than a `.` or a repeated name — the slot simply
 * goes away, which is the point.
 */
export const projectSubpath = (row: Pick<SessionRow, 'info'>): string | undefined => {
  const root = row.info.project?.root
  if (root === undefined || !row.info.cwd) {
    return undefined
  }
  const base = normalizePath(root)
  const dir = normalizePath(row.info.cwd)
  if (dir === base) {
    return undefined
  }
  // A prefix match is not containment: `/a/repo-two` starts with `/a/repo`.
  if (!dir.startsWith(`${base}/`)) {
    return undefined
  }
  return dir.slice(base.length + 1) || undefined
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
export const isJobRun = (info: SessionInfo): boolean => {
  return typeof info.meta?.jobId === 'string'
}

const matchesSearch = (row: SessionRow, needle: string): boolean => {
  if (!needle) {
    return true
  }
  return (
    sessionLabel(row.info).toLowerCase().includes(needle) ||
    row.info.cwd.toLowerCase().includes(needle) ||
    // The declared project name: the whole point of it is that a person knows
    // the repo as "WorkerDeck", not by whatever the folder happens to be called.
    (row.info.project?.name.toLowerCase().includes(needle) ?? false) ||
    row.hostName.toLowerCase().includes(needle) ||
    row.adapter.toLowerCase().includes(needle) ||
    row.info.id.startsWith(needle)
  )
}

/** Trailing separators dropped and separators unified, so containment is a
 * plain prefix test on both a posix and a Windows gateway. */
const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

const isWithin = (root: string, path: string): boolean => {
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
export const inScope = (row: SessionRow, scope: WorkspaceScope): boolean => {
  return scope.roots.some(
    (root) => (root.hostId ? root.hostId.toLowerCase() === row.hostId.toLowerCase() : row.local) && isWithin(root.path, row.info.cwd),
  )
}

/** Whether the scope filter is actually hiding anything — it is inert with no
 * folder open, and that is the difference between a default and a filter. */
export const scopeActive = (config: ViewConfig, scope: WorkspaceScope | undefined): boolean => {
  return config.scoped && scope !== undefined
}

export const filterRows = (rows: readonly SessionRow[], config: ViewConfig, scope?: WorkspaceScope): SessionRow[] => {
  const needle = config.search.trim().toLowerCase()
  const scoping = scopeActive(config, scope) ? scope : undefined
  return rows.filter(
    (row) =>
      (config.gateways.length === 0 || config.gateways.includes(row.hostId)) &&
      (config.adapters.length === 0 || config.adapters.includes(row.adapter)) &&
      (config.states.length === 0 || config.states.includes(row.state)) &&
      // `?.` and not a default: see `ViewConfig.projects` — a stored config
      // predating the field must behave as "no filter".
      (!config.projects?.length || config.projects.includes(projectKey(row))) &&
      (!scoping || inScope(row, scoping)) &&
      matchesSearch(row, needle),
  )
}

const facetKey = (row: SessionRow, facet: Facet): string => {
  return facet === 'gateway' ? row.hostId : facet === 'adapter' ? row.adapter : facet === 'project' ? projectKey(row) : row.state
}

const facetLabel = (row: SessionRow, facet: Facet): string => {
  return facet === 'gateway'
    ? row.hostName
    : facet === 'adapter'
      ? row.adapter
      : facet === 'project'
        ? projectLabel(row)
        : STATE_LABELS[row.state]
}

/** Comparable rank for a facet: states run worst-first (attention before ended),
 * the rest alphabetically by their visible label. */
const facetRank = (row: SessionRow, facet: Facet): string => {
  if (facet === 'state') {
    return String(STATE_ORDER.indexOf(row.state))
  }
  return facetLabel(row, facet).toLowerCase()
}

const byRecency = (a: SessionRow, b: SessionRow) =>
  (b.info.lastActivityAt ?? b.info.createdAt) - (a.info.lastActivityAt ?? a.info.createdAt)

const compare = (a: SessionRow, b: SessionRow, sortBy: SortBy): number => {
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

/**
 * The list as rendered: filtered, grouped, and sorted within each group. Groups
 * themselves come out in the sort's own order — grouping by state and sorting by
 * name should still put "Needs attention" first, so groups are ordered by their
 * facet rank, never by the row sort.
 */
export const groupRows = (rows: readonly SessionRow[], config: ViewConfig): SessionGroup[] => {
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

/**
 * What the list is hiding, and why — the one "you are seeing a subset" signal,
 * the single rule both the count and the wording come from: absent when nothing
 * is hidden, and otherwise naming every cause, so the line is never "12 of 30"
 * with no way to guess why.
 *
 * Search is a cause like any other. Its box is visible, but the *consequence*
 * of it — rows gone from the list — is the thing being reported, and leaving it
 * out would make the arithmetic wrong.
 */
export type SubsetSummary = { shown: number; total: number; causes: string[] }

export const subsetSummary = (
  config: ViewConfig,
  scope: WorkspaceScope | undefined,
  shown: number,
  total: number,
): SubsetSummary | undefined => {
  if (shown >= total) {
    return undefined
  }
  const causes: string[] = []
  if (scope && scopeActive(config, scope)) {
    causes.push(scope.label)
  }
  // The facets collapse to a count: naming three of them would wrap the line in
  // a sidebar, and the funnel beside it is where their detail already lives.
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

/**
 * Is anything OTHER than the workspace scope narrowing the list?
 *
 * The distinction an empty list turns on: "this project has no sessions" wants a
 * different sentence, and a different way out, from "your filters match none".
 * Scope is excluded because it is on by default — it is the state, not a choice
 * someone made.
 */
export const hasFacetFilter = (config: ViewConfig): boolean => {
  return (
    config.search.trim().length > 0 ||
    config.gateways.length > 0 ||
    config.adapters.length > 0 ||
    config.states.length > 0 ||
    (config.projects?.length ?? 0) > 0
  )
}

/** "Show me everything": every filter off, including scope. The group/sort
 * choices are a layout preference and survive. */
export const clearFilters = (config: ViewConfig): ViewConfig => {
  return {
    ...DEFAULT_VIEW_CONFIG,
    scoped: false,
    groupBy: config.groupBy,
    sortBy: config.sortBy,
  }
}
