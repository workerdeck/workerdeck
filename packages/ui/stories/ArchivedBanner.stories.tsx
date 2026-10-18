import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArchivedBanner } from '../src/components/agent/ArchivedBanner.tsx'

const AT = Date.UTC(2026, 9, 18, 11, 41)

const meta: Meta<typeof ArchivedBanner> = {
  title: 'Agent/ArchivedBanner',
  component: ArchivedBanner,
  args: { locale: 'en-US', onGoToCurrent: () => {} },
  decorators: [
    (Story) => (
      <div data-slot="session-panel" style={{ background: 'var(--bg)', padding: 12 }}>
        <Story />
      </div>
    ),
  ],
}
export default meta

type Story = StoryObj<typeof ArchivedBanner>

export const PastWithCurrent: Story = { args: { view: { kind: 'past', at: AT, current: 'next', unavailable: false } } }

export const PastNoAgentList: Story = { args: { view: { kind: 'past', at: AT, unavailable: false } } }

export const AgentDeleted: Story = { args: { view: { kind: 'deleted', at: AT, unavailable: false } } }

export const TranscriptUnavailable: Story = { args: { view: { kind: 'past', at: AT, current: 'next', unavailable: true } } }
