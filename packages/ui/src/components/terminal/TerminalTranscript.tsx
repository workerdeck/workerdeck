import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import type { TerminalAffordances } from './affordances.tsx'
import {
  AssistantRow,
  FileRow,
  NoticeRow,
  ToolRunRow,
  ThinkingRow,
  ToolRow,
  TurnResultRow,
  UserRow,
  WorkingRow,
  blockNeedsBlank,
  taskChildItems,
  terminalBlocks,
  type TaskBlock,
} from './items.tsx'
import { usePulse } from '../agent/pulse.tsx'
import { Pressable, useRevealOnOpen } from './press.tsx'
import { taskBusy, taskFailed, taskSummary } from './tool-run.ts'
import { Blank, Row } from './row.tsx'
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

/**
 * A `Task` and everything the subagent it spawned produced, as one row.
 *
 * The same claim the tool-run fold makes, and a stronger one: a subagent is
 * *sixty* rows of somebody else's working — a brief, a dozen greps, its own
 * thinking — and none of it is what you came back to read. What you came back
 * to read is the report, and the report is the model's next sentence. So the
 * whole frame collapses to one line saying what was asked and how big the
 * answer was, and opens in full the moment it is the thing you want.
 *
 * **Always collapsed when unmounted**, and that is load-bearing rather than
 * tidy: `height.ts` predicts this row as exactly one wrapped `taskSummary`, and
 * expansion is component-local state that dies with the row. A row auto-opening
 * because its subagent happens to be running would make its own height
 * unpredictable — which is why the live signal is *in* the collapsed line (the
 * pulse, and a count that climbs) rather than in an open block.
 *
 * The children are the theme's ordinary rows, stepped in behind a rule, and
 * they fold among themselves: a subagent's consecutive tool calls are as much
 * an aside inside its frame as they are in the main thread.
 */
export function TaskRow({
  block,
  fileUrl,
}: {
  block: TaskBlock
  fileUrl?: (path: string) => string
}) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealOnOpen(open)
  const children = useMemo(() => taskChildItems(block), [block])
  const busy = taskBusy(block.task, children)
  const failed = taskFailed(block.task)
  const pulse = usePulse(busy)

  return (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        {/* A marker, where a folded run of calls gets none: a run is an aside,
            but delegating a piece of the work is something the model *did*, and
            the row stands for the whole of it. The body is `taskSummary`
            verbatim — it is the string `height.ts` wraps to size this row, and
            a second spelling here would be a second height. */}
        {/* Green means sub-agent, and it means it here for the same reason it
            means it on the rail: every other colour is spoken for — blue is
            you, white is the answer, red is an alarm, magenta is your bookmark,
            yellow is the session waiting on you (see `terminal.css`). The
            *body* is green and the marker is not: a green glyph already means
            "wrote to the workspace" a few rows down, and one colour cannot mean
            two things in the same gutter. Failure still outranks it — an alarm
            is not a category. */}
        <Row
          glyph={busy ? pulse : '●'}
          glyphTone={failed ? 'red' : busy ? 'mark' : 'dim'}
          tone={failed ? 'red' : 'green'}>
          {taskSummary(block.task, children)}
        </Row>
      </Pressable>
      {open ? (
        // `term-nested` and not the shell's cards-era `border-l-2 pl-3`: this
        // sits on the open block's wash, where that border token is invisible,
        // and its 14px would take every nested marker off the cell grid.
        <div className='term-nested'>
          {block.children.map((leaf, index) => (
            <Fragment key={leaf.key}>
              {index > 0 && blockNeedsBlank(block.children[index - 1]!, leaf) ? <Blank /> : null}
              {'run' in leaf ? (
                <ToolRunRow items={leaf.run} />
              ) : (
                <TerminalItemView item={leaf.item} fileUrl={fileUrl} />
              )}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
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
  const blocks = useMemo(() => terminalBlocks(state.items), [state.items])
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      affordances={affordances}
      // One cell of breathing room at each edge, and the value a full-bleed
      // band cancels so its wash reaches the scroller's edge.
      bleed='1ch'
      className={cn('term-transcript', className)}>
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
