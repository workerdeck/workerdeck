import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MoreHorizontal } from 'lucide-react'
import { SessionItem } from '../src/components/agent/SessionItem.tsx'
import { AGENTS, MIXED, makeRow } from './session-fixtures.ts'

const meta: Meta<typeof SessionItem> = {
  title: 'Sessions/SessionItem',
  component: SessionItem,
  decorators: [
    (Story) => (
      // Every story is framed at the shipping width, because this card's whole difficulty is what truncates first when the row runs out of room.
      <div className="w-[310px] text-body-sm">
        <Story />
      </div>
    ),
  ],
  args: {
    onSelect: () => {},
    onSelectSubagent: () => {},
    onRename: () => {},
    actions: (
      <button
        type="button"
        aria-label="Session actions"
        className="flex shrink-0 items-center rounded-[4px] p-0.5 text-fg-4 outline-none hover:bg-row-hover hover:text-fg-1"
      >
        <MoreHorizontal className="size-4" />
      </button>
    ),
  },
}
export default meta

type Story = StoryObj<typeof SessionItem>

export const Collapsed: Story = {
  args: { row: makeRow({ id: '1', title: 'Session 1 Title', subagents: AGENTS }, 5) },
}

export const Expanded: Story = {
  args: {
    row: makeRow({ id: '2', title: 'Session 2 Title', subagents: AGENTS }, 5),
    expanded: true,
  },
}

export const SelectionNone: Story = {
  name: 'Selection · nothing selected',
  args: { row: makeRow({ id: 'sel-0', title: 'Session Title', subagents: MIXED }), expanded: true },
}

export const SelectionSession: Story = {
  name: 'Selection · session selected',
  args: {
    row: makeRow({ id: 'sel-1', title: 'Session Title', subagents: MIXED }),
    active: true,
    expanded: true,
  },
}

export const SelectionSubagent: Story = {
  name: 'Selection · sub-agent selected',
  args: {
    row: makeRow({ id: 'sel-2', title: 'Session Title', subagents: MIXED }),
    active: true,
    activeStepKey: 'a',
    expanded: true,
  },
}

export const SelectionTaskKeyIgnored: Story = {
  name: 'Selection · task key is ignored',
  args: {
    row: makeRow({ id: 'sel-3', title: 'Session Title', subagents: MIXED }),
    active: true,
    activeStepKey: 't1',
    expanded: true,
  },
}

export const SelectionInteractive: Story = {
  name: 'Selection · interactive',
  render: (args) => <SelectionPlayground {...args} />,
  args: { row: makeRow({ id: 'sel-4', title: 'Session Title', subagents: MIXED }) },
}

function SelectionPlayground(args: React.ComponentProps<typeof SessionItem>) {
  const [selected, setSelected] = useState(false)
  const [agentKey, setAgentKey] = useState<string | undefined>(undefined)
  const [log, setLog] = useState('nothing selected')
  return (
    <div className="flex flex-col gap-2">
      <SessionItem
        {...args}
        expanded
        active={selected}
        activeStepKey={agentKey}
        onSelect={() => {
          const next = !(selected && agentKey === undefined)
          setSelected(next)
          setAgentKey(undefined)
          setLog(next ? 'select session' : 'nothing selected')
        }}
        onSelectSubagent={(toolUseId) => {
          setSelected(true)
          setAgentKey(toolUseId)
          setLog(`select session + open agent ${toolUseId}`)
        }}
        onRevealStep={(toolUseId) => {
          setSelected(true)
          setAgentKey(undefined)
          setLog(`select session + scroll to task ${toolUseId}`)
        }}
      />
      <p className="px-1 text-micro text-fg-4">
        host received: <span className="text-fg-2">{log}</span>
      </p>
    </div>
  )
}

export const Ended: Story = {
  args: {
    row: makeRow({
      id: '5',
      title: 'Session 5 Title',
      status: 'idle',
    }),
  },
}

export const NeedsAttention: Story = {
  args: {
    row: makeRow({ id: '6', title: 'Session 6 Title', status: 'awaiting_approval', pendingPermissionCount: 1 }, 12),
  },
}

export const Crowded: Story = {
  args: {
    row: makeRow(
      {
        id: '7',
        title: 'Rework the transcript reducer so replay holds across reconnects',
        profile: 'staging',
        totalCostUsd: 12.4,
        subagents: AGENTS,
        contextUsage: { percentage: 88, totalTokens: 176_000, maxTokens: 200_000 },
      } as never,
      3,
    ),
    showGateway: true,
  },
}

export const Codex: Story = {
  args: {
    row: makeRow({
      id: '8',
      title: 'Codex parity sweep',
      engine: 'codex',
      model: 'gpt-5-codex',
      contextUsage: { percentage: 41, totalTokens: 105_944, maxTokens: 258_400 },
    } as never),
  },
}

export const TheList: Story = {
  args: { row: makeRow({ id: 'x', title: 'unused' }) },
  render: (args) => (
    <div className="flex flex-col">
      <SessionItem {...args} row={makeRow({ id: 'a', title: 'Session 1 Title', subagents: AGENTS }, 5)} expanded activeStepKey="a" />
      <SessionItem {...args} row={makeRow({ id: 'b', title: 'Session 2 Title', status: 'idle' }, 3)} />
      <SessionItem {...args} row={makeRow({ id: 'c', title: 'Session 3 Title', subagents: AGENTS }, 5)} active expanded />
      <SessionItem {...args} row={makeRow({ id: 'd', title: 'Session 4 Title', subagents: AGENTS }, 5)} />
      <SessionItem {...args} row={makeRow({ id: 'e', title: 'Session 5 Title', subagents: AGENTS }, 5)} expanded />
    </div>
  ),
}
