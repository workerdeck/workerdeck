import { ArrowLeft } from 'lucide-react'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { formatDuration } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { Ink, Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { taskBusy, taskFailed, taskIdentity } from '../terminal/tool-run.ts'
import type { ToolCallItem } from '../terminal/blocks.ts'
import { usePulse } from './pulse.tsx'
import { useTicker } from '../terminal/items.tsx'

/**
 * The one line above a sub-agent takeover: who this is, how it is doing, and the
 * way back.
 *
 * **It claims exactly what the `TaskRow` it was opened from claims** — the same
 * `taskBusy` / `taskFailed` / tool count over the same items — and deliberately
 * *not* `SubagentInfo.status`. Protocol documents those two as divergent on
 * purpose (`index.ts:1476-1487`), but that divergence is transcript-versus-*list*
 * and this surface **is** the transcript. The disagreement that must not exist
 * here is between a header and the rows directly beneath it.
 *
 * The rollup is still allowed one job — naming an agent whose `Task` call is not
 * in the transcript — because a label is not content, and `SessionInfo.subagents`
 * keeps only eight settled records (`SUBAGENT_HISTORY`), so it can never be the
 * source of what a frame *shows*.
 *
 * Both variants, because the panel has two and a strip that only existed in one
 * would make the takeover a terminal-theme feature rather than a session feature.
 */
export function SubagentStrip({
  task,
  items,
  label,
  onBack,
  terminal,
  fontSize,
  lineHeight,
}: {
  /** The spawning call. Absent when the transcript does not have it — the strip
   *  still draws, because the way back must exist even when the content cannot. */
  task: ToolCallItem | undefined
  /** The frame's items, for the busy reading and the tool count. */
  items: readonly TranscriptItem[]
  /** Fallback name when there is no task item. */
  label: string
  onBack: () => void
  terminal: boolean
  fontSize?: number
  lineHeight?: number
}) {
  const busy = task ? taskBusy(task, items) : false
  const failed = task ? taskFailed(task) : false
  const pulse = usePulse(busy)
  const tools = items.reduce((n, item) => n + (item.kind === 'tool_call' ? 1 : 0), 0)
  // Ticks only while it works, off the same once-a-second clock the working
  // line uses. A settled agent has no end timestamp to measure against, and
  // "N tools" is the settled reading anyway — a frozen clock would read as a
  // stall. Absent `ts` (an item from before the reducer stamped it) simply
  // draws no elapsed rather than counting from the epoch.
  const startedAt = busy ? task?.ts : undefined
  const now = useTicker(startedAt !== undefined)
  const elapsed = startedAt === undefined ? undefined : formatDuration(now - startedAt)

  const name = task ? taskIdentity(task) : label
  /**
   * Running or finished, in the theme's own words rather than new ones:
   * `taskSummary` already says `working…` and `done` for exactly this state one
   * row over, and a header that said "running"/"completed" about the same agent
   * would be a second vocabulary for one fact. The trailing ellipsis is the
   * theme's in-flight signal; the pulse beside it is the beat.
   *
   * Unknown when the transcript has no `Task` call to read — better silent than
   * confidently wrong about an agent we cannot see.
   */
  const status = !task ? undefined : failed ? 'failed' : busy ? `${pulse} working…` : 'done'
  const detail = [tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : undefined, elapsed].filter(Boolean).join(' · ')

  if (terminal) {
    return (
      <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} className="shrink-0">
        {/* A row on the grid, not a chrome bar: the takeover is a mode of the
            transcript, and a toolbar in some other metric above it would read as
            a different application's. The whole line is the target — there is
            exactly one thing to do here. */}
        <button type="button" onClick={onBack} aria-label="Back to the session" className="block w-full cursor-pointer text-left">
          {/* The arrow is in the gutter unconditionally. It used to give way to
              the pulse while the agent worked, which put the way *out* of the
              frame on a timer — the one control here should not come and go.
              The beat moved into the status instead. `indent` because this is a
              frame around the rows rather than one of them, and a marker flush
              against the panel edge reads as a clipped row. */}
          <Row glyph="←" glyphTone="dim" indent={1} tone={failed ? 'red' : 'green'}>
            {name}
            {status ? <Ink tone={failed ? 'red' : busy ? 'mark' : 'dim'}> · {status}</Ink> : null}
            {detail ? <Ink tone="faint"> · {detail}</Ink> : null}
          </Row>
        </button>
      </TerminalSurface>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-6 gap-1 px-1.5">
        <ArrowLeft className="size-3.5" />
        Back
      </Button>
      <span className={cn('min-w-0 flex-1 truncate text-body-sm', failed ? 'text-danger' : 'text-fg-2')}>{name}</span>
      {status ? (
        <span className={cn('shrink-0 text-label', failed ? 'text-danger' : busy ? 'text-accent' : 'text-fg-3')}>{status}</span>
      ) : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
    </div>
  )
}
