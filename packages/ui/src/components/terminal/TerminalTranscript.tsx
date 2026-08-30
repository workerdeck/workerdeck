import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import type { TerminalAffordances } from './affordances.tsx'
import { OpenSubagentAction, WithActions } from './affordances.tsx'
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
import { taskBrief, taskBusy, taskFailed, taskSummary } from './tool-run.ts'
import { BRIEF_LINES } from './height.ts'
import { Blank, Row } from './row.tsx'
import { TerminalSurface } from './surface.tsx'

/**
 * The transcript, drawn as a terminal: items become row blocks, a blank line
 * between blocks that do not belong together, the working line one more row at
 * the end. Deliberately not virtualized — the virtualized shell in
 * `agent/Transcript.tsx` owns that, and renders rows through the same pieces.
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
export function TerminalItemView({ item, fileUrl }: { item: TranscriptItem; fileUrl?: (path: string) => string }) {
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
 * The sub-agent's brief, clipped to {@link BRIEF_LINES} and pressable for the
 * whole of it. Leads the takeover's frame and the inline task expansion alike;
 * callers splice it in only when the stream carries no brief of its own (see
 * `taskBrief`). The clip is `line-clamp`, which cuts on the same wrapped lines
 * `briefPx` counts — one rule, so the reserved height and the drawn height
 * cannot disagree.
 */
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

/**
 * A `Task` and everything its subagent produced, as one row. **Always
 * collapsed when unmounted** — load-bearing: `height.ts` predicts this row as
 * exactly one wrapped `taskSummary`, and expansion is component-local state
 * that dies with the row, so the live signal is *in* the collapsed line (the
 * pulse and a climbing count) rather than in an auto-opened block.
 */
export function TaskRow({
  block,
  fileUrl,
  onOpenSubagent,
}: {
  block: TaskBlock
  fileUrl?: (path: string) => string
  /** Take over the panel with this sub-agent's own frame. Absent draws no
   * affordance at all — the plain renderer has no surface to take over. */
  onOpenSubagent?: (toolUseId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealOnOpen(open)
  const children = useMemo(() => taskChildItems(block), [block])
  // Only when the sub-agent's own stream carries no brief — see `taskBrief`.
  const brief = children.some((item) => item.kind === 'user') ? undefined : taskBrief(block.task)
  const busy = taskBusy(block.task, children)
  const failed = taskFailed(block.task)
  const pulse = usePulse(busy)

  const row = (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        {/* The body is `taskSummary` verbatim — the string `height.ts` wraps
            to size this row. Green body = sub-agent (same meaning as on the
            rail; see `terminal.css`), but not the marker: a green glyph
            already means "wrote to the workspace" in the same gutter. Failure
            outranks it. */}
        <Row glyph={busy ? pulse : '●'} glyphTone={failed ? 'red' : busy ? 'mark' : 'dim'} tone={failed ? 'red' : 'green'}>
          {taskSummary(block.task, children)}
        </Row>
      </Pressable>
      {open ? (
        // `term-nested`, not a pixel border: 14px would take every nested
        // marker off the cell grid.
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
  // Wrapped only when there is somewhere to go: no "open" glyph on a renderer
  // that cannot honour it.
  return onOpenSubagent === undefined ? (
    row
  ) : (
    <WithActions actions={<OpenSubagentAction onOpen={() => onOpenSubagent(block.task.id)} />}>{row}</WithActions>
  )
}

/** When the current run began — the clock the working line counts from. Held
 * here, not in the row: the row comes and goes within a single turn, and a
 * clock restarting at every tool call would measure the wrong thing. */
const useRunStart = (status: TranscriptState['status']): number | undefined => {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

/** Is the model between outputs? Only then does the working line show — while
 * text is streaming, the text itself is the evidence. */
const working = (state: TranscriptState): boolean => {
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
      // One cell of breathing room at each edge; a full-bleed band cancels it.
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
