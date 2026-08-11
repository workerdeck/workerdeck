import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW_CONFIG,
  adaptersOf,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  inScope,
  scopeActive,
  sessionLabel,
  sessionState,
  subsetSummary,
} from '@workerdeck/protocol'
import type { SessionInfo, SessionRow, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'

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
