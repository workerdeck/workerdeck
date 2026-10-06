import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkerDeckClient } from '@workerdeck/client'
import { AvatarDialog } from '../src/components/agent/AvatarDialog.tsx'

function noop() {}

function previewBlob(seed: string): Promise<Blob> {
  const hue = [...seed].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d')!
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 8; x++) {
      if ((x * 5 + y * 3 + hue) % 4 !== 0) {
        ctx.fillStyle = `hsl(${hue} 55% ${35 + ((x + y) % 3) * 12}%)`
        ctx.fillRect(x, y, 1, 1)
        ctx.fillRect(15 - x, y, 1, 1)
      }
    }
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
}

const client = {
  agentAvatarPreview: (_id: string, seed: string) => new Promise<Blob>((resolve) => setTimeout(() => resolve(previewBlob(seed)), 300)),
  changeAgentAvatar: () => Promise.reject(new Error('This story has no gateway')),
} as unknown as WorkerDeckClient

const meta: Meta<typeof AvatarDialog> = {
  title: 'Agent/AvatarDialog',
  component: AvatarDialog,
  args: { client, agent: { id: 'a1', name: 'Juno' }, onClose: noop },
}

export default meta
type Story = StoryObj<typeof AvatarDialog>

export const Default: Story = {}

