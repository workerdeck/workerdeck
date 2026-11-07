import type { Meta, StoryObj } from '@storybook/react-vite'
import type { FleetRow } from '@workerdeck/protocol'
import { FleetStrip } from '../src/components/agent/FleetStrip.tsx'

const FLEET: FleetRow[] = [
  { key: 'mac:s1', id: 's1', name: 'WD-Art', reasons: ['approval'], text: '2 approvals waiting' },
  { key: 'mac:s2', id: 's2', name: 'WD-Review', reasons: ['failed'], text: 'the new conversation did not start: spawn claude ENOENT', retry: 3 },
  { key: 'mac:s3', id: 's3', name: 'WD-Docs', reasons: ['blocked'], text: 'Waiting on you: which release notes format?' },
  { key: 'mac:s4', id: 's4', name: 'WD-Test', reasons: ['approval', 'blocked'], text: 'An approval is waiting' },
]

const meta: Meta<typeof FleetStrip> = {
  title: 'Agent/FleetStrip',
  component: FleetStrip,
  args: { fleet: FLEET, terminal: false, onOpen: () => {}, onRetry: () => new Promise((resolve) => setTimeout(resolve, 800)) },
  decorators: [
    (Story) => (
      <div data-slot="session-panel" style={{ background: 'var(--bg)', width: 520 }}>
        <Story />
      </div>
    ),
  ],
}
export default meta

type Story = StoryObj<typeof FleetStrip>

export const Cards: Story = {}

export const Terminal: Story = { args: { terminal: true } }

export const OpenOnly: Story = { args: { onRetry: undefined } }
