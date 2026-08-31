import type { Meta, StoryObj } from '@storybook/react-vite'
import { Composer } from '../src/components/agent/Composer.tsx'
import { TranscriptVariantProvider, TranscriptDensityProvider } from '../src/components/agent/transcript-variant.tsx'

const noop = () => {}

const meta: Meta<typeof Composer> = {
  title: 'Agent/Composer',
  component: Composer,
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="cards">
        <TranscriptDensityProvider value="comfortable">
          <div className="w-[480px]" data-theme="dark">
            <Story />
          </div>
        </TranscriptDensityProvider>
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
        <TranscriptDensityProvider value="comfortable">
          <div className="w-[320px]" data-theme="dark">
            <Story />
          </div>
        </TranscriptDensityProvider>
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
