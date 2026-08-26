import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { ViewConfig } from '@workerdeck/protocol'
import { SessionBrowser } from '../src/components/agent/SessionBrowser.tsx'
import { AGENTS, makeRow } from './session-fixtures.ts'

/**
 * The dashboard's list — the same `SessionItem` as the extension's, with the
 * search-and-facet chrome above it that the extension renders natively instead.
 *
 * This is the story to open when the question is about the *list*: what the
 * group headers do to the metadata line (`showProject`), what the subset line
 * says when a filter is hiding rows, and how the three hover actions sit in the
 * card's `actions` slot.
 */
const meta: Meta<typeof SessionBrowser> = {
  title: 'Sessions/SessionBrowser',
  component: SessionBrowser,
  decorators: [
    (Story) => (
      <div className='w-[310px] text-body-sm'>
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
  makeRow({ id: '3', title: 'Codex parity sweep', status: 'awaiting_approval', engine: 'codex', model: 'gpt-5-codex', pendingPermissionCount: 1 } as never, 12),
  makeRow({ id: '4', title: 'Launch preparation', status: 'idle', totalCostUsd: 4.2 } as never),
  makeRow({ id: '5', title: 'Grid layout exploration', status: 'closed' } as never),
]

/** Live config, because the facets are the point — a frozen `config` prop makes
 * every control in the filter bar inert and the story a screenshot. */
function Browser(props: Partial<React.ComponentProps<typeof SessionBrowser>>) {
  const [config, setConfig] = useState<ViewConfig>({ ...DEFAULT_VIEW_CONFIG, scoped: false })
  return (
    <SessionBrowser
      rows={ROWS}
      config={config}
      onConfigChange={setConfig}
      activeId='1'
      onSelect={() => {}}
      onSelectSubagent={() => {}}
      onRename={() => {}}
      onClearContext={() => {}}
      onDelete={() => {}}
      {...props}
    />
  )
}

/** Grouped by state, filter bar hidden — the dashboard's default. */
export const Default: Story = { render: () => <Browser showControls={false} /> }

/** With the filter bar open, which the dashboard toggles from its title bar. */
export const WithControls: Story = { render: () => <Browser showControls /> }

/** No sessions at all. */
export const Empty: Story = { render: () => <Browser rows={[]} showControls={false} /> }
