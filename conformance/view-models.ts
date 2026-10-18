import { DEFAULT_VIEW_CONFIG, sessionState, unseenCount } from '@workerdeck/protocol'
import type {
  AgentInfo,
  AgentRef,
  ModelOption,
  ProfileUsage,
  SessionInfo,
  SessionRow,
  ShellInfo,
  SubagentInfo,
  ViewConfig,
  WorkspaceScope,
} from '@workerdeck/protocol'

export type VmCase = { module: string; name: string; fn: string; calls: unknown[][] }

const T0 = 1_760_000_000_000

function info(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, status: 'idle', cwd: '/work/alpha', createdAt: T0, lastSeq: 0, pendingPermissionCount: 0, ...over }
}

function row(hostId: string, inf: SessionInfo, over: Partial<SessionRow> = {}): SessionRow {
  const hosts: Record<string, [string, boolean]> = { mac: ['Mac mini', true], box: ['Build Box', false], pi: ['pibo', false] }
  const [hostName, local] = hosts[hostId] ?? [hostId, false]
  const mark = { itemCount: 0, activity: 0, prose: 2, turns: 0, seenAt: T0 }
  return {
    hostId,
    hostName,
    local,
    adapter: inf.engine ?? 'claude',
    state: sessionState(inf),
    info: inf,
    unseen: unseenCount(mark, inf),
    ...over,
  }
}

function sub(toolUseId: string, over: Partial<SubagentInfo> = {}): SubagentInfo {
  return { toolUseId, status: 'running', startedAt: T0, toolCount: 0, ...over }
}

function shell(id: string, over: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id,
    sessionId: 's-shells',
    ordinal: 1,
    command: 'npm run dev',
    label: 'dev',
    cwd: '/work/alpha',
    owner: 'agent',
    status: 'running',
    startedAt: T0,
    bytes: 120,
    cols: 80,
    rows: 24,
    ...over,
  }
}

const WD = { name: 'WorkerDeck', root: '/work/workerdeck', shortcode: 'WD' }
const API = { name: 'api', root: '/work/api' }

const lead: AgentRef = { id: 'ag-lead', name: 'WD-Lead', leads: true, avatar: 'monkey:12' }

const SHELLS = [
  shell('sh-fresh', { startedAt: T0 + 9_000 }),
  shell('sh-dev', { startedAt: T0 }),
  shell('sh-ok', { status: 'exited', startedAt: T0, endedAt: T0 + 5_000, exitCode: 0, endReason: 'exit' }),
  shell('sh-fail', { status: 'exited', startedAt: T0, endedAt: T0 + 5_000, exitCode: 1, endReason: 'exit' }),
  shell('sh-quick-fail', { status: 'exited', startedAt: T0, endedAt: T0 + 500, exitCode: 2, endReason: 'exit' }),
  shell('sh-killed', { status: 'exited', startedAt: T0, endedAt: T0 + 5_000, endReason: 'killed', signal: 15 }),
  shell('sh-restart', { status: 'exited', startedAt: T0, endedAt: T0 + 5_000, endReason: 'server_restarted' }),
]

const ROWS: SessionRow[] = [
  row(
    'mac',
    info('s-lead-0001', {
      title: 'WD-Lead',
      cwd: '/work/workerdeck',
      project: WD,
      agent: lead,
      owner: 'tobias',
      lastActivityAt: T0 + 5_000,
      proseCount: 12,
      numTurns: 4,
      model: 'opus',
      effort: null,
      permissionMode: 'default',
      statusLabel: { text: 'Reviewing the port', emoji: '🦀', setAt: T0 + 4_000 },
      contextUsage: { totalTokens: 52_000, maxTokens: 200_000, percentage: 26 },
      usageByModel: { 'claude-opus-5-5': { input: 1200, output: 800, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 40_000 } },
    }),
  ),
  row(
    'mac',
    info('s-review-02', {
      title: 'WD-Review',
      status: 'running',
      cwd: '/work/workerdeck/packages/ui',
      project: WD,
      agent: { id: 'ag-review', name: 'WD-Review', lead: 'ag-lead', team: 'WD-Lead', order: 2 },
      lastActivityAt: T0 + 7_000,
      createdAt: T0 + 100,
      engine: 'codex',
      proseCount: 3,
    }),
  ),
  row(
    'mac',
    info('s-art-0003', {
      title: 'WD-Art',
      cwd: '/work/workerdeck',
      project: WD,
      pendingPermissionCount: 1,
      agent: { id: 'ag-art', name: 'WD-Art', lead: 'ag-lead', team: 'WD-Lead', order: 1 },
      lastActivityAt: T0 + 1_000,
      createdAt: T0 + 200,
    }),
  ),
  row('mac', info('s-solo-0004', { title: 'Fix login bug', status: 'closed', cwd: '/work/api', project: API, lastActivityAt: T0 + 9_000 })),
  row('mac', info('job12345abcdef', { status: 'failed', cwd: '/work/api/', meta: { jobId: 'job-7', attempt: 2 }, lastActivityAt: T0 + 2_000 })),
  row(
    'mac',
    info('s-codex-0006', {
      title: 'api refactor',
      engine: 'codex',
      cwd: '/work/api/src',
      project: API,
      subagents: [
        sub('tu-1', { agentType: 'Explore', description: 'find the auth check', toolCount: 4 }),
        sub('tu-2', { status: 'done', description: 'write tests', toolCount: 2 }),
      ],
      lastActivityAt: T0 + 3_000,
      proseCount: 2,
    }),
  ),
  row(
    'box',
    info('s-remote-07', {
      title: 'AC-MagWin',
      cwd: '/srv/magwin',
      agent: { id: 'ag-magwin', name: 'AC-MagWin', lead: 'mini:ag-lead', leadGateway: 'mini', team: 'WD-Lead', order: 3 },
      lastActivityAt: T0 + 6_000,
    }),
  ),
  row('box', info('s-windows-8', { title: 'Ápi check', cwd: 'C:\\work\\api\\', lastActivityAt: T0 + 6_000 })),
  row('mac', info('s-shells-09', { title: 'dev server', shells: SHELLS, shellAgentWrite: 'gated', lastActivityAt: T0 + 4_000 })),
  row('pi', info('s-provider-10', { title: 'sandbox chat', cwd: '', engine: 'provider', status: 'starting', createdAt: T0 + 50 })),
  row(
    'mac',
    info('s-solo-agent', {
      title: 'Solo agent',
      cwd: '/work/alpha',
      agent: { id: 'ag-solo', name: 'Solo', shared: true, conversation: 2 },
      engineAsleep: true,
      lastActivityAt: T0 + 4_000,
    }),
  ),
  row(
    'mac',
    info('s-orphan-12', {
      title: 'orphan member',
      cwd: '/work/beta',
      status: 'awaiting_approval',
      agent: { id: 'ag-orphan', name: 'Orphan', lead: 'ag-gone', order: 1 },
      lastActivityAt: T0 + 4_000,
    }),
  ),
  row('mac', info('s-ended-agent', { title: '_underscored', status: 'closed', agent: { id: 'ag-old', name: 'Old' }, lastActivityAt: T0 + 100 })),
]

const BY_ID = new Map(ROWS.map((r) => [r.info.id, r]))
function pick(...ids: string[]): SessionRow[] {
  return ids.map((id) => BY_ID.get(id)!)
}

function quiet(id: string, order: number, over: Partial<SessionInfo> = {}, unseen = 0): SessionRow {
  const agent = { id: `ag-${id}`, name: id, lead: 'ag-lead', team: 'WD-Lead', order }
  return { ...row('mac', info(id, { title: id, agent, lastActivityAt: T0, ...over })), unseen }
}

// A lead with every reason a member shows in Auto: working, attention, unread, lingering, and two quiet ones.
const TEAM: SessionRow = {
  ...BY_ID.get('s-lead-0001')!,
  members: [
    BY_ID.get('s-art-0003')!,
    BY_ID.get('s-review-02')!,
    quiet('s-quiet-a', 3),
    quiet('s-unread', 4, {}, 2),
    quiet('s-linger', 5, { lastActivityAt: T0 + 57_000 }),
    quiet('s-quiet-b', 6),
  ],
}

const CUSTOM = [
  { id: 'g-core', name: 'Core', members: ['mac:s-codex-0006', 'box:s-windows-8', 'mac:missing'], color: '#3f8f6b' },
  { id: 'g-ops', name: 'Ops', members: ['mac:s-shells-09', 'mac:s-codex-0006'] },
  { id: 'g-empty', name: 'Empty', members: [], icon: 'data:image/png;base64,AAAA' },
]

function config(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...DEFAULT_VIEW_CONFIG, ...over }
}

const SCOPE: WorkspaceScope = { label: 'workerdeck', roots: [{ path: '/work/workerdeck/' }, { hostId: 'BOX', path: 'C:\\work\\api' }] }

function groupCases(): VmCase[] {
  const calls: unknown[][] = []
  const cases: VmCase[] = []
  for (const groupBy of ['none', 'state', 'adapter', 'project', 'custom'] as const) {
    for (const sortBy of ['recent', 'name', 'gateway', 'adapter', 'state', 'project'] as const) {
      calls.push([ROWS, config({ groupBy, sortBy, customGroups: CUSTOM }), { relayHosts: { mini: 'mac' } }])
    }
  }
  cases.push({ module: 'session-list', name: 'group-matrix', fn: 'groupRows', calls })
  const filtered = pick('s-review-02', 's-remote-07', 's-orphan-12', 's-solo-0004')
  cases.push({
    module: 'session-list',
    name: 'group-teams',
    fn: 'groupRows',
    calls: [
      [ROWS, config({ groupBy: 'none' })],
      [filtered, config({ groupBy: 'project' }), { all: ROWS, relayHosts: { mini: 'mac' } }],
      [filtered, config({ groupBy: 'state' }), { all: ROWS }],
      [filtered, config({ groupBy: 'project' }), { all: ROWS, gatewayCount: 1 }],
      [pick('s-art-0003'), config({ groupBy: 'none', sortBy: 'name' }), { all: ROWS }],
      [pick('s-lead-0001', 's-art-0003'), config({ groupBy: 'project' }), { gatewayCount: 3 }],
      [[], config()],
      [[], config({ groupBy: 'custom', customGroups: CUSTOM })],
      [pick('s-codex-0006', 's-windows-8', 's-shells-09'), config({ groupBy: 'custom', customGroups: CUSTOM })],
    ],
  })
  return cases
}

const RELAYS = {
  mac: { gateway: 'mini', owner: 'tobias', online: true, features: ['owners', 'teams'] },
  box: undefined,
  pi: { gateway: 'pibo', owners: ['dan', 'ruli'], ownersDefaulted: true, online: false, features: [] },
}

const SESSION_LIST: VmCase[] = [
  ...groupCases(),
  { module: 'session-list', name: 'session-state', fn: 'sessionState', calls: ROWS.map((r) => [r.info]) },
  {
    module: 'session-list',
    name: 'session-state-edges',
    fn: 'sessionState',
    calls: [
      [info('a', { status: 'closed', subagents: [sub('x')] })],
      [info('b', { status: 'failed', pendingPermissionCount: 2 })],
      [info('c', { status: 'parked' })],
      [info('d', { status: 'idle', subagents: [sub('x', { status: 'done' })] })],
      [info('e', { status: 'running', subagents: [sub('x')], pendingPermissionCount: 1 })],
    ],
  },
  {
    module: 'session-list',
    name: 'subagents',
    fn: 'visibleSubagents',
    calls: ['all', 'active', 'none'].map((show) => [BY_ID.get('s-codex-0006')!.info, show]),
  },
  { module: 'session-list', name: 'running-subagents', fn: 'runningSubagents', calls: ROWS.map((r) => [r.info]) },
  {
    module: 'session-list',
    name: 'subagent-labels',
    fn: 'subagentLabel',
    calls: [
      [sub('a', { agentType: 'Explore', description: 'find the auth check' })],
      [sub('b', { agentType: '  Plan  ' })],
      [sub('c', { description: ' write tests ' })],
      [sub('d', { agentType: '  ', description: '' })],
      [sub('e')],
    ],
  },
  {
    module: 'session-list',
    name: 'agent-records',
    fn: 'isAgentRecord',
    calls: [[sub('a', { agentType: 'Explore' })], [sub('b', { isAgent: true })], [sub('c', { agentType: '   ' })], [sub('d', { description: 'x' })]],
  },
  { module: 'session-list', name: 'relay-hosts', fn: 'relayHostsOf', calls: [[RELAYS], [{}]] },
  { module: 'session-list', name: 'session-keys', fn: 'sessionKey', calls: ROWS.slice(0, 4).map((r) => [r]) },
  {
    module: 'session-list',
    name: 'normalize-view-config',
    fn: 'normalizeViewConfig',
    calls: [
      [undefined],
      [{}],
      [{ groupBy: 'gateway' }],
      [{ groupBy: 'banana', sortBy: 'name' }],
      [{ groupBy: 'custom', customGroups: CUSTOM, collapsedGroups: ['custom:g-ops'], earlierOpen: true, subagents: 'all' }],
      [{ search: 'api', gateways: ['mac'], states: ['working'], scoped: false, shells: 'none', tasks: 'all', collapsedTeams: ['mac:ag-lead'], expandedTeams: ['mac:ag-x'] }],
    ],
  },
  { module: 'session-list', name: 'adapters', fn: 'adaptersOf', calls: [[ROWS], [[]]] },
  { module: 'session-list', name: 'projects', fn: 'projectsOf', calls: [[ROWS], [[]]] },
  { module: 'session-list', name: 'session-labels', fn: 'sessionLabel', calls: ROWS.map((r) => [r.info]) },
  { module: 'session-list', name: 'project-keys', fn: 'projectKey', calls: ROWS.map((r) => [r]) },
  { module: 'session-list', name: 'project-labels', fn: 'projectLabel', calls: ROWS.map((r) => [r]) },
  { module: 'session-list', name: 'project-names', fn: 'projectName', calls: ROWS.map((r) => [r]) },
  {
    module: 'session-list',
    name: 'project-subpaths',
    fn: 'projectSubpath',
    calls: [
      ...ROWS.map((r) => [r]),
      [row('mac', info('x', { cwd: '/work/workerdeck-2/src', project: WD }))],
      [row('mac', info('y', { cwd: '/work/workerdeck/', project: WD }))],
      [row('mac', info('z', { cwd: 'C:\\work\\workerdeck\\apps\\ios', project: { name: 'WD', root: 'C:/work/workerdeck/' } }))],
    ],
  },
  { module: 'session-list', name: 'job-runs', fn: 'isJobRun', calls: [...ROWS.map((r) => [r.info]), [info('j', { meta: { jobId: 7 } })]] },
  {
    module: 'session-list',
    name: 'promoted-shells',
    fn: 'promotedShells',
    calls: [10_000, 12_000, 64_000, 66_000].map((at) => [BY_ID.get('s-shells-09')!.info, T0 + at]),
  },
  {
    module: 'session-list',
    name: 'visible-shells',
    fn: 'visibleShells',
    calls: (['all', 'active', 'none'] as const).flatMap((show) => [10_000, 12_000].map((at) => [BY_ID.get('s-shells-09')!.info, show, T0 + at])),
  },
  {
    module: 'session-list',
    name: 'in-scope',
    fn: 'inScope',
    calls: [
      ...ROWS.map((r) => [r, SCOPE]),
      [row('mac', info('w', { cwd: '/work/workerdeck-2' })), SCOPE],
      [row('mac', info('v', { cwd: '/work/workerdeck\\sub' })), SCOPE],
    ],
  },
  {
    module: 'session-list',
    name: 'scope-active',
    fn: 'scopeActive',
    calls: [
      [config(), SCOPE],
      [config(), undefined],
      [config({ scoped: false }), SCOPE],
    ],
  },
  {
    module: 'session-list',
    name: 'filter-rows',
    fn: 'filterRows',
    calls: [
      [ROWS, config()],
      [ROWS, config(), SCOPE],
      [ROWS, config({ scoped: false }), SCOPE],
      [ROWS, config({ search: '  WD  ' })],
      [ROWS, config({ search: 'build box' })],
      [ROWS, config({ search: 'codex' })],
      [ROWS, config({ search: 's-solo' })],
      [ROWS, config({ search: 'olo-0004' })],
      [ROWS, config({ search: 'orphan' })],
      [ROWS, config({ search: 'workerdeck' })],
      [ROWS, config({ gateways: ['mac'], adapters: ['codex'] })],
      [ROWS, config({ states: ['working', 'attention'] })],
      [ROWS, config({ projects: ['mac:/work/api'] })],
      [ROWS, config({ projects: undefined })],
    ],
  },
  {
    module: 'session-list',
    name: 'team-keys',
    fn: 'teamKey',
    calls: ROWS.map((r) => [r]),
  },
  {
    module: 'session-list',
    name: 'team-state',
    fn: 'teamState',
    calls: [[ROWS], [pick('s-lead-0001', 's-review-02')], [pick('s-solo-0004')], [[]]],
  },
  {
    module: 'session-list',
    name: 'team-expand',
    fn: 'toggleTeamExpanded',
    calls: [
      [config(), BY_ID.get('s-lead-0001')],
      [config({ expandedTeams: ['mac:ag-lead', 'box:ag-x'] }), BY_ID.get('s-lead-0001')],
      [config(), BY_ID.get('s-solo-0004')],
    ],
  },
  {
    module: 'session-list',
    name: 'team-expanded',
    fn: 'isTeamExpanded',
    calls: [
      [config({ expandedTeams: ['mac:ag-lead'] }), BY_ID.get('s-lead-0001')],
      [config(), BY_ID.get('s-lead-0001')],
      [config({ expandedTeams: ['mac:ag-lead'] }), BY_ID.get('s-solo-0004')],
    ],
  },
  {
    module: 'session-list',
    name: 'team-view',
    fn: 'teamView',
    calls: [
      [TEAM, config(), undefined, T0 + 60_000],
      [TEAM, config(), 'mac:s-quiet-a', T0 + 60_000],
      [TEAM, config(), undefined, T0 + 100_000],
      [TEAM, config({ expandedTeams: ['mac:ag-lead'] }), undefined, T0 + 60_000],
      [TEAM, config({ search: 'quiet' }), undefined, T0 + 60_000],
      [BY_ID.get('s-solo-0004'), config(), undefined, T0],
    ],
  },
  {
    module: 'session-list',
    name: 'team-linger-ends',
    fn: 'teamLingerEnds',
    calls: [
      [{ expanded: false, shown: TEAM.members!, tray: [] }, T0 + 60_000],
      [{ expanded: false, shown: TEAM.members!, tray: [] }, T0 + 100_000],
      [{ expanded: false, shown: [], tray: [] }, T0],
    ],
  },
  {
    module: 'session-list',
    name: 'group-collapse',
    fn: 'toggleGroupCollapsed',
    calls: [
      [config(), { key: 'custom:g-core' }],
      [config({ collapsedGroups: ['custom:g-core', 'custom:g-ops'] }), { key: 'custom:g-core' }],
    ],
  },
  {
    module: 'session-list',
    name: 'group-collapsed',
    fn: 'isGroupCollapsed',
    calls: [
      [config({ collapsedGroups: ['custom:g-core'] }), { key: 'custom:g-core' }],
      [config(), { key: 'custom:g-core' }],
    ],
  },
  {
    module: 'session-list',
    name: 'summaries',
    fn: 'groupSummary',
    calls: [[{ rows: ROWS }], [{ rows: [] }], [{ rows: [{ ...BY_ID.get('s-lead-0001')!, members: pick('s-review-02', 's-art-0003') }] }]],
  },
  {
    module: 'session-list',
    name: 'team-summaries',
    fn: 'teamSummary',
    calls: [[{ ...BY_ID.get('s-lead-0001')!, members: pick('s-review-02', 's-art-0003', 's-remote-07') }], [BY_ID.get('s-solo-0004')]],
  },
  {
    module: 'session-list',
    name: 'custom-group-edits',
    fn: 'customGroupScript',
    calls: [
      [CUSTOM, ['add', 'Fresh', 'g-new']],
      [CUSTOM, ['rename', 'g-ops', 'Operations']],
      [CUSTOM, ['rename', 'g-missing', 'Nope']],
      [CUSTOM, ['remove', 'g-core']],
      [CUSTOM, ['moveTo', 'mac:s-shells-09', 'g-core', 'box:s-windows-8']],
      [CUSTOM, ['moveTo', 'mac:s-shells-09', 'g-core', 'mac:nowhere']],
      [CUSTOM, ['moveTo', 'mac:s-codex-0006', undefined]],
      [CUSTOM, ['moveTo', 'mac:s-lead-0001', 'g-empty']],
      [CUSTOM, ['move', 'g-empty', 'g-core']],
      [CUSTOM, ['move', 'g-core', undefined]],
      [CUSTOM, ['move', 'g-core', 'g-core']],
      [CUSTOM, ['move', 'g-missing', 'g-core']],
      [CUSTOM, ['move', 'g-ops', 'g-missing']],
      [CUSTOM, ['style', 'g-core', { color: null }]],
      [CUSTOM, ['style', 'g-ops', { color: '#a85a6e', icon: 'data:image/png;base64,QUJD' }]],
      [CUSTOM, ['style', 'g-empty', { icon: null }]],
      [CUSTOM, ['style', 'g-ops', { icon: 'https://example.com/x.png' }]],
      [CUSTOM, ['style', 'g-ops', { icon: `data:image/png;base64,${'A'.repeat(48_000)}` }]],
    ],
  },
  { module: 'session-list', name: 'custom-group-colors', fn: 'customGroupColor', calls: CUSTOM.map((g) => [g]) },
  {
    module: 'session-list',
    name: 'subset-summary',
    fn: 'subsetSummary',
    calls: [
      [config(), SCOPE, 5, 5],
      [config({ search: 'x', gateways: ['mac'], states: ['idle'] }), SCOPE, 2, 9],
      [config({ scoped: false, adapters: ['codex'] }), SCOPE, 2, 9],
      [config({ projects: ['mac:/work/api'] }), undefined, 1, 9],
      [config({ search: '   ' }), undefined, 1, 9],
    ],
  },
  {
    module: 'session-list',
    name: 'filter-engagement',
    fn: 'filterEngagement',
    calls: [
      [config()],
      [config({ search: ' x ' })],
      [config({ gateways: ['mac'], projects: ['mac:/w'], subagents: 'all' })],
      [config({ shells: 'none' })],
      [config({ tasks: undefined, shells: undefined })],
      [config({ scoped: true, tasks: 'all' })],
    ],
  },
  {
    module: 'session-list',
    name: 'clear-filters',
    fn: 'clearFilters',
    calls: [
      [config()],
      [
        config({
          search: 'api',
          gateways: ['mac'],
          adapters: ['codex'],
          states: ['idle'],
          projects: ['mac:/work/api'],
          groupBy: 'custom',
          sortBy: 'name',
          subagents: 'none',
          shells: 'all',
          tasks: 'none',
          customGroups: CUSTOM,
          expandedTeams: ['mac:ag-lead'],
          collapsedGroups: ['custom:g-ops'],
          earlierOpen: true,
        }),
      ],
    ],
  },
]

function agentInfo(id: string, over: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name: id.toUpperCase(), createdAt: T0, updatedAt: T0, pastSessions: [], config: {}, ...over }
}

const REFS: Record<string, AgentRef | undefined> = {
  none: undefined,
  lead: { id: 'L', name: 'Lead', leads: true },
  member: { id: 'M1', name: 'One', lead: 'L' },
  sibling: { id: 'M2', name: 'Two', lead: 'L' },
  stranger: { id: 'M3', name: 'Three', lead: 'X' },
  solo: { id: 'S', name: 'Solo' },
  shared: { id: 'SH', name: 'Shared', shared: true },
  sharedOther: { id: 'SH2', name: 'Shared two', shared: true },
  sharedMember: { id: 'SM', name: 'Shared member', shared: true, lead: 'L' },
}

function partyMatrix(): unknown[][] {
  const owners = [undefined, 'tobias', 'dan']
  const modes = [undefined, 'default', 'bypassPermissions', 'dontAsk']
  const calls: unknown[][] = []
  const keys = Object.keys(REFS)
  for (const from of keys) {
    for (const to of keys) {
      calls.push([{ owner: 'tobias', agent: REFS[from] }, { owner: 'tobias', agent: REFS[to] }, true])
      calls.push([{ owner: 'tobias', agent: REFS[from] }, { owner: 'dan', agent: REFS[to] }, true])
    }
  }
  for (const a of owners) {
    for (const b of owners) {
      for (const mode of modes) {
        for (const multi of [false, true]) {
          calls.push([{ owner: a, agent: REFS.shared }, { owner: b, agent: REFS.sharedOther, permissionMode: mode }, multi])
          calls.push([{ owner: a, agent: REFS.lead }, { owner: b, agent: REFS.member, permissionMode: mode }, multi])
        }
      }
    }
  }
  return calls
}

const REF_PAIRS = Object.keys(REFS).flatMap((a) => Object.keys(REFS).map((b) => [REFS[a], REFS[b]]))

const AGENTS: VmCase[] = [
  {
    module: 'agents',
    name: 'agent-ref',
    fn: 'agentRef',
    calls: [
      [agentInfo('ag-1', { avatar: 'monkey:3', sharing: 'shared', pastSessions: ['s1', 's2'], order: 4 }), {}],
      [agentInfo('ag-2', { lead: 'ag-1', sharing: 'shared', order: 0 }), { leadName: 'Lead', leadGateway: 'mini' }],
      [agentInfo('ag-3', { lead: 'ag-1' }), { leadName: 'Lead' }],
      [agentInfo('ag-4', { sharing: 'private', owner: 'dan' }), { leads: true, leadName: 'ignored' }],
      [agentInfo('ag-5', { config: { model: 'opus', permissionMode: 'plan' }, remoteMembers: [{ agent: 'x', state: 'invited', at: T0 }] }), { leads: false }],
    ],
  },
  { module: 'agents', name: 'team-role', fn: 'teamRole', calls: Object.values(REFS).map((r) => [r]) },
  { module: 'agents', name: 'team-reaches', fn: 'teamReaches', calls: REF_PAIRS },
  { module: 'agents', name: 'team-related', fn: 'teamRelated', calls: REF_PAIRS },
  { module: 'agents', name: 'peer-ops', fn: 'peerOps', calls: partyMatrix() },
  {
    module: 'agents',
    name: 'owner-names',
    fn: 'isOwnerName',
    calls: [['tobias'], ['ruli-2'], [''], ['Tobias'], ['a'.repeat(32)], ['a'.repeat(33)], ['dan_x'], ['dän']],
  },
  {
    module: 'agents',
    name: 'qualify',
    fn: 'qualifyAgent',
    calls: [[undefined, 'mini'], [REFS.lead, 'mini'], [REFS.member, 'mini'], [{ id: 'box:M', name: 'm', lead: 'box:L', order: 2 }, 'mini']],
  },
  {
    module: 'agents',
    name: 'project-accent',
    fn: 'projectAccent',
    calls: [['mac:/work/workerdeck'], ['box:C:/work/api'], [''], ['group:g-core'], ['ünïcödé 🦀'], ['pi:']],
  },
  {
    module: 'agents',
    name: 'new-agent-defaults',
    fn: 'newAgentDefaults',
    calls: [
      [undefined, undefined],
      [{ owner: 'tobias', sharing: 'shared', allowShared: true }, undefined],
      [{ owner: 'tobias', sharing: 'shared', allowShared: false }, { name: 'p', owner: 'dan', defaults: { sharing: 'shared' } }],
      [{ sharing: 'private', allowShared: true, multiOwner: true }, { name: 'p', defaults: { sharing: 'shared' } }],
      [{ sharing: 'shared', allowShared: true }, { name: 'p', defaults: { sharing: 'private' } }],
      [undefined, { name: 'p', owner: 'ruli' }],
    ],
  },
]

const USAGE = { input: 1_000_000, output: 200_000, cacheWrite5m: 50_000, cacheWrite1h: 10_000, cacheRead: 3_000_000 }

const BY_MODEL = {
  'claude-opus-5-5': USAGE,
  'claude-sonnet-4-5-20250929': { input: 12_345, output: 678, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 99_999, costBasis: 'list' as const },
  'mystery-model': { input: 500, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, costBasis: 'unknown' as const },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 777, output: 333, cacheWrite5m: 11, cacheWrite1h: 0, cacheRead: 5, costBasis: 'managed' as const },
}

const PRICING: VmCase[] = [
  { module: 'pricing', name: 'default-table', fn: 'defaultPricing', calls: [[]] },
  {
    module: 'pricing',
    name: 'canonical-model',
    fn: 'canonicalModel',
    calls: [
      'claude-opus-4-7[1m]',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-5@20250929',
      'anthropic/claude-opus-4-6',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-opus-4-5-v2:1',
      'eu.west.anthropic.anthropic.x',
      'Bedrock.Anthropic.Claude-Opus-5',
      'claude-opus-4-7-1m',
      'GPT-5.6-Sol',
      'openai/gpt-6-luna',
      'a[x[y]',
      'model]',
      '',
      'anthropic.',
      '9us.anthropic.claude',
    ].map((m) => [m]),
  },
  {
    module: 'pricing',
    name: 'rate-for',
    fn: 'rateFor',
    calls: [['claude-fable-5-1'], ['claude-opus-5-5[1m]'], ['gpt-5.2'], ['claude-haiku-5-5'], ['unknown-model'], [undefined], ['']],
  },
  {
    module: 'pricing',
    name: 'cost-of',
    fn: 'costOf',
    calls: [[USAGE, 'claude-opus-5-5'], [USAGE, 'gpt-6-sol'], [USAGE, 'nobody'], [{ ...USAGE, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, 'nobody'], [USAGE, undefined]],
  },
  { module: 'pricing', name: 'cost-of-by-model', fn: 'costOfByModel', calls: [[BY_MODEL], [{}], [{ 'mystery-model': BY_MODEL['mystery-model'] }]] },
  {
    module: 'pricing',
    name: 'token-usage-from-wire',
    fn: 'tokenUsageFromWire',
    calls: [
      [{ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 }],
      [{ input_tokens: 10, cache_creation_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 5 } }],
      [{ input_tokens: -4, output_tokens: 'x', cache_creation: null, cache_creation_input_tokens: 9 }],
      [null],
      ['junk'],
      [{ cache_creation: 0, cache_creation_input_tokens: 4 }],
    ],
  },
  {
    module: 'pricing',
    name: 'accumulation',
    fn: 'addTokenUsage',
    calls: [
      [USAGE, USAGE],
      [{ ...USAGE, costBasis: 'list' }, { ...USAGE, costBasis: 'unknown' }],
      [{ ...USAGE, costBasis: 'managed' }, USAGE],
    ],
  },
  { module: 'pricing', name: 'merge-by-model', fn: 'mergeByModel', calls: [[BY_MODEL, { 'claude-opus-5-5': USAGE, 'new-model': USAGE }], [{}, BY_MODEL]] },
  { module: 'pricing', name: 'totals', fn: 'byModelTotalTokens', calls: [[BY_MODEL], [{}]] },
  { module: 'pricing', name: 'unknown-basis', fn: 'unknownBasisModels', calls: [[BY_MODEL]] },
  { module: 'pricing', name: 'unpriced-models', fn: 'unpricedModels', calls: [[BY_MODEL]] },
  { module: 'pricing', name: 'worse-basis', fn: 'worseBasis', calls: [[undefined, 'list'], ['managed', undefined], ['list', 'unknown'], ['unknown', 'managed'], [undefined, undefined]] },
  { module: 'pricing', name: 'metered', fn: 'meteredCostOf', calls: [[BY_MODEL]] },
  {
    module: 'pricing',
    name: 'subscription',
    fn: 'subscriptionComparison',
    calls: [[120, 200], [0, 100], [50, 0], [-1, 100], [10, -5]],
  },
  {
    module: 'pricing',
    name: 'age',
    fn: 'pricingAge',
    calls: [
      [Date.parse('2026-10-08T12:00:00Z')],
      [Date.parse('2027-01-06T00:00:00Z')],
      [Date.parse('2027-01-07T00:00:00Z')],
      [Date.parse('2027-03-01T00:00:00Z'), '2026-02-28'],
      [Date.parse('2027-03-01T00:00:00Z'), 'not a date'],
      [Date.parse('2026-01-01T00:00:00Z'), '2026-10-08'],
    ],
  },
  {
    module: 'pricing',
    name: 'merge-pricing',
    fn: 'mergePricing',
    calls: [
      [{ 'claude-opus-5-5': { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 0.5 } }],
      [{ 'anthropic/claude-sonnet-4-5-20250929': { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 0 }, 'new/model[1m]': { input: 9, output: 9, cacheWrite5m: 9, cacheWrite1h: 9, cacheRead: 9 } }],
      [{ 'gpt-5': { input: 1, output: 2, cacheWrite5m: 3, cacheRead: 0 }, 'gpt-6-sol': { input: -1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 0 }, '': USAGE, x: null }],
      [null],
      [[1, 2]],
    ],
  },
]

const PROFILE_USAGE: ProfileUsage = {
  seven_day_sonnet: { info: { status: 'allowed', utilization: 0.31, resetsAt: T0 + 86_400_000 }, updatedAt: T0 },
  five_hour: { info: { status: 'allowed', utilization: 0.72, rateLimitType: 'five_hour', resetsAt: T0 + 3_600_000 }, updatedAt: T0 - 1_000_000 },
  seven_day_opus: { info: { status: 'allowed_warning', utilization: 0.9 }, updatedAt: T0, inferredReset: true },
  seven_day: { info: { status: 'allowed', utilization: 0.44, isUsingOverage: false }, updatedAt: T0 },
  overage: { info: { status: 'rejected' }, updatedAt: T0 },
  'seven_day_oauth-apps': { info: { status: 'allowed', utilization: 0 }, updatedAt: T0 },
}

const USAGE_CASES: VmCase[] = [
  {
    module: 'usage',
    name: 'merge',
    fn: 'mergeUsage',
    calls: [
      [{ rateLimits: { five_hour: { status: 'allowed', utilization: 0.1 }, seven_day: { status: 'allowed', utilization: 0.2 } }, updatedAt: T0 + 5 }, PROFILE_USAGE],
      [{ rateLimits: { five_hour: { status: 'allowed', utilization: 0.1 } } }, undefined],
      [{}, PROFILE_USAGE],
    ],
  },
  {
    module: 'usage',
    name: 'stale',
    fn: 'usageIsStale',
    calls: [
      [{ updatedAt: T0 }, T0 + 15 * 60_000],
      [{ updatedAt: T0 }, T0 + 15 * 60_000 + 1],
      [{ updatedAt: T0, inferredReset: true }, T0 + 99 * 60_000],
      [{}, T0 + 99 * 60_000],
    ],
  },
  { module: 'usage', name: 'order', fn: 'orderUsageWindows', calls: [[PROFILE_USAGE], [undefined], [{}]] },
  { module: 'usage', name: 'infos', fn: 'usageInfos', calls: [[PROFILE_USAGE], [undefined]] },
]

const WATERMARKS: VmCase[] = [
  {
    module: 'watermarks',
    name: 'script',
    fn: 'watermarkScript',
    calls: [
      [
        {
          'mac:old': { itemCount: 1, activity: 1, turns: 1, seenAt: T0 - 40 * 86_400_000 },
          'mac:legacy': { itemCount: 4, activity: 9, turns: 2, seenAt: T0 - 1_000 },
        },
        [
          ['mark', 'mac', 's1', { itemCount: 3, activity: 5, prose: 2, turns: 1 }, T0],
          ['mark', 'mac', 's1', { itemCount: 3, activity: 5, prose: 2, turns: 1 }, T0 + 30_000],
          ['mark', 'mac', 's1', { itemCount: 1, activity: 2 }, T0 + 30_000],
          ['mark', 'mac', 's1', {}, T0 + 61_000],
          ['mark', 'mac', 's1', { prose: 1 }, T0 + 62_000],
          ['mark', 'mac', 's1', { prose: 4, turns: 3 }, T0 + 62_500],
          ['mark', 'mac', 'legacy', { activity: 9 }, T0],
          ['mark', 'mac', 'legacy', { prose: 0 }, T0 + 10],
          ['forget', 'mac', 'nobody'],
          ['forget', 'mac', 's1'],
          ['mark', 'box', 's2', { prose: 7 }, T0 + 31 * 86_400_000],
        ],
      ],
    ],
  },
  {
    module: 'watermarks',
    name: 'unseen',
    fn: 'unseenCount',
    calls: [
      [undefined, { proseCount: 5 }],
      [{ itemCount: 0, activity: 0, turns: 0, seenAt: T0 }, { proseCount: 5 }],
      [{ itemCount: 0, activity: 0, prose: 2, turns: 0, seenAt: T0 }, { proseCount: 5 }],
      [{ itemCount: 0, activity: 0, prose: 9, turns: 0, seenAt: T0 }, { proseCount: 5 }],
      [{ itemCount: 0, activity: 0, prose: 2, turns: 0, seenAt: T0 }, {}],
    ],
  },
]

const MENTION_TEXTS = [
  'ask #astra about it',
  '#WD-Review, please look. And #wd_lead!',
  'issue#42 is not a mention, # heading neither, nor #-x',
  '(#Fix-login-bug) and "#quoted" and #trailing...',
  'unicode #Über-Agent and #日本語 and #emoji🦀x',
  '#a #b #c #d #e',
  `#${'x'.repeat(64)} #${'y'.repeat(65)}`,
  'tabs\t#tab\nnew line #line',
  '',
  Array.from({ length: 40 }, (_, i) => `#m${i}`).join(' '),
]

const PEER_MENTIONS: VmCase[] = [
  { module: 'peer-mentions', name: 'scan', fn: 'scanPeerMentions', calls: MENTION_TEXTS.map((t) => [t]) },
  {
    module: 'peer-mentions',
    name: 'slug',
    fn: 'peerMentionSlug',
    calls: [
      ['Fix login bug', 's-1'],
      ['  --WD Review!!  ', 's-2'],
      [undefined, '1234567890abcdef'],
      ['', 'mini:abcdef0123456789'],
      ['!!!', 'abc'],
      ['Über Agent 日本語', 'x'],
      [`${'word '.repeat(20)}`, 'x'],
      [`${'a'.repeat(63)} b`, 'x'],
    ],
  },
  {
    module: 'peer-mentions',
    name: 'key',
    fn: 'peerMentionKey',
    calls: [['Fix_login_bug'], ['  Astra  '], ['WD--Review'], ['-lead-'], ['Über Agent'], ['a _ - b'], ['']].map((c) => c),
  },
  {
    module: 'peer-mentions',
    name: 'body',
    fn: 'isPeerMentionBody',
    calls: [['astra'], ['-x'], ['_x'], ['x-_y'], [''], ['a'.repeat(64)], ['a'.repeat(65)], ['日本'], ['a.b'], ['9lives']],
  },
]

const SUBS = [
  sub('tu-run', { description: 'write tests', toolCount: 3, stoppable: true }),
  sub('tu-done', { status: 'done', description: '  ', toolCount: 0, stoppable: true }),
  sub('tu-fail', { status: 'failed', description: 'deploy', toolCount: 1 }),
  sub('tu-agent', { agentType: 'Explore', description: 'look around' }),
  sub('tu-codex', { isAgent: true }),
  sub('tu-nostop', { description: 'background', stoppable: false }),
]

const CHECKLIST_ITEMS = [
  { text: 'Read the plan', status: 'completed' as const },
  { text: 'Port the session list', status: 'in_progress' as const },
  { text: 'Write goldens', status: 'pending' as const },
]

const CHECKLIST: VmCase[] = [
  {
    module: 'checklist',
    name: 'parse-todo-write',
    fn: 'parseTodoWriteInput',
    calls: [
      [{ todos: [{ content: ' Read ', status: 'completed', activeForm: 'Reading' }, { content: 'Port', status: 'in_progress', activeForm: ' Porting ' }, { content: 'Ship', status: 'pending' }] }],
      [{ todos: [{ content: 'Port', status: 'in_progress', activeForm: '   ' }] }],
      [{ todos: [] }],
      [{ todos: [{ content: 'Port', status: 'blocked' }] }],
      [{ todos: [{ content: '   ', status: 'pending' }] }],
      [{ todos: [{ content: 'ok', status: 'pending' }, 'junk'] }],
      [{ todos: 'nope' }],
      [null],
      [{}],
    ],
  },
  {
    module: 'checklist',
    name: 'session-tasks',
    fn: 'sessionTasks',
    calls: [[{ checklist: CHECKLIST_ITEMS, subagents: SUBS }], [{}], [{ subagents: SUBS }]],
  },
  {
    module: 'checklist',
    name: 'displayed-tasks',
    fn: 'displayedTasks',
    calls: (['all', 'active', 'none'] as const).map((show) => [{ checklist: CHECKLIST_ITEMS, subagents: SUBS }, show]),
  },
  {
    module: 'checklist',
    name: 'summaries',
    fn: 'taskScript',
    calls: [[{ checklist: CHECKLIST_ITEMS, subagents: SUBS }], [{}]],
  },
]

const TOOL_TITLES: VmCase[] = [
  {
    module: 'tool-titles',
    name: 'tool-title',
    fn: 'toolTitle',
    calls: [
      ['fs_read'],
      ['Bash'],
      ['mcp__workerdeck__peers_send'],
      ['custom', { custom: 'Custom tool' }],
      ['fs_read', { fs_read: 'Reading carefully' }],
      ['echo', { echo: 'echo' }],
      ['x', { x: '\u0000\u0007  \n' }],
    ],
  },
  {
    module: 'tool-titles',
    name: 'sanitize',
    fn: 'sanitizeToolTitle',
    calls: [
      ['  Multi\nline\ttitle  '],
      ['Delete\u007fall', 'del'],
      ['same', 'same'],
      [undefined, 'x'],
      [''],
      ['x'.repeat(64)],
      ['y'.repeat(65)],
      [`${'🦀'.repeat(70)}`],
      ['café  au   lait'],
    ],
  },
  { module: 'tool-titles', name: 'peer-send', fn: 'isPeerSendTool', calls: [['peers_send'], ['mcp__workerdeck__peers_send'], ['peers_list'], ['']] },
]

const MODELS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable' },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', primary: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5[1m]', displayName: 'Sonnet 5.5', reasoningEfforts: ['low', 'high'] },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
  { value: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
  { value: 'gpt-5.6-astra', displayName: 'GPT-5.6 Astra' },
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4-5 (2025-10-01)' },
]

const MODEL_MENU: VmCase[] = [
  { module: 'model-menu', name: 'lines', fn: 'modelLine', calls: [...MODELS.map((m) => [m]), [{ value: 'x', displayName: 'v2 Model-3 x.4 9' }], [{ value: 'y', displayName: '  Big   Model  ' }]] },
  {
    module: 'model-menu',
    name: 'matches',
    fn: 'modelMatches',
    calls: [
      [MODELS[1], 'opus'],
      [MODELS[1], 'opus[1m]'],
      [MODELS[1], 'claude-opus-5-5'],
      [MODELS[4], 'claude-sonnet-5-5'],
      [MODELS[4], 'claude-sonnet-5-5[1m]'],
      [MODELS[2], 'claude-opus-4-7[1m]'],
      [MODELS[2], 'opus'],
    ],
  },
  {
    module: 'model-menu',
    name: 'menu',
    fn: 'modelMenu',
    calls: [[MODELS], [MODELS, 'claude-opus-4-7'], [MODELS, 'claude-sonnet-5-5[1m]'], [MODELS, 'nonexistent'], [MODELS, 'opus'], [[]]],
  },
]

const STATUS_LABEL: VmCase[] = [
  {
    module: 'status-label',
    name: 'read-input',
    fn: 'readStatusLabelInput',
    calls: [
      [null],
      [],
      ['text'],
      [[]],
      [{ text: 5 }],
      [{ text: 'ok', emoji: 3 }],
      [{ text: '   ' }],
      [{ text: '  Porting \n the   list ' }],
      [{ text: 'x'.repeat(80) }],
      [{ text: 'x'.repeat(81) }],
      [{ text: 'Shipping', emoji: ' 🚀 ' }],
      [{ text: 'Shipping', emoji: '   ' }],
      [{ text: 'Shipping', emoji: '🦀'.repeat(9) }],
      [{ text: 'Shipping', emoji: '🦀'.repeat(8) }],
    ],
  },
]

const SNAPSHOT = info('s1', {
  status: 'running',
  cwd: '/work/snapshot',
  engine: 'codex',
  model: 'gpt-6-sol',
  effort: 'high',
  permissionMode: 'acceptEdits',
  sdkSessionId: 'sdk-snapshot',
  totalCostUsd: 4.5,
  costUsd: 1.25,
  usageByModel: { 'gpt-6-sol': { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 5 } },
  engineAsleep: true,
  lastSeq: 9,
})

const SHELL_RECORD: ShellInfo = {
  id: 'sh_abc',
  sessionId: 's1',
  ordinal: 3,
  command: 'npm test',
  label: 'npm test',
  cwd: '/work/acme',
  status: 'exited',
  exitCode: 0,
  endReason: 'exit',
  startedAt: T0,
  endedAt: T0 + 2000,
  owner: 'user',
  bytes: 120,
  cols: 120,
  rows: 40,
}

const TRANSCRIPT: VmCase[] = [
  {
    module: 'transcript',
    name: 'seed',
    fn: 'transcriptScript',
    calls: [
      [[['seed', SNAPSHOT]]],
      [[['seed', SNAPSHOT], ['events', 'basic-turn']]],
      [[['events', 'basic-turn'], ['seed', SNAPSHOT]]],
      [[['effort', null], ['seed', SNAPSHOT]]],
      [[['effort', 'low'], ['seed', SNAPSHOT]]],
      [[['seed', info('s2', { status: 'idle' })]]],
    ],
  },
  {
    module: 'transcript',
    name: 'hydrate',
    fn: 'transcriptScript',
    calls: [
      [[['events', 'tool-result-truncated-and-images'], ['hydrateResult', 'toolu_big', 'the whole log']]],
      [[['events', 'tool-result-truncated-and-images'], ['hydrateResult', 'toolu_shot', 'not truncated, untouched']]],
      [[['events', 'shell-running'], ['hydrateShell', 'sh_abc', SHELL_RECORD]]],
      [[['events', 'shell-running'], ['hydrateShell', 'sh_abc', null]]],
      [[['events', 'shell-running'], ['hydrateShell', 'sh_abc', null], ['hydrateShellOutput', 'sh_abc', 'listening on :5173\nready']]],
      [[['events', 'shell-running'], ['hydrateShellOutput', 'sh_nope', 'nothing']]],
    ],
  },
]

const PROMPT_REQUESTS = [
  { toolName: 'Bash', input: { command: 'ls' }, title: 'Claude wants to run ls', displayName: 'Run command' },
  { toolName: 'Read', input: { file_path: '/a' }, displayName: 'Read file', description: 'Reads a file', decisionReason: 'not in allow list' },
  { toolName: 'Edit', input: {} },
  { toolName: 'ExitPlanMode', input: { plan: '## Steps\n\n1. Do it' }, description: 'plan time' },
  { toolName: 'ExitPlanMode', input: { plan: '  \n ' }, title: 'Exit plan mode?' },
  { toolName: 'ExitPlanMode', input: null },
  { toolName: 'shell_run', input: { command: 'npm run dev\nsecond' } },
  { toolName: 'mcp__workerdeck__shell_write', input: { shellId: 'sh_1', data: 'yes\r\x1b\x03\t\x7f', keys: ['enter', 3, 'ctrl-c'] } },
  { toolName: 'mcp__workerdeck__shell_write', input: { shellId: 'sh_1', keys: [] } },
  { toolName: 'mcp__workerdeck__shell_kill', input: { shellId: 'sh_2' } },
  { toolName: 'mcp__workerdeck__shell_request_write', input: { shellId: 'sh_3', reason: 'fix\nit' } },
  { toolName: 'mcp__other__shell_run', input: [] },
  { toolName: 'mcp_shell_run', input: { command: 'x' } },
]

const PROMPT: VmCase[] = [
  { module: 'prompt', name: 'permission-model', fn: 'permissionPromptModel', calls: PROMPT_REQUESTS.map((r) => [r]) },
  {
    module: 'prompt',
    name: 'shell-lines',
    fn: 'shellRequestLines',
    calls: [
      [{ kind: 'run', command: 'a\nb' }],
      [{ kind: 'write', shellId: 's', data: 'x\ny', keys: ['enter', 'tab'] }],
      [{ kind: 'write', shellId: 's' }],
      [{ kind: 'kill', shellId: 's' }],
      [{ kind: 'grant', shellId: 's', reason: 'r\x1b' }],
    ],
  },
  {
    module: 'prompt',
    name: 'selections',
    fn: 'selectionScript',
    calls: [
      [false, [['label', 'a'], ['label', 'b'], ['other'], ['label', 'c'], ['other']]],
      [true, [['label', 'a'], ['label', 'b'], ['label', 'a'], ['other'], ['type', '  mine  '], ['label', 'c']]],
      [true, [['other'], ['type', '   ']]],
    ],
  },
  {
    module: 'prompt',
    name: 'questions',
    fn: 'parseUserQuestions',
    calls: [
      [{}],
      [{ questions: 'nope' }],
      [
        {
          questions: [
            { question: 'Which?', header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', preview: 'b preview' }] },
            { question: 'Many?', multiSelect: true, options: [{ label: 'x' }, { nope: 1 }] },
            { question: 'Empty?', header: 'E', options: [] },
            { header: 'no question', options: [{ label: 'z' }] },
            { question: 'Flag?', header: 'F', multiSelect: 'yes', options: [{ label: 'q' }] },
          ],
        },
      ],
    ],
  },
]

const FOLLOWER: AgentRef = { id: 'ag', name: 'WD-Test' }

const CONVERSATION_ROWS = [
  row('mac', info('a', { agent: FOLLOWER, archived: true, supersededBy: 'b' })),
  row('box', info('x', { agent: FOLLOWER })),
  row('mac', info('p')),
  row('mac', info('c', { agent: FOLLOWER })),
]

const CONVERSATIONS: VmCase[] = [
  {
    module: 'conversations',
    name: 'session-listed',
    fn: 'sessionListed',
    calls: [[info('a')], [info('b', { archived: true })], [info('c', { agent: FOLLOWER, supersededBy: 'd' })]],
  },
  {
    module: 'conversations',
    name: 'selection-of',
    fn: 'selectionOf',
    calls: [
      ['mac', info('a', { agent: FOLLOWER })],
      ['mac', info('a', { agent: FOLLOWER, archived: true, supersededBy: 'b' })],
      ['box', info('p')],
    ],
  },
  {
    module: 'conversations',
    name: 'follow-target',
    fn: 'followTarget',
    calls: [
      [{ kind: 'agent', gateway: 'mac', agentId: 'ag' }, CONVERSATION_ROWS],
      [{ kind: 'agent', gateway: 'box', agentId: 'ag' }, CONVERSATION_ROWS],
      [{ kind: 'agent', gateway: 'mac', agentId: 'gone' }, CONVERSATION_ROWS],
      [{ kind: 'agent', gateway: 'mac', agentId: 'ag' }, CONVERSATION_ROWS.slice(0, 3)],
      [{ kind: 'session', gateway: 'mac', sessionId: 'a' }, CONVERSATION_ROWS],
      [{ kind: 'session', gateway: 'mac', sessionId: 'zzz' }, []],
    ],
  },
  {
    module: 'conversations',
    name: 'archived-view',
    fn: 'archivedView',
    calls: [
      [info('a', { agent: FOLLOWER }), [{ id: 'ag', sessionId: 'a' }]],
      [info('a', { agent: FOLLOWER, archived: true, supersededBy: 'b', lastActivityAt: 5000 }), [{ id: 'ag', sessionId: 'c' }]],
      [info('a', { agent: FOLLOWER, archived: true }), [{ id: 'ag', sessionId: 'a' }]],
      [info('a', { agent: FOLLOWER, archived: true }), []],
      [info('a', { agent: FOLLOWER, archived: true, transcript: 'unavailable' })],
      [info('p', { archived: true }), []],
    ],
  },
  {
    module: 'conversations',
    name: 'new-conversation-gate',
    fn: 'newConversationGate',
    calls: [
      [info('a', { status: 'idle' })],
      [info('a', { status: 'running' })],
      [info('a', { status: 'starting' })],
      [info('a', { status: 'awaiting_approval' })],
      [info('a', { status: 'parked' })],
      [info('a', { status: 'running', archived: true })],
    ],
  },
  {
    module: 'conversations',
    name: 'clear-context-offered',
    fn: 'clearContextOffered',
    calls: [[info('p')], [info('a', { agent: FOLLOWER })], [info('b', { archived: true })]],
  },
]

export const VM_CORPUS: VmCase[] = [
  ...SESSION_LIST,
  ...AGENTS,
  ...PRICING,
  ...USAGE_CASES,
  ...WATERMARKS,
  ...PEER_MENTIONS,
  ...CHECKLIST,
  ...TOOL_TITLES,
  ...MODEL_MENU,
  ...STATUS_LABEL,
  ...TRANSCRIPT,
  ...PROMPT,
  ...CONVERSATIONS,
]
