import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkerDeckClient } from '@workerdeck/client'
import { AvatarDialog } from '../src/components/agent/AvatarDialog.tsx'

function noop() {}

const client = {
  changeAgentAvatar: () => Promise.reject(new Error('This story has no gateway')),
} as unknown as WorkerDeckClient

const meta: Meta<typeof AvatarDialog> = {
  title: 'Agent/AvatarDialog',
  component: AvatarDialog,
  args: { client, agent: { id: 'a1', name: 'Juno', project: 'violet' }, onClose: noop },
}

export default meta
type Story = StoryObj<typeof AvatarDialog>

export const Default: Story = {}

