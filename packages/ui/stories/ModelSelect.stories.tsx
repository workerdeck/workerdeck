import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { ModelOption } from '@workerdeck/protocol'
import { ModelSelect } from '../src/components/agent/ModelSelect.tsx'

const CLAUDE: ModelOption[] = [
  {
    value: 'fable',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable 5.1',
    description: 'For your toughest challenges',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    primary: true,
  },
  {
    value: 'claude-fable-5',
    resolvedModel: 'claude-fable-5',
    displayName: 'Fable 5',
    description: 'Most capable for your hardest and longest-running tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    primary: true,
  },
  {
    value: 'claude-opus-5',
    resolvedModel: 'claude-opus-5',
    displayName: 'Opus 5',
    description: 'Best for everyday, complex tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'claude-opus-4-8',
    resolvedModel: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    description: 'Best for everyday, complex tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'claude-opus-4-7',
    resolvedModel: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    description: 'Best for everyday, complex tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'claude-opus-4-6',
    resolvedModel: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Best for everyday, complex tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5-5',
    displayName: 'Sonnet 5.5',
    description: 'Most efficient for simpler tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    primary: true,
  },
  {
    value: 'claude-sonnet-5',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    description: 'Efficient for routine tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'claude-sonnet-4-6',
    resolvedModel: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    description: 'Efficient for routine tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: 'Fastest for quick answers',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    primary: true,
  },
  {
    value: 'claude-haiku-4-5-20251001',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    reasoningEfforts: [],
  },
]

function Picker({ defaultModel, initial }: { defaultModel?: string; initial?: string }) {
  const [model, setModel] = useState<string | undefined>(initial)
  return (
    <div style={{ padding: 24, display: 'flex', gap: 16, alignItems: 'center' }}>
      <ModelSelect variant="form" models={CLAUDE} model={model} defaultModel={defaultModel} onModelChange={setModel} />
      <code>{model ?? 'unset'}</code>
    </div>
  )
}

const meta: Meta<typeof Picker> = {
  title: 'Agent/ModelSelect',
  component: Picker,
}
export default meta

type Story = StoryObj<typeof Picker>

export const DefaultKnown: Story = { args: { defaultModel: 'claude-opus-5-5' } }

export const DefaultUnknown: Story = { args: {} }

export const OlderModelSelected: Story = { args: { defaultModel: 'claude-opus-5-5', initial: 'claude-opus-4-7' } }
