import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { ViewConfig } from '@workerdeck/protocol'
import { SessionBrowser } from '../src/components/agent/SessionBrowser.tsx'
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
