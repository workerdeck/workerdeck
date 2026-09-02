import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import type { TerminalAffordances } from './affordances.tsx'
import { OpenSubagentAction, WithActions } from './affordances.tsx'
import { AssistantRow, CompactionRow, FileRow, NoticeRow, ToolRunRow, ThinkingRow, ToolRow, TurnResultRow, UserRow, WorkingRow } from './items.tsx'
import { blockNeedsBlank, taskChildItems, terminalBlocks, type TaskBlock } from './blocks.ts'
import { usePulse } from '../agent/pulse.tsx'
import { Pressable, useRevealOnOpen } from './press.tsx'
import { taskBrief, taskBusy, taskFailed, taskSummary } from './tool-run.ts'
import { BRIEF_LINES } from './height.ts'
import { Blank, Row } from './row.tsx'
import { TerminalSurface } from './surface.tsx'

export interface TerminalTranscriptProps {
  state: TranscriptState
  fileUrl?: (path: string) => string
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  className?: string
}

export function TerminalItemView({ item, fileUrl }: { item: TranscriptItem; fileUrl?: (path: string) => string }) {
  switch (item.kind) {
    case 'user': {
      return <UserRow item={item} />
    }
    case 'assistant_text': {
      return <AssistantRow item={item} />
    }
    case 'thinking': {
      return <ThinkingRow item={item} />
    }
    case 'tool_call': {
      return <ToolRow item={item} />
    }
    case 'turn_result': {
      return <TurnResultRow item={item} />
    }
    case 'notice': {
      return <NoticeRow item={item} />
    }
    case 'compaction': {
      return <CompactionRow />
    }
    case 'file_delivered': {
      return <FileRow item={item} href={fileUrl?.(item.path)} />
    }
    default: {
      return null
    }
  }
}

export function BriefRow({ text, terminal }: { text: string; terminal?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!terminal) {
    return (
      <div data-slot="brief" className="px-4 py-2 text-body-sm whitespace-pre-wrap text-fg-2">
        {text}
      </div>
    )
  }
  return (
    <div data-slot="brief">
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        <Row glyph=">" glyphTone="blue" tone="dim">
          <span
            className={cn('whitespace-pre-wrap', !open && 'term-brief-clip')}
            style={open ? undefined : { WebkitLineClamp: BRIEF_LINES }}
          >
            {text}
          </span>
        </Row>
      </Pressable>
    </div>
  )
}

export function TaskRow({
  block,
  fileUrl,
  onOpenSubagent,
}: {
  block: TaskBlock
  fileUrl?: (path: string) => string
  onOpenSubagent?: (toolUseId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealOnOpen(open)
  const children = useMemo(() => taskChildItems(block), [block])
  const brief = children.some((item) => item.kind === 'user') ? undefined : taskBrief(block.task)
  const busy = taskBusy(block.task, children)
  const failed = taskFailed(block.task)
  const pulse = usePulse(busy)

  const row = (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        <Row glyph={busy ? pulse : '●'} glyphTone={failed ? 'red' : busy ? 'mark' : 'dim'} tone={failed ? 'red' : 'green'}>
          {taskSummary(block.task, children)}
        </Row>
      </Pressable>
      {open ? (
        <div className="term-nested">
          {brief ? <BriefRow text={brief} terminal /> : null}
          {block.children.map((leaf, index) => (
            <Fragment key={leaf.key}>
              {index > 0 && blockNeedsBlank(block.children[index - 1]!, leaf) ? <Blank /> : null}
              {'run' in leaf ? <ToolRunRow items={leaf.run} /> : <TerminalItemView item={leaf.item} fileUrl={fileUrl} />}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
  return onOpenSubagent === undefined ? (
    row
  ) : (
    <WithActions actions={<OpenSubagentAction onOpen={() => onOpenSubagent(block.task.id)} />}>{row}</WithActions>
  )
}

function useRunStart(status: TranscriptState['status']): number | undefined {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

function working(state: TranscriptState): boolean {
  if (state.status !== 'running' && state.status !== 'starting') {
    return false
  }
  const last = state.items.at(-1)
  if (!last) {
    return true
  }
  if (last.kind === 'assistant_text' && last.streaming) {
    return false
  }
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') {
    return false
  }
  return true
}

export function TerminalTranscript({ state, fileUrl, fontSize, lineHeight, affordances, className }: TerminalTranscriptProps) {
  const runStartedAt = useRunStart(state.status)
  const blocks = useMemo(() => terminalBlocks(state.items), [state.items])
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      affordances={affordances}
      bleed="1ch"
      className={cn('term-transcript', className)}
    >
      {blocks.map((block, index) => (
        <Fragment key={block.key}>
          {index > 0 && blockNeedsBlank(blocks[index - 1]!, block) ? <Blank /> : null}
          {'run' in block ? (
            <ToolRunRow items={block.run} />
          ) : 'item' in block ? (
            <TerminalItemView item={block.item} fileUrl={fileUrl} />
          ) : (
            <TaskRow block={block} fileUrl={fileUrl} />
          )}
        </Fragment>
      ))}
      {working(state) ? (
        <>
          {state.items.length > 0 ? <Blank /> : null}
          <WorkingRow
            label={state.status === 'starting' ? 'Starting…' : 'Working…'}
            startedAt={runStartedAt}
            tokens={state.contextUsage?.totalTokens}
          />
        </>
      ) : null}
    </TerminalSurface>
  )
}
