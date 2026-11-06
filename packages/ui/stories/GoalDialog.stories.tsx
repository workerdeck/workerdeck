import type { Meta, StoryObj } from '@storybook/react-vite'
import { GoalDialog } from '../src/components/agent/GoalDialog.tsx'

function noop() {}

const meta: Meta<typeof GoalDialog> = {
  title: 'Agent/GoalDialog',
  component: GoalDialog,
  args: { open: true, name: 'WD-Lead', capabilities: { pause: false, budget: false }, onClose: noop, onSave: noop },
}

export default meta
type Story = StoryObj<typeof GoalDialog>

export const Claude: Story = {}

export const CodexWithBudget: Story = {
  args: { capabilities: { pause: true, budget: true } },
}

export const Replace: Story = {
  args: {
    capabilities: { pause: true, budget: true },
    goal: {
      text: 'All tests in packages/core pass',
      state: 'active',
      setAt: Date.now() - 60_000,
      setBy: { kind: 'human' },
      tokenBudget: 200_000,
    },
  },
}
