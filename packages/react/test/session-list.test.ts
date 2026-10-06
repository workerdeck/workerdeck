import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW_CONFIG,
  UNGROUPED_KEY,
  addCustomGroup,
  adaptersOf,
  clearFilters,
  displayCustomized,
  displayedTasks,
  facetFilterCount,
  filterRows,
  groupRows,
  hasFacetFilter,
  inScope,
  isTeamCollapsed,
  moveCustomGroup,
  moveToCustomGroup,
  normalizeViewConfig,
  projectKey,
  projectLabel,
  projectName,
  projectSubpath,
  projectsOf,
  promotedShells,
  removeCustomGroup,
  scopeActive,
  sessionKey,
  sessionLabel,
  sessionState,
  subsetSummary,
  teamSummary,
  toggleTeamCollapsed,
  visibleShells,
} from '@workerdeck/protocol'
import type { SessionInfo, SessionRow, ShellInfo, SubagentInfo, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'

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

function config(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...DEFAULT_VIEW_CONFIG, ...over }
}

describe('sessionState', () => {
  it('promotes a pending approval over the raw status', () => {
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
    expect(sessionState(info({ status: 'idle', subagents: [sub('running')] }))).toBe('working')
  })

  it('reads idle once every sub-agent has settled', () => {
    expect(sessionState(info({ status: 'idle', subagents: [sub('done'), sub('failed')] }))).toBe('idle')
  })

  it('never resurrects a terminal session off a stale running record', () => {
    expect(sessionState(info({ status: 'closed', subagents: [sub('running')] }))).toBe('ended')
    expect(sessionState(info({ status: 'failed', subagents: [sub('running')] }))).toBe('ended')
  })

  it('lets a pending approval outrank a running sub-agent', () => {
    expect(sessionState(info({ status: 'idle', pendingPermissionCount: 1, subagents: [sub('running')] }))).toBe('attention')
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
    const find = (search: string) => filterRows(rows, config({ search, scoped: false })).map((r) => r.info.id)
    expect(find('parser')).toEqual(['a1'])
    expect(find('/srv')).toEqual(['b2'])
    expect(find('pi')).toEqual(['b2'])
    expect(find('codex')).toEqual(['b2'])
    expect(find('a1')).toEqual(['a1'])
    expect(find('1')).toEqual([])
  })

  it('treats an empty facet as no filter, and facets as AND', () => {
    expect(filterRows(rows, config({ scoped: false })).length).toBe(2)
    expect(filterRows(rows, config({ scoped: false, adapters: ['codex'], gateways: ['mac'] })).length).toBe(0)
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

  it('is inert - not merely empty - with no scope at all', () => {
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
    const summary = subsetSummary(config({ search: 'parser', adapters: ['codex'], states: ['idle'] }), scope, 3, 30)
    expect(summary).toEqual({ shown: 3, total: 30, causes: ['alpha', '2 filters', 'search'] })
  })

  it('omits scope when the scope filter is off', () => {
    expect(subsetSummary(config({ scoped: false, search: 'x' }), scope, 1, 2)?.causes).toEqual(['search'])
  })
})

describe('clearFilters', () => {
  it('turns off every filter including scope, and keeps the layout choices', () => {
    const next = clearFilters(config({ search: 'x', states: ['idle'], groupBy: 'custom', sortBy: 'name' }))
    expect(hasFacetFilter(next)).toBe(false)
    expect(next.scoped).toBe(false)
    expect(next.groupBy).toBe('custom')
    expect(next.sortBy).toBe('name')
  })

  it('does not count scope as a facet filter', () => {
    expect(hasFacetFilter(config({ scoped: true }))).toBe(false)
  })

  it('keeps the shells and tasks display, which are layout rather than filters', () => {
    const next = clearFilters(config({ states: ['idle'], shells: 'all', tasks: 'none' }))
    expect(next.shells).toBe('all')
    expect(next.tasks).toBe('none')
  })
})

describe('filter engagement', () => {
  it('counts facets, not search or scope', () => {
    expect(facetFilterCount(config({ search: 'x', scoped: true }))).toBe(0)
    expect(facetFilterCount(config({ states: ['idle'], projects: ['a'] }))).toBe(2)
  })

  it('reads a config persisted before shells and tasks existed as the defaults', () => {
    expect(displayCustomized(config())).toBe(false)
    expect(displayCustomized({ ...config(), shells: undefined, tasks: undefined })).toBe(false)
    expect(displayCustomized(config({ tasks: 'all' }))).toBe(true)
    expect(displayCustomized(config({ subagents: 'none' }))).toBe(true)
  })
})

describe('visibleShells', () => {
  const shellOf = (over: Partial<ShellInfo>): ShellInfo =>
    ({
      id: 's',
      sessionId: 'x',
      ordinal: 1,
      command: 'ls',
      cwd: '/',
      owner: 'user',
      status: 'running',
      startedAt: 0,
      bytes: 0,
      ...over,
    }) as ShellInfo
  const inf = info({
    shells: [
      shellOf({ id: 'run' }),
      shellOf({ id: 'young', startedAt: 9_000 }),
      shellOf({ id: 'clean', status: 'exited', exitCode: 0, endedAt: 5_000 }),
      shellOf({ id: 'bad', status: 'exited', exitCode: 1, endedAt: 9_500 }),
    ],
  })

  it('draws promoted running shells for active, every settled one for all, none for none', () => {
    expect(visibleShells(inf, 'active', 10_000).map((s) => s.id)).toEqual(['run'])
    expect(visibleShells(inf, 'all', 10_000).map((s) => s.id)).toEqual(['run', 'clean', 'bad'])
    expect(visibleShells(inf, 'none', 10_000)).toEqual([])
  })
})

describe('displayedTasks', () => {
  const inf = info({
    checklist: [
      { text: 'plan', status: 'completed' },
      { text: 'build', status: 'in_progress' },
    ],
    subagents: [
      { toolUseId: 'b', description: 'node server.js', status: 'running', startedAt: 0, toolCount: 0, stoppable: true },
      { toolUseId: 'f', description: 'broke', status: 'failed', startedAt: 0, toolCount: 0 },
    ],
  })

  it('hides done and failed tasks for active and carries the stop through', () => {
    expect(displayedTasks(inf, 'all').map((t) => t.label)).toEqual(['plan', 'build', 'node server.js', 'broke'])
    expect(displayedTasks(inf, 'active').map((t) => t.label)).toEqual(['build', 'node server.js'])
    expect(displayedTasks(inf, 'none')).toEqual([])
    expect(displayedTasks(inf, 'all')[2]?.stoppable).toBe(true)
  })
})

describe('labels', () => {
  it('falls back to an id prefix when a session has no title', () => {
    expect(sessionLabel(info({ id: 'abcdef0123456789' }))).toBe('abcdef01')
    expect(sessionLabel(info({ title: 'Named' }))).toBe('Named')
  })

  it('derives the adapter chips from the rows present', () => {
    expect(adaptersOf([row(), row({ adapter: 'codex' }), row({ adapter: 'codex' })])).toEqual(['claude', 'codex'])
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

  it('keys by root per gateway - a name is not a key and a remote twin is not this project', () => {
    expect(projectKey(declaredUi)).toBe(projectKey(declaredWeb))
    expect(projectKey(declaredUi)).not.toBe(projectKey(remoteTwin))
    expect(projectKey(undeclared)).toBe('mac:/work/alpha')
  })

  it('labels by the declared name, else the cwd basename, else No project', () => {
    expect(projectLabel(declaredUi)).toBe('WorkerDeck')
    expect(projectLabel(undeclared)).toBe('alpha')
    expect(projectLabel(nowhere)).toBe('No project')
  })

  it('prefers a declared shortcode for the label while projectName keeps the full name', () => {
    const coded = row({ info: info({ id: 'sc1', cwd: '/work/deck/packages/ui', project: { ...project, shortcode: 'WD' } }) })
    expect(projectLabel(coded)).toBe('WD')
    expect(projectName(coded)).toBe('WorkerDeck')
    expect(projectKey(coded)).toBe(projectKey(declaredUi))
    expect(projectLabel(declaredUi)).toBe('WorkerDeck')
    expect(projectName(undeclared)).toBe('alpha')
    expect(projectName(nowhere)).toBe('No project')
  })

  it('answers the sub-path inside a project, and nothing at all at its root', () => {
    expect(projectSubpath(declaredUi)).toBe('packages/ui')
    expect(projectSubpath(declaredWeb)).toBe('packages/web')
    expect(projectSubpath(row({ info: info({ id: 'p3', cwd: '/work/deck', project }) }))).toBeUndefined()
    expect(projectSubpath(undeclared)).toBeUndefined()
    expect(projectSubpath(nowhere)).toBeUndefined()
  })

  it('does not mistake a sibling directory for a child of the project', () => {
    expect(projectSubpath(row({ info: info({ id: 's1', cwd: '/work/deck-two/pkg', project }) }))).toBeUndefined()
  })

  it('offers one filter entry per project, keyed by root and labelled by name', () => {
    const options = projectsOf([declaredUi, declaredWeb, undeclared, remoteTwin, nowhere])
    expect(options).toEqual([
      { key: projectKey(undeclared), label: 'alpha' },
      { key: projectKey(nowhere), label: 'No project' },
      { key: projectKey(declaredUi), label: 'WorkerDeck' },
      { key: projectKey(remoteTwin), label: 'WorkerDeck' },
    ])
  })

  it('groups declared and undeclared rows side by side, alphabetically by label', () => {
    const groups = groupRows([undeclared, declaredUi, declaredWeb], config({ groupBy: 'project', sortBy: 'recent' }))
    expect(groups.map((g) => g.label)).toEqual(['alpha', 'WorkerDeck'])
    expect(groups[1]?.rows.map((r) => r.info.id)).toEqual(['p1', 'p2'])
  })

  it('names the gateway on project groups once there is more than one', () => {
    const both = groupRows([declaredUi, remoteTwin], config({ groupBy: 'project' }))
    expect(both.map((g) => g.label)).toEqual(['Mac mini WorkerDeck', 'Pi WorkerDeck'])
    expect(both[0]).toMatchObject({ gateway: 'Mac mini', project: 'WorkerDeck' })
    expect(groupRows([declaredUi], config({ groupBy: 'project' }))[0]?.gateway).toBeUndefined()
    expect(groupRows([declaredUi], config({ groupBy: 'project' }))[0]?.label).toBe('WorkerDeck')
    expect(groupRows([declaredUi], config({ groupBy: 'project' }), { gatewayCount: 2 })[0]?.label).toBe('Mac mini WorkerDeck')
  })

  it('carries where a session started from a project heading runs', () => {
    const [group] = groupRows([declaredUi], config({ groupBy: 'project' }))
    expect(group).toMatchObject({ hostId: 'mac', cwd: '/work/deck' })
    expect(groupRows([undeclared], config({ groupBy: 'project' }))[0]).toMatchObject({ hostId: 'mac', cwd: '/work/alpha' })
    expect(groupRows([nowhere], config({ groupBy: 'project' }))[0]?.cwd).toBeUndefined()
  })

  it('filters by project key, and a config predating the field filters nothing', () => {
    const rows = [declaredUi, undeclared]
    const filtered = filterRows(rows, config({ scoped: false, projects: [projectKey(declaredUi)] }))
    expect(filtered.map((r) => r.info.id)).toEqual(['p1'])
    const legacy = config({ scoped: false })
    delete (legacy as { projects?: string[] }).projects
    expect(filterRows(rows, legacy).length).toBe(2)
    expect(hasFacetFilter(legacy)).toBe(false)
  })

  it('matches search against the declared project name', () => {
    const found = filterRows([declaredUi, undeclared], config({ scoped: false, search: 'workerdeck' }))
    expect(found.map((r) => r.info.id)).toEqual(['p1'])
  })

  it('counts a project filter into the subset line and clearFilters resets it', () => {
    const filtered = config({ projects: ['mac:/work/deck'], scoped: false })
    expect(subsetSummary(filtered, undefined, 1, 2)?.causes).toEqual(['1 filter'])
    expect(hasFacetFilter(filtered)).toBe(true)
    expect(clearFilters(filtered).projects).toEqual([])
  })
})

function shell(over: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id: 'sh_1',
    sessionId: 'sess-00000001',
    ordinal: 1,
    command: 'npm run dev',
    label: 'npm run dev',
    cwd: '/work/alpha',
    owner: 'user',
    status: 'running',
    startedAt: 0,
    bytes: 0,
    cols: 120,
    rows: 40,
    ...over,
  }
}

describe('promotedShells', () => {
  it('keeps a running shell hidden until the debounce elapses', () => {
    const running = shell({ status: 'running', startedAt: 1000 })
    expect(promotedShells(info({ shells: [running] }), 1000 + 2999)).toEqual([])
    expect(promotedShells(info({ shells: [running] }), 1000 + 3000)).toEqual([running])
  })

  it('vanishes a zero exit immediately, even long after it ran', () => {
    const clean = shell({ status: 'exited', startedAt: 0, endedAt: 10_000, exitCode: 0 })
    expect(promotedShells(info({ shells: [clean] }), 10_000)).toEqual([])
    expect(promotedShells(info({ shells: [clean] }), 10_001)).toEqual([])
  })

  it('lingers a non-zero exit for SHELL_LINGER_MS, then drops it', () => {
    const failed = shell({ status: 'exited', startedAt: 0, endedAt: 3000, exitCode: 1 })
    expect(promotedShells(info({ shells: [failed] }), 3000)).toEqual([failed])
    expect(promotedShells(info({ shells: [failed] }), 3000 + 60_000 - 1)).toEqual([failed])
    expect(promotedShells(info({ shells: [failed] }), 3000 + 60_000)).toEqual([])
  })

  // A killed shell and one reconciled from a restart report no exit code at all, and the linger is for a failure the
  // operator has not been told about yet. Both of these they already know.
  it('does not linger a killed shell, which has no exit code', () => {
    const killed = shell({ status: 'exited', startedAt: 0, endedAt: 3000, endReason: 'killed' })
    expect(promotedShells(info({ shells: [killed] }), 3000)).toEqual([])
    expect(promotedShells(info({ shells: [killed] }), 3001)).toEqual([])
  })

  it('does not linger a shell reconciled from a gateway restart', () => {
    const stale = shell({ status: 'exited', startedAt: 0, endedAt: 3000, endReason: 'server_restarted' })
    expect(promotedShells(info({ shells: [stale] }), 3000)).toEqual([])
  })
})

describe('normalizeViewConfig', () => {
  it('reads a stored gateway grouping as project, and an unknown one as the default', () => {
    expect(normalizeViewConfig({ groupBy: 'gateway' as never }).groupBy).toBe('project')
    expect(normalizeViewConfig({ groupBy: 'bogus' as never }).groupBy).toBe(DEFAULT_VIEW_CONFIG.groupBy)
    expect(normalizeViewConfig(undefined)).toEqual(DEFAULT_VIEW_CONFIG)
  })
})

describe('custom groups', () => {
  const a = row({ info: info({ id: 'a', lastActivityAt: 3 }) })
  const b = row({ info: info({ id: 'b', lastActivityAt: 2 }) })
  const c = row({ hostId: 'pi', hostName: 'Pi', info: info({ id: 'a', lastActivityAt: 1 }) })
  const groups = [
    { id: 'g1', name: 'Review', members: [sessionKey(b), sessionKey(c)] },
    { id: 'g2', name: 'Empty', members: [] },
  ]

  it('draws groups in stored order, members in member order, the rest ungrouped by the sort', () => {
    const out = groupRows([a, b, c], config({ groupBy: 'custom', customGroups: groups }))
    expect(out.map((g) => g.key)).toEqual(['custom:g1', 'custom:g2', UNGROUPED_KEY])
    expect(out[0]?.rows).toEqual([b, c])
    expect(out[1]?.rows).toEqual([])
    expect(out[2]?.rows).toEqual([a])
  })

  it('keys members per gateway, since session ids are unique only per gateway', () => {
    expect(sessionKey(a)).not.toBe(sessionKey(c))
  })

  it('omits the ungrouped bucket when every session is placed, and ignores members that are gone', () => {
    const out = groupRows([b], config({ groupBy: 'custom', customGroups: groups }))
    expect(out.map((g) => g.key)).toEqual(['custom:g1', 'custom:g2'])
    expect(out[0]?.rows).toEqual([b])
  })

  it('moves a session between groups, above a member or at the end, and out to ungrouped', () => {
    const into = moveToCustomGroup(groups, sessionKey(a), 'g1', sessionKey(c))
    expect(into[0]?.members).toEqual([sessionKey(b), sessionKey(a), sessionKey(c)])
    const across = moveToCustomGroup(into, sessionKey(a), 'g2')
    expect(across[0]?.members).toEqual([sessionKey(b), sessionKey(c)])
    expect(across[1]?.members).toEqual([sessionKey(a)])
    expect(moveToCustomGroup(across, sessionKey(a), undefined).every((g) => !g.members.includes(sessionKey(a)))).toBe(true)
  })

  it('adds, reorders and removes groups', () => {
    const added = addCustomGroup(groups, 'Later', 'g3')
    expect(added.map((g) => g.id)).toEqual(['g1', 'g2', 'g3'])
    expect(moveCustomGroup(added, 'g3', 'g1').map((g) => g.id)).toEqual(['g3', 'g1', 'g2'])
    expect(moveCustomGroup(added, 'g1', undefined).map((g) => g.id)).toEqual(['g2', 'g3', 'g1'])
    expect(removeCustomGroup(added, 'g2').map((g) => g.id)).toEqual(['g1', 'g3'])
  })

  it('survives clearFilters', () => {
    expect(clearFilters(config({ groupBy: 'custom', customGroups: groups, search: 'x' })).customGroups).toBe(groups)
  })
})

describe('agent teams in the list', () => {
  function agentRow(id: string, agent: SessionInfo['agent'], over: Partial<SessionInfo> = {}): SessionRow {
    return row({ info: info({ id, agent, ...over }) })
  }

  const lead = agentRow('s-lead', { id: 'A', name: 'Atlas', avatar: '/a', leads: true }, { lastActivityAt: 10 })
  const pip = agentRow('s-pip', { id: 'P', name: 'Pip', avatar: '/p', lead: 'A', team: 'Atlas', order: 1 }, { pendingPermissionCount: 1 })
  const juno = agentRow('s-juno', { id: 'J', name: 'Juno', avatar: '/j', lead: 'A', team: 'Atlas', order: 0 }, { status: 'running' })
  const solo = agentRow('s-solo', { id: 'M', name: 'Marlow', avatar: '/m' }, { lastActivityAt: 5 })
  const oneOff = row({ info: info({ id: 's-old', status: 'closed' }) })
  const all = [lead, pip, juno, solo, oneOff]

  it('draws members under their lead in team order, never top-level', () => {
    const [group] = groupRows(all, { ...DEFAULT_VIEW_CONFIG, groupBy: 'none' })
    expect(group!.rows.map((r) => r.info.id)).toEqual(['s-lead', 's-solo'])
    expect(group!.rows[0]!.members?.map((r) => r.info.id)).toEqual(['s-juno', 's-pip'])
  })

  it('places a team by its most urgent state', () => {
    const groups = groupRows(all, { ...DEFAULT_VIEW_CONFIG, groupBy: 'state' })
    expect(groups[0]!.key).toBe('attention')
    expect(groups[0]!.rows.map((r) => r.info.id)).toEqual(['s-lead'])
    expect(groups[0]!.rows[0]!.teamState).toBe('attention')
  })

  it('keeps the lead as a dimmed context row when a filter matches only a member', () => {
    const working = { ...DEFAULT_VIEW_CONFIG, groupBy: 'none' as const, states: ['working' as const] }
    const [group] = groupRows(filterRows(all, working), working, { all })
    expect(group!.rows).toHaveLength(1)
    expect(group!.rows[0]).toMatchObject({ context: true, info: { id: 's-lead' } })
    expect(group!.rows[0]!.members?.map((r) => r.info.id)).toEqual(['s-juno'])
  })

  it('leaves a member top-level when its lead is not in the list at all', () => {
    const [group] = groupRows([pip, solo], { ...DEFAULT_VIEW_CONFIG, groupBy: 'none' })
    expect(group!.rows.map((r) => r.info.id).sort()).toEqual(['s-pip', 's-solo'])
  })

  it('folds ended one-off sessions into a trailing Earlier group, except under state and custom grouping', () => {
    const groups = groupRows(all, { ...DEFAULT_VIEW_CONFIG, groupBy: 'project' })
    expect(groups.at(-1)).toMatchObject({ key: 'earlier', earlier: true })
    expect(groups.at(-1)!.rows.map((r) => r.info.id)).toEqual(['s-old'])
    expect(groupRows(all, { ...DEFAULT_VIEW_CONFIG, groupBy: 'state' }).some((g) => g.earlier)).toBe(false)
  })

  it('toggles collapse per team key and sums the members for the folded summary', () => {
    const [group] = groupRows(all, { ...DEFAULT_VIEW_CONFIG, groupBy: 'none' })
    const unit = group!.rows[0]!
    const folded = toggleTeamCollapsed(DEFAULT_VIEW_CONFIG, unit)
    expect(folded.collapsedTeams).toEqual(['mac:A'])
    expect(isTeamCollapsed(folded, unit)).toBe(true)
    expect(isTeamCollapsed(toggleTeamCollapsed(folded, unit), unit)).toBe(false)
    expect(teamSummary(unit)).toEqual({ members: 2, working: 1, attention: 1, unseen: 0 })
  })
})
