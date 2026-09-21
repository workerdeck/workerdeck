import type { CSSProperties, ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TranscriptItem } from '@workerdeck/react'
import { usePulse } from '../src/components/agent/pulse.tsx'
import { ToolRow, ToolRunRow, WorkingRow } from '../src/components/terminal/items.tsx'
import { Blank, Ink, Row } from '../src/components/terminal/row.tsx'
import { TerminalSurface } from '../src/components/terminal/surface.tsx'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

function call(id: string, name: string, input: object, status: 'running' | 'settled'): ToolCallItem {
  return {
    kind: 'tool_call',
    id,
    name,
    input,
    parentToolUseId: null,
    status,
    ts: Date.now() - 4_000,
    ...(status === 'settled' ? { result: { text: 'ok', isError: false } } : {}),
  } as ToolCallItem
}

function Panel({ theme, children }: { theme: 'dark' | 'light'; children: ReactNode }) {
  return (
    <div
      data-slot="session-panel"
      data-theme={theme}
      style={{ background: 'var(--bg)', padding: '12px 16px', flex: '1 1 0', minWidth: 0 } as CSSProperties}
    >
      <TerminalSurface>{children}</TerminalSurface>
    </div>
  )
}

function SpinnerGrid() {
  return (
    <>
      {['plan', 'edit', 'search', 'build', 'review'].map((label) => (
        <SpinnerRow key={label} label={label} />
      ))}
    </>
  )
}

function SpinnerRow({ label }: { label: string }) {
  const pulse = usePulse(true)
  return (
    <Row glyph={pulse} glyphTone="mark" tone="dim">
      {label}
      <Ink tone="faint"> · one ticker, one frame, every row</Ink>
    </Row>
  )
}

function Catalog({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <Panel theme={theme}>
      <SpinnerGrid />
      <Blank />
      <WorkingRow label="Working…" startedAt={Date.now() - 12_000} tokens={4200} />
      <WorkingRow label="Starting…" />
      <Blank />
      <ToolRow item={call('t1', 'Bash', { command: 'pnpm test --filter @workerdeck/ui' }, 'running')} />
      <ToolRow item={call('t2', 'Bash', { command: 'pnpm typecheck' }, 'settled')} />
      <Blank />
      <ToolRunRow
        items={[call('r1', 'Read', { file_path: 'src/index.ts' }, 'settled'), call('r2', 'Grep', { pattern: 'pulse' }, 'running')]}
      />
      <ToolRunRow
        items={[call('r3', 'Read', { file_path: 'src/index.ts' }, 'settled'), call('r4', 'Grep', { pattern: 'pulse' }, 'settled')]}
      />
    </Panel>
  )
}

const meta: Meta<typeof WorkingRow> = {
  title: 'Terminal/Pulse',
  component: WorkingRow,
  parameters: { layout: 'fullscreen' },
}
export default meta

type Story = StoryObj<typeof WorkingRow>

export const Dark: Story = { render: () => <Catalog theme="dark" /> }

export const Light: Story = { render: () => <Catalog theme="light" /> }

export const BothThemes: Story = {
  render: () => (
    <div style={{ display: 'flex' }}>
      <Catalog theme="dark" />
      <Catalog theme="light" />
    </div>
  ),
}

export const ReducedMotion: Story = {
  render: () => (
    <div style={{ display: 'flex' }}>
      <Catalog theme="dark" />
      <Catalog theme="light" />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same catalog. Turn on the operating system reduce-motion setting and every spinner settles on the rest glyph while the shimmer falls back to flat mark colour, never to a frozen gradient.',
      },
    },
  },
}
