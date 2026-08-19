import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW_CONFIG,
  adaptersOf,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  inScope,
  projectKey,
  projectLabel,
  scopeActive,
  sessionLabel,
  sessionState,
  subsetSummary,
} from '@workerdeck/protocol'
import type {
  SessionInfo,
  SessionRow,
  SubagentInfo,
  ViewConfig,
  WorkspaceScope,
} from '@workerdeck/protocol'

/**
 * The sessions-list view model. It lives in `protocol` because three clients
 * derive their list from it — the VS Code sidebar (whose activity-bar badge
 * counts the *same* rows the list shows), the dashboard, and the iOS mirror — so
 * these are the rules, not one client's preferences.
 */

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-00000001',
    status: 'idle',
    cwd: '/work/alpha',
    createdAt: 1_000,
    lastActivityAt: 1_000,
    numTurns: 0,
    pendingPermissionCount: 0,
    ...over,
  } as SessionInfo
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  const inf = over.info ?? info()
  return {
    hostId: 'mac',
    hostName: 'Mac mini',
    local: true,
    adapter: 'claude',
    state: sessionState(inf),
    unseen: 0,
    ...over,
    info: inf,
  }
}

const config = (over: Partial<ViewConfig> = {}): ViewConfig => ({ ...DEFAULT_VIEW_CONFIG, ...over })

describe('sessionState', () => {
  it('promotes a pending approval over the raw status', () => {
    // The rollup can still say `running` while a request waits — the thing a
    // person filters on is "does this need me", not what the engine calls it.
    expect(sessionState(info({ status: 'running', pendingPermissionCount: 1 }))).toBe('attention')
    expect(sessionState(info({ status: 'awaiting_approval' }))).toBe('attention')
  })

  it('collapses the engine-shaped statuses into four buckets', () => {
    expect(sessionState(info({ status: 'starting' }))).toBe('working')
    expect(sessionState(info({ status: 'running' }))).toBe('working')
    expect(sessionState(info({ status: 'idle' }))).toBe('idle')
    expect(sessionState(info({ status: 'parked' }))).toBe('idle')
    expect(sessionState(info({ status: 'failed' }))).toBe('ended')
    expect(sessionState(info({ status: 'closed' }))).toBe('ended')
  })

  const sub = (status: SubagentInfo['status']): SubagentInfo => ({
    toolUseId: `tu-${status}`,
    status,
    startedAt: 1_000,
    toolCount: 3,
  })

  it('reads working while a background sub-agent outlives its turn', () => {
    // A background agent ends its turn on purpose: status comes to rest at
    // `idle` while the agent keeps working. The row must not read Idle.
    expect(sessionState(info({ status: 'idle', subagents: [sub('running')] }))).toBe('working')
  })

  it('reads idle once every sub-agent has settled', () => {
    expect(
      sessionState(info({ status: 'idle', subagents: [sub('done'), sub('failed')] })),
    ).toBe('idle')
  })

  it('never resurrects a terminal session off a stale running record', () => {
    // `session_closed` settles every record, so this should be unreachable —
    // asserted anyway, because a stale record must read ended, never working.
    expect(sessionState(info({ status: 'closed', subagents: [sub('running')] }))).toBe('ended')
    expect(sessionState(info({ status: 'failed', subagents: [sub('running')] }))).toBe('ended')
  })

  it('lets a pending approval outrank a running sub-agent', () => {
    expect(
      sessionState(
        info({ status: 'idle', pendingPermissionCount: 1, subagents: [sub('running')] }),
      ),
    ).toBe('attention')
  })
})

describe('filterRows', () => {
  const rows = [
    row({ info: info({ id: 'a1', title: 'Refactor parser', cwd: '/work/alpha' }) }),
    row({
      hostId: 'pi',
      hostName: 'Pi',
      local: false,
      adapter: 'codex',
      info: info({ id: 'b2', title: 'Fix flake', cwd: '/srv/beta', status: 'running' }),
    }),
  ]

  it('matches search across title, cwd, gateway, adapter and id prefix', () => {
    const find = (search: string) =>
      filterRows(rows, config({ search, scoped: false })).map((r) => r.info.id)
    expect(find('parser')).toEqual(['a1'])
    expect(find('/srv')).toEqual(['b2'])
    expect(find('pi')).toEqual(['b2'])
    expect(find('codex')).toEqual(['b2'])
    expect(find('a1')).toEqual(['a1'])
    // An id is matched by prefix only — a hex soup matching mid-string would
    // surface rows nobody was looking for.
    expect(find('1')).toEqual([])
  })

  it('treats an empty facet as no filter, and facets as AND', () => {
    expect(filterRows(rows, config({ scoped: false })).length).toBe(2)
    expect(
      filterRows(rows, config({ scoped: false, adapters: ['codex'], gateways: ['mac'] })).length,
    ).toBe(0)
  })
})

describe('scope', () => {
  const local = row({ info: info({ cwd: '/work/alpha' }) })
  const remote = row({
    hostId: 'pi',
    local: false,
    info: info({ cwd: '/work/alpha' }),
  })

  it('only lets a real folder scope a loopback gateway', () => {
    // The whole point: a remote gateway's identical-looking path is another
    // machine's directory, and matching it would show sessions from elsewhere.
    const scope: WorkspaceScope = { label: 'alpha', roots: [{ path: '/work/alpha' }] }
    expect(inScope(local, scope)).toBe(true)
    expect(inScope(remote, scope)).toBe(false)
  })

  it('lets a gateway-tagged root scope exactly that gateway', () => {
    const scope: WorkspaceScope = { label: 'alpha', roots: [{ hostId: 'pi', path: '/work/alpha' }] }
    expect(inScope(remote, scope)).toBe(true)
    expect(inScope(local, scope)).toBe(false)
  })

  it('does not let a prefix swallow a sibling directory', () => {
    const scope: WorkspaceScope = { label: 'alpha', roots: [{ path: '/work/alpha' }] }
    expect(inScope(row({ info: info({ cwd: '/work/alpha-2' }) }), scope)).toBe(false)
    expect(inScope(row({ info: info({ cwd: '/work/alpha/pkg' }) }), scope)).toBe(true)
  })

  it('tolerates trailing separators and Windows separators', () => {
    const scope: WorkspaceScope = { label: 'alpha', roots: [{ path: 'C:\\work\\alpha\\' }] }
    expect(inScope(row({ info: info({ cwd: 'C:\\work\\alpha\\pkg' }) }), scope)).toBe(true)
  })

  it('is inert — not merely empty — with no scope at all', () => {
    // This is what lets `scoped` default to on: with nothing open it hides
    // nothing, so it is a default rather than a filter someone has to find.
    expect(scopeActive(config(), undefined)).toBe(false)
    expect(filterRows([local, remote], config({ scoped: true })).length).toBe(2)
  })
})

describe('groupRows', () => {
  const attention = row({
    info: info({ id: 'x', title: 'Zebra', status: 'awaiting_approval', lastActivityAt: 5 }),
  })
  const idle = row({ info: info({ id: 'y', title: 'Apple', lastActivityAt: 9 }) })

  it('orders groups by facet rank even when rows sort by name', () => {
    // Grouping by state and sorting by name must still lead with "Needs
    // attention" — groups follow the facet's own worst-first order.
    const groups = groupRows([idle, attention], config({ groupBy: 'state', sortBy: 'name' }))
    expect(groups.map((g) => g.key)).toEqual(['attention', 'idle'])
  })

  it('falls back to recency as the universal tiebreak', () => {
    const same = [
      row({ info: info({ id: 'old', title: 'Same', lastActivityAt: 1 }) }),
      row({ info: info({ id: 'new', title: 'Same', lastActivityAt: 2 }) }),
    ]
    const [group] = groupRows(same, config({ groupBy: 'none', sortBy: 'name' }))
    expect(group?.rows.map((r) => r.info.id)).toEqual(['new', 'old'])
  })

  it('returns no groups at all for an empty list', () => {
    expect(groupRows([], config({ groupBy: 'none' }))).toEqual([])
  })
})

describe('subsetSummary', () => {
  const scope: WorkspaceScope = { label: 'alpha', roots: [{ path: '/work/alpha' }] }

  it('is absent when nothing is hidden', () => {
    expect(subsetSummary(config(), scope, 12, 12)).toBeUndefined()
  })

  it('names every cause, counting the facets rather than listing them', () => {
    const summary = subsetSummary(
      config({ search: 'parser', adapters: ['codex'], states: ['idle'] }),
      scope,
      3,
      30,
    )
    expect(summary).toEqual({ shown: 3, total: 30, causes: ['alpha', '2 filters', 'search'] })
  })

  it('omits scope when the scope filter is off', () => {
    expect(subsetSummary(config({ scoped: false, search: 'x' }), scope, 1, 2)?.causes).toEqual([
      'search',
    ])
  })
})

describe('clearFilters', () => {
  it('turns off every filter including scope, and keeps the layout choices', () => {
    const next = clearFilters(config({ search: 'x', states: ['idle'], groupBy: 'gateway', sortBy: 'name' }))
    expect(hasFacetFilter(next)).toBe(false)
    expect(next.scoped).toBe(false)
    expect(next.groupBy).toBe('gateway')
    expect(next.sortBy).toBe('name')
  })

  it('does not count scope as a facet filter', () => {
    // An empty list under scope alone wants a different sentence ("nothing in
    // this folder") from one under filters ("no matches").
    expect(hasFacetFilter(config({ scoped: true }))).toBe(false)
  })
})

describe('labels', () => {
  it('falls back to an id prefix when a session has no title', () => {
    expect(sessionLabel(info({ id: 'abcdef0123456789' }))).toBe('abcdef01')
    expect(sessionLabel(info({ title: 'Named' }))).toBe('Named')
  })

  it('derives the adapter chips from the rows present', () => {
    expect(adaptersOf([row(), row({ adapter: 'codex' }), row({ adapter: 'codex' })])).toEqual([
      'claude',
      'codex',
    ])
  })
})

describe('project facet', () => {
  const project = { name: 'WorkerDeck', root: '/work/deck' }
  const declaredUi = row({
    info: info({ id: 'p1', cwd: '/work/deck/packages/ui', project }),
  })
  const declaredWeb = row({
    info: info({ id: 'p2', cwd: '/work/deck/packages/web', project }),
  })
  const undeclared = row({ info: info({ id: 'u1', cwd: '/work/alpha' }) })
  const remoteTwin = row({
    hostId: 'pi',
    hostName: 'Pi',
    local: false,
    info: info({ id: 'r1', cwd: '/work/deck/packages/ui', project }),
  })
  const nowhere = row({ info: info({ id: 'n1', cwd: '' }) })

  it('keys by root per gateway — a name is not a key and a remote twin is not this project', () => {
    // Two cwds inside one project share the key; the identical root on another
    // gateway is another machine's directory (the ScopeRoot argument).
    expect(projectKey(declaredUi)).toBe(projectKey(declaredWeb))
    expect(projectKey(declaredUi)).not.toBe(projectKey(remoteTwin))
    // Undeclared sessions key by their cwd, so grouping works before anyone
    // has written a .workerdeck.json.
    expect(projectKey(undeclared)).toBe('mac:/work/alpha')
  })

  it('labels by the declared name, else the cwd basename, else No project', () => {
    expect(projectLabel(declaredUi)).toBe('WorkerDeck')
    expect(projectLabel(undeclared)).toBe('alpha')
    expect(projectLabel(nowhere)).toBe('No project')
  })

  it('groups declared and undeclared rows side by side, alphabetically by label', () => {
    const groups = groupRows(
      [undeclared, declaredUi, declaredWeb],
      config({ groupBy: 'project', sortBy: 'recent' }),
    )
    expect(groups.map((g) => g.label)).toEqual(['alpha', 'WorkerDeck'])
    expect(groups[1]?.rows.map((r) => r.info.id)).toEqual(['p1', 'p2'])
  })

  it('filters by project key, and a config predating the field filters nothing', () => {
    const rows = [declaredUi, undeclared]
    const filtered = filterRows(
      rows,
      config({ scoped: false, projects: [projectKey(declaredUi)] }),
    )
    expect(filtered.map((r) => r.info.id)).toEqual(['p1'])
    // A stored ViewConfig restored from before the field existed: absent and
    // empty must mean the same thing.
    const legacy = config({ scoped: false })
    delete (legacy as { projects?: string[] }).projects
    expect(filterRows(rows, legacy).length).toBe(2)
    expect(hasFacetFilter(legacy)).toBe(false)
  })

  it('matches search against the declared project name', () => {
    // The person knows the repo as "WorkerDeck", not by the folder's basename.
    const found = filterRows(
      [declaredUi, undeclared],
      config({ scoped: false, search: 'workerdeck' }),
    )
    expect(found.map((r) => r.info.id)).toEqual(['p1'])
  })

  it('counts a project filter into the subset line and clearFilters resets it', () => {
    const filtered = config({ projects: ['mac:/work/deck'], scoped: false })
    expect(subsetSummary(filtered, undefined, 1, 2)?.causes).toEqual(['1 filter'])
    expect(hasFacetFilter(filtered)).toBe(true)
    expect(clearFilters(filtered).projects).toEqual([])
  })
})
