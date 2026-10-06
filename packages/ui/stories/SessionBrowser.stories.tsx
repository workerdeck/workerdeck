import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { SessionRow, ViewConfig } from '@workerdeck/protocol'
import { SessionBrowser } from '../src/components/agent/SessionBrowser.tsx'
import { AgentHeading } from '../src/components/agent/AgentAvatar.tsx'
import type { TeamMove } from '../src/lib/team-drop.ts'
import { AGENTS, makeRow } from './session-fixtures.ts'

const meta: Meta<typeof SessionBrowser> = {
  title: 'Sessions/SessionBrowser',
  component: SessionBrowser,
  decorators: [
    (Story) => (
      <div className="w-[310px] text-body-sm">
        <Story />
      </div>
    ),
  ],
}
export default meta

type Story = StoryObj<typeof SessionBrowser>

const ROWS = [
  makeRow({ id: '1', title: 'Continue session load optimization', subagents: AGENTS } as never, 5),
  makeRow({ id: '2', title: 'Terminal fold audit', status: 'idle' } as never, 3),
  makeRow(
    {
      id: '3',
      title: 'Codex parity sweep',
      status: 'awaiting_approval',
      engine: 'codex',
      model: 'gpt-5-codex',
      pendingPermissionCount: 1,
    } as never,
    12,
  ),
  makeRow({ id: '4', title: 'Launch preparation', status: 'idle', totalCostUsd: 4.2 } as never),
  makeRow({ id: '5', title: 'Grid layout exploration', status: 'closed' } as never),
]

const DECK = { name: 'WorkerDeck', root: '/work/deck' }

const GATEWAY_ROWS = [
  makeRow({ id: '1', title: 'Continue session load optimization', cwd: '/work/deck/packages/ui', project: DECK } as never, 2),
  makeRow({ id: '2', title: 'Terminal fold audit', status: 'idle', cwd: '/work/deck', project: DECK } as never),
  {
    ...makeRow({
      id: '3',
      title: 'Codex parity sweep',
      status: 'idle',
      cwd: '/srv/deck',
      project: { ...DECK, root: '/srv/deck' },
    } as never),
    hostId: 'pi',
    hostName: 'pi',
    local: false,
  },
  makeRow({ id: '4', title: 'Launch preparation', status: 'idle', cwd: '/work/site', project: undefined } as never),
]

function Browser({ initial, ...props }: Partial<React.ComponentProps<typeof SessionBrowser>> & { initial?: Partial<ViewConfig> }) {
  const [config, setConfig] = useState<ViewConfig>({ ...DEFAULT_VIEW_CONFIG, scoped: false, ...initial })
  return (
    <SessionBrowser
      rows={ROWS}
      config={config}
      onConfigChange={setConfig}
      activeId="1"
      onSelect={() => {}}
      onSelectSubagent={() => {}}
      onRename={() => {}}
      onClearContext={() => {}}
      onDelete={() => {}}
      {...props}
    />
  )
}

export const Default: Story = { render: () => <Browser showControls={false} /> }

export const WithControls: Story = { render: () => <Browser showControls /> }

export const Empty: Story = { render: () => <Browser rows={[]} showControls={false} /> }

export const ByGatewayAndProject: Story = {
  render: () => <Browser rows={GATEWAY_ROWS} showControls={false} initial={{ groupBy: 'project' }} onCreateInGroup={() => {}} />,
}

export const Custom: Story = {
  render: () => (
    <Browser
      showControls={false}
      initial={{
        groupBy: 'custom',
        customGroups: [
          { id: 'focus', name: 'Focus', members: ['local:3', 'local:1'] },
          { id: 'later', name: 'Later', members: [] },
        ],
      }}
    />
  ),
}

function avatar(name: string): string {
  return new URL(`./avatars/${name}.png`, import.meta.url).href
}

const AVATARS = Object.fromEntries(
  ['atlas', 'pip', 'juno', 'rook', 'marlow', 'orbit', 'fern'].map((name) => [
    `/v1/agents/${name}/avatar.png`,
    name === 'juno'
      ? { still: avatar(name), busy: { src: avatar('juno-busy'), durations: [160, 160, 160, 160] } }
      : { still: avatar(name) },
  ]),
)

function agent(id: string, name: string, team: { lead?: string; team?: string; leads?: true; order?: number } = {}) {
  return { id, name, avatar: `/v1/agents/${id}/avatar.png`, ...team }
}

const TEAM_ROWS = [
  makeRow({ id: 't1', title: 'Agent Teams: protocol and list', status: 'idle', agent: agent('atlas', 'Atlas', { leads: true }) } as never),
  makeRow(
    {
      id: 't2',
      title: 'Needs approval: Bash pnpm test',
      status: 'awaiting_approval',
      pendingPermissionCount: 1,
      agent: agent('pip', 'Pip', { lead: 'atlas', team: 'Atlas', order: 0 }),
    } as never,
    2,
  ),
  makeRow({
    id: 't3',
    title: 'peers.ts: team visibility',
    engine: 'codex',
    model: 'gpt-6-sol',
    agent: agent('juno', 'Juno', { lead: 'atlas', team: 'Atlas', order: 1 }),
  } as never),
  makeRow({
    id: 't4',
    title: 'iOS mirror review',
    status: 'idle',
    engineAsleep: true,
    agent: agent('rook', 'Rook', { lead: 'atlas', team: 'Atlas', order: 2 }),
  } as never),
  makeRow({ id: 't5', title: 'Relay follow-ups', status: 'running', agent: agent('marlow', 'Marlow') } as never, 3),
  makeRow(
    {
      id: 't6',
      title: 'Docs site refresh',
      status: 'idle',
      engine: 'codex',
      model: 'gpt-6-sol',
      agent: agent('orbit', 'Orbit', { leads: true }),
    } as never,
    1,
  ),
  makeRow(
    {
      id: 't7',
      title: 'Changelog draft',
      status: 'running',
      engine: 'provider',
      model: 'kimi-k3',
      agent: agent('fern', 'Fern', { lead: 'orbit', team: 'Orbit' }),
    } as never,
    1,
  ),
  makeRow({ id: 't8', title: 'Weekly dependency bump', status: 'idle' } as never),
  makeRow({ id: 't9', title: 'One-off grep', status: 'closed' } as never),
  makeRow({ id: 't10', title: 'Old spike', status: 'failed' } as never),
]

export const Teams: Story = {
  render: () => (
    <Browser
      rows={TEAM_ROWS}
      avatars={AVATARS}
      activeId="t3"
      showControls={false}
      onRenameAgent={() => {}}
      initial={{ groupBy: 'none', collapsedTeams: ['local:orbit'] }}
    />
  ),
}

export const TeamsByState: Story = {
  render: () => <Browser rows={TEAM_ROWS} avatars={AVATARS} showControls={false} initial={{ groupBy: 'state' }} />,
}

function applyMove(rows: SessionRow[], move: TeamMove): SessionRow[] {
  const lead = move.lead?.info.agent
  const orders = new Map((move.siblings ?? []).map((s) => [s.row.info.id, s.order]))
  return rows.map((row) => {
    const own = row.info.agent
    if (row.info.id === move.row.info.id) {
      const base = own ?? { id: row.info.id, name: row.info.title ?? row.info.id }
      const next = lead ? { ...base, lead: lead.id, team: lead.name, order: move.order } : { ...base, lead: undefined, team: undefined }
      return { ...row, info: { ...row.info, agent: next } }
    }
    if (own && orders.has(row.info.id)) {
      return { ...row, info: { ...row.info, agent: { ...own, order: orders.get(row.info.id) } } }
    }
    if (own && lead && own.id === lead.id) {
      return { ...row, info: { ...row.info, agent: { ...own, leads: true } } }
    }
    return row
  })
}

function DraggableTeams() {
  const [rows, setRows] = useState(TEAM_ROWS)
  return (
    <Browser
      rows={rows}
      avatars={AVATARS}
      showControls={false}
      initial={{ groupBy: 'none' }}
      onTeamMove={(move) => {
        if (move.row.info.id === 't5') {
          throw new Error('Marlow is busy; try again when the turn ends')
        }
        setRows((held) => applyMove(held, move))
      }}
    />
  )
}

export const TeamsDrag: Story = { render: () => <DraggableTeams /> }

export const Heading: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <AgentHeading row={TEAM_ROWS[0]!} image={AVATARS['/v1/agents/atlas/avatar.png']} conversation={3} />
      <AgentHeading row={TEAM_ROWS[2]!} image={AVATARS['/v1/agents/juno/avatar.png']} conversation={1} />
      <AgentHeading row={TEAM_ROWS[4]!} />
    </div>
  ),
}
