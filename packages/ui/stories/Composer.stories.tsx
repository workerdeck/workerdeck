import type { Meta, StoryObj } from '@storybook/react-vite'
import { rollFace } from '@workerdeck/protocol'
import { Composer } from '../src/components/agent/Composer.tsx'
import { makeRow } from './session-fixtures.ts'
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

const PEER_ROWS = Object.fromEntries(
  (['s-juno', 's-atlas'] as const).map((id) => [id, makeRow({ id, agent: { id, name: id.slice(2), face: rollFace(id, 'violet') } })]),
)

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
  render: (args) => <Composer {...args} peerRows={PEER_ROWS} />,
}
