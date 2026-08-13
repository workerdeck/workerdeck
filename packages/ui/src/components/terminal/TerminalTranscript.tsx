import { Fragment, useEffect, useState } from 'react'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import type { TerminalAffordances } from './affordances.tsx'
import {
  AssistantRow,
  FileRow,
  NoticeRow,
  ThinkingRow,
  ToolRow,
  TurnResultRow,
  UserRow,
  WorkingRow,
  needsBlank,
} from './items.tsx'
import { Blank } from './row.tsx'
import { TerminalSurface } from './surface.tsx'

/**
 * The transcript, drawn as a terminal.
 *
 * The whole of the layout is here and it is four lines long, which is the point:
 * items become row blocks, a blank line goes between blocks that do not belong
 * together, and the working line is one more row at the end. There is no gap
 * scale, no density knob and no variant branch — a terminal has one line height
 * and one type size, and everything the theme can express is expressed in which
 * rows exist and what marker each carries.
 *
 * Not virtualized yet: the row blocks are the part that has to be right first,
 * and the existing `Transcript` already owns a hard-won virtualizer plus the
 * scroll-regime rules it needs. This renders into that shell when the rows are
 * settled, rather than growing a second copy of that logic.
 */
export interface TerminalTranscriptProps {
  state: TranscriptState
  /** Builds the download URL for a delivered file. */
  fileUrl?: (path: string) => string
  /** Cell metrics, in whole pixels. See {@link TerminalSurface}. */
  fontSize?: number
  lineHeight?: number
  /** The pointer affordances a real terminal has no way to offer — hover fill,
   * hover-revealed copy. `false` for none. See {@link TerminalAffordances}. */
  affordances?: TerminalAffordances | boolean
  className?: string
}

/**
 * One transcript item as terminal rows. Exported because the virtualized shell
 * in `agent/Transcript.tsx` renders rows through it: the theme owns how a row
 * looks, that component owns which rows are mounted, and neither needs a copy
 * of the other.
 */
export function TerminalItemView({
  item,
  fileUrl,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
}) {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'assistant_text':
      return <AssistantRow item={item} />
    case 'thinking':
      return <ThinkingRow item={item} />
    case 'tool_call':
      return <ToolRow item={item} />
    case 'turn_result':
      return <TurnResultRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
    case 'file_delivered':
      return <FileRow item={item} href={fileUrl?.(item.path)} />
    default:
      return null
  }
}

/** When the current run began — the clock the working line counts from. Held
 * here, not in the row, because the row comes and goes within a single turn (it
 * hides the moment text streams) and a clock restarting at every tool call
 * would be measuring the wrong thing. */
function useRunStart(status: TranscriptState['status']): number | undefined {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

/** Is the model between outputs? Only then does the working line show — while
 * text is streaming, the text itself is the evidence. */
function working(state: TranscriptState): boolean {
  if (state.status !== 'running' && state.status !== 'starting') return false
  const last = state.items.at(-1)
  if (!last) return true
  if (last.kind === 'assistant_text' && last.streaming) return false
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') return false
  return true
}

export function TerminalTranscript({
  state,
  fileUrl,
  fontSize,
  lineHeight,
  affordances,
  className,
}: TerminalTranscriptProps) {
  const runStartedAt = useRunStart(state.status)
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      affordances={affordances}
      // One cell of breathing room at each edge, and the value a full-bleed
      // band cancels so its wash reaches the scroller's edge.
      bleed='1ch'
      className={cn('term-transcript', className)}>
      {state.items.map((item, index) => (
        <Fragment key={`${item.kind}:${item.id}`}>
          {index > 0 && needsBlank(state.items[index - 1]!, item) ? <Blank /> : null}
          <TerminalItemView item={item} fileUrl={fileUrl} />
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
