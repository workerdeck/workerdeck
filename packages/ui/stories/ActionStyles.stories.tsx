import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import {
  ActionPlacementProvider,
  AgentWriteAction,
  BookmarkAction,
  BookmarkProvider,
  CopyAction,
  KillShellAction,
  OpenShellAction,
  WithActions,
} from '../src/components/terminal/affordances.tsx'
import { Blank, Ink, Row } from '../src/components/terminal/row.tsx'
import { TerminalSurface } from '../src/components/terminal/surface.tsx'

function Sample() {
  const [marks, setMarks] = useState(() => new Set(['u1']))
  const [granted, setGranted] = useState(false)
  const bookmarks = {
    has: (id: string) => marks.has(id),
    toggle: (id: string) =>
      setMarks((previous) => {
        const next = new Set(previous)
        if (!next.delete(id)) {
          next.add(id)
        }
        return next
      }),
  }
  return (
    <BookmarkProvider value={bookmarks}>
      <WithActions actions={<BookmarkAction id="u1" />}>
        <div className="term-user">
          <Row glyph=">" glyphTone="dim" tone="fg">
            Refactor the session registry so parking survives a hot reload.
          </Row>
        </div>
      </WithActions>
      <Blank />
      <WithActions
        actions={
          <>
            <BookmarkAction id="a1" />
            <CopyAction text="copied" />
          </>
        }
      >
        <Row glyph="●" glyphTone="fg" tone="fg">
          The registry now keeps parked sessions in a map keyed by id, so the swap carries them across.
        </Row>
      </WithActions>
      <Blank />
      <WithActions
        actions={
          <>
            <OpenShellAction onOpen={() => undefined} />
            <AgentWriteAction granted={granted} label="Toggle agent write" onToggle={() => setGranted((v) => !v)} />
            <KillShellAction onKill={() => undefined} />
            <BookmarkAction id="s1" />
          </>
        }
      >
        <Row glyph="$" glyphTone="magenta" tone="fg">
          <Ink bold tone="bright">
            pnpm dev
          </Ink>
          <Ink tone="faint"> · running</Ink>
        </Row>
      </WithActions>
      <Blank />
      {['git status --short', 'pnpm typecheck'].map((cmd) => (
        <ActionPlacementProvider key={cmd} value="inline">
          <WithActions
            actions={
              <>
                <BookmarkAction id={cmd} />
                <CopyAction text={cmd} />
              </>
            }
          >
            <Row glyph="●" glyphTone="green" tone="fg">
              <Ink bold tone="bright">
                Bash
              </Ink>
              <Ink tone="dim">({cmd})</Ink>
            </Row>
          </WithActions>
        </ActionPlacementProvider>
      ))}
      <Blank />
      <Blank />
    </BookmarkProvider>
  )
}

function Frame({ title, labels, pinned }: { title: string; labels: boolean; pinned: boolean }) {
  return (
    <section style={{ marginBottom: 20 }} data-pinned={pinned ? '' : undefined}>
      <div style={{ font: '600 12px system-ui', color: 'var(--fg-2, #ccc)', margin: '0 0 6px 12px' }}>{title}</div>
      <TerminalSurface bleed="1ch" affordances={{ labels }} style={{ padding: '0 1ch' }}>
        <Sample />
      </TerminalSurface>
    </section>
  )
}

function Gallery({ pinned }: { pinned: boolean }) {
  return (
    <div data-theme="dark" style={{ background: 'var(--bg)', padding: '16px 0', minHeight: '100vh' }}>
      <style>{'[data-pinned] [data-terminal] .term-actions { opacity: 1; }'}</style>
      <Frame title="A · Icons" labels={false} pinned={pinned} />
      <Frame title="B · Icons + labels" labels pinned={pinned} />
    </div>
  )
}

const meta: Meta<typeof Gallery> = {
  title: 'Review/ActionStyles',
  component: Gallery,
  parameters: { layout: 'fullscreen' },
}

export default meta

type Story = StoryObj<typeof Gallery>

export const Pinned: Story = { args: { pinned: true } }

export const Hover: Story = { args: { pinned: false } }
