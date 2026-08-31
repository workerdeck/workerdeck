import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MoreHorizontal } from 'lucide-react'
import { SessionItem } from '../src/components/agent/SessionItem.tsx'
import { AGENTS, MIXED, makeRow } from './session-fixtures.ts'

/**
 * The session card, at the width it actually ships at.
 *
 * Every story is framed in a 310px column because that is the auxiliary bar's
 * width in the design and roughly the sidebar's everywhere else — and because
 * *this component's* whole difficulty is what truncates first when the row runs
 * out of room. A card reviewed at 900px is a card whose hardest question was
 * never asked.
 */
const meta: Meta<typeof SessionItem> = {
  title: 'Sessions/SessionItem',
  component: SessionItem,
  decorators: [
    (Story) => (
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

/** Running, unselected, collapsed — the row nine of ten sessions are in. */
export const Collapsed: Story = {
  args: { row: makeRow({ id: '1', title: 'Session 1 Title', subagents: AGENTS }, 5) },
}

/** Running, unselected, expanded. */
export const Expanded: Story = {
  args: {
    row: makeRow({ id: '2', title: 'Session 2 Title', subagents: AGENTS }, 5),
    expanded: true,
  },
}

/**
 * ## Nothing selected
 *
 * No fill anywhere — not on the card, not on any step. Hover the card and hover
 * each row: **all four** answer the pointer, including the tasks, which are
 * pressable even though they can never be the selected thing.
 */
export const SelectionNone: Story = {
  name: 'Selection · nothing selected',
  args: { row: makeRow({ id: 'sel-0', title: 'Session Title', subagents: MIXED }), expanded: true },
}

/**
 * ## The session is selected
 *
 * The card takes the blue. No step is selected, and the steps still hover — on
 * `--row-active`, a tint, which is why they read correctly against the blue
 * instead of washing out the way a flat hover fill did.
 */
export const SelectionSession: Story = {
  name: 'Selection · session selected',
  args: {
    row: makeRow({ id: 'sel-1', title: 'Session Title', subagents: MIXED }),
    active: true,
    expanded: true,
  },
}

/**
 * ## A sub-agent is selected — the secondary state
 *
 * The blue moves to the **agent**, and the card drops to the secondary grey
 * (`--row-selected-weak`). Both claims are true at once — opening an agent
 * selects its session too — and the blue marks the finer of them. Note that
 * `active` is passed here as well: the host has both selections, and the card
 * still resolves to grey.
 */
export const SelectionSubagent: Story = {
  name: 'Selection · sub-agent selected',
  args: {
    row: makeRow({ id: 'sel-2', title: 'Session Title', subagents: MIXED }),
    active: true,
    activeStepKey: 'a',
    expanded: true,
  },
}

/**
 * ## A task key never selects
 *
 * `activeStepKey` names the **task** here. A task is a reference to a place
 * inside a session, not a thing with a screen, so nothing takes the blue and the
 * card stays on its ordinary session selection. This is the guard that stops a
 * host from painting a row selected just because it navigated there.
 */
export const SelectionTaskKeyIgnored: Story = {
  name: 'Selection · task key is ignored',
  args: {
    row: makeRow({ id: 'sel-3', title: 'Session Title', subagents: MIXED }),
    active: true,
    activeStepKey: 't1',
    expanded: true,
  },
}

/**
 * ## Click through it
 *
 * The real thing, wired to real state — click the **card** to select the session, an **agent**
 * to select it instead (blue row, grey card), a **task** to select the session and tell the host
 * where to land (a task never fills), the selected card again to clear. The line under the list
 * is what a host would have received.
 */
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
          // Clicking the selected card again clears it — only so this story can
          // return to the empty state without a reload. A host does not do this.
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
        /* The other destination, and the reason there are two seams: a task has
           no agent behind it, so the host selects the session and travels to the
           row instead of framing anything. Framing it drew an empty view. */
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

/** Turn ended, no sub-agents, nothing to disclose. */
export const Ended: Story = {
  args: {
    row: makeRow({
      id: '5',
      title: 'Session 5 Title',
      status: 'idle',
    }),
  },
}

/** Waiting on a human. The one state the list is scanned for. */
export const NeedsAttention: Story = {
  args: {
    row: makeRow({ id: '6', title: 'Session 6 Title', status: 'awaiting_approval', pendingPermissionCount: 1 }, 12),
  },
}

/** Everything the metadata line can carry at once, against the name of a repo
 * nobody would shorten kindly. What truncates here is the contract. */
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

/** A codex session — the other vendor, and the reason the colour rule is
 * symmetric. */
export const Codex: Story = {
  args: {
    row: makeRow({ id: '8', title: 'Codex parity sweep', engine: 'codex', model: 'gpt-5-codex' } as never),
  },
}

/** The five variants the design specifies, stacked as they appear in it. This is
 * the story to open when the question is "does the list read right", as opposed
 * to "is this one state correct". */
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
