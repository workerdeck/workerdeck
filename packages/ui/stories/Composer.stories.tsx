import type { Meta, StoryObj } from '@storybook/react-vite'
import { Composer } from '../src/components/agent/Composer.tsx'
import { TranscriptVariantProvider } from '../src/components/agent/transcript-variant.tsx'

function noop() {}

const meta: Meta<typeof Composer> = {
  title: 'Agent/Composer',
  component: Composer,
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="cards">
        <div className="w-[480px]" data-theme="dark">
          <Story />
        </div>
      </TranscriptVariantProvider>
    ),
  ],
  args: {
    onSend: noop,
    onInterrupt: noop,
    busy: false,
    disabled: false,
    placeholder: 'Message the agent…',
  },
}

export default meta
type Story = StoryObj<typeof Composer>

export const Stacked: Story = {
  args: {
    layout: 'stacked',
    attachments: {
      items: [],
      disabled: false,
      uploading: false,
      hasFailure: false,
      readyIds: [],
      add: noop,
      remove: noop,
      retry: noop,
      clear: noop,
    } as any,
  },
}

export const Inline: Story = {
  args: {
    layout: 'inline',
    attachments: {
      items: [],
      disabled: false,
      uploading: false,
      hasFailure: false,
      readyIds: [],
      add: noop,
      remove: noop,
      retry: noop,
      clear: noop,
    } as any,
  },
}

export const InlineNarrow: Story = {
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="cards">
        <div className="w-[320px]" data-theme="dark">
          <Story />
        </div>
      </TranscriptVariantProvider>
    ),
  ],
  args: {
    layout: 'inline',
    attachments: {
      items: [],
      disabled: false,
      uploading: false,
      hasFailure: false,
      readyIds: [],
      add: noop,
      remove: noop,
      retry: noop,
      clear: noop,
    } as any,
  },
}

// Shell mode is entered by typing `$` as the first character; there is no prop that forces it on,
// so this story is the affordance rather than the state. Type `$` to see the magenta frame.
export const ShellMode: Story = {
  args: {
    layout: 'stacked',
    onShellCommand: noop,
  },
}

export const ShellModeTerminal: Story = {
  args: {
    layout: 'stacked',
    onShellCommand: noop,
  },
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="terminal">
        <Story />
      </TranscriptVariantProvider>
    ),
  ],
}

function pixelAvatar(hue: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const ctx = canvas.getContext('2d')!
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      if ((x * 7 + y * 3 + hue) % 3 !== 0) {
        ctx.fillStyle = `hsl(${hue} 60% ${40 + ((x + y) % 3) * 10}%)`
        ctx.fillRect(x, y, 1, 1)
        ctx.fillRect(7 - x, y, 1, 1)
      }
    }
  }
  return canvas.toDataURL()
}

const PEER = { status: 'idle', cwd: '/Users/me/src/workerdeck', project: 'WorkerDeck', engine: 'claude' } as const

// Type `#` to open the picker: agents draw their avatar, a plain session keeps the generic icon.
export const PeerMentions: Story = {
  args: {
    layout: 'stacked',
    peers: [
      { ...PEER, id: 's-juno', slug: 'Juno', label: 'Juno' },
      { ...PEER, id: 's-atlas', slug: 'Atlas', label: 'Atlas', engine: 'codex' },
      { ...PEER, id: 's-plain', slug: 'fix-the-relay', label: 'fix the relay', status: 'running' },
    ],
  },
  render: (args) => <Composer {...args} peerAvatars={{ 's-juno': { still: pixelAvatar(20) }, 's-atlas': { still: pixelAvatar(200) } }} />,
}
