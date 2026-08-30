import { useEffect, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { formatBytes, formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { isMutatingTool } from '../../lib/tool-icon.ts'
import { usePulse } from '../agent/pulse.tsx'
import { CopyAction, WithActions } from './affordances.tsx'
import { TerminalDiff } from './diff.tsx'
import { TerminalMarkdown } from './markdown.tsx'
import { Pressable, useRevealOnOpen } from './press.tsx'
import { IMAGE_BOX_LINES, IMAGE_UNAVAILABLE, imagePlaceholder } from './image-box.ts'
import { collapsedResult } from './result-preview.ts'
import { useToolResultFetcher } from '../agent/tool-result-fetch.tsx'
import { useToolResultImageSrc } from '../agent/tool-result-image.tsx'
import { runFailed, runSummary } from './tool-run.ts'
import { type ToolCallItem } from './blocks.ts'
import { Band, Blank, Ink, Row, type Tone } from './row.tsx'

// The pure block model — which rows exist — lives in `blocks.ts`; re-exported
// here because this file is where consumers have always found it.
export {
  blockNeedsBlank,
  isRunCall,
  needsBlank,
  parentOf,
  taskChildItems,
  terminalBlocks,
  type ItemBlock,
  type LeafBlock,
  type RunBlock,
  type TaskBlock,
  type TerminalBlock,
  type ToolCallItem,
} from './blocks.ts'

/**
 * One transcript item, drawn as terminal rows. Each renderer answers the same
 * two questions: which marker goes in the gutter, and what the body says —
 * never a spacing, radius or border. The markers are the CLI's:
 *
 * | glyph | means                                    |
 * |-------|------------------------------------------|
 * | `❯`   | what you typed                           |
 * | `●`   | what the model said, or a tool it called |
 * | `⎿`   | that tool's output, one level in         |
 * | `✻`   | thinking                                 |
 * | `!`   | a notice from the runner, not the model  |
 */

/**
 * The prompt marker, in the transcript and the composer both — exported so
 * the composer's caret sits on the same column the rows above start on.
 */
export const PROMPT_GLYPH = '❯'

/** How much the expanded row shows before offering the rest. The collapsed
 * budget is `collapsedResult`'s, shared with the height calculator.
 *
 * Exported for one test and not from the package: protocol's
 * `TOOL_RESULT_HEAD_CHARS` is chosen to exceed it, so that a truncated result's
 * open state is byte-identical to an untruncated one and only the uncapped
 * `full` press ever fetches. That relationship is asserted, not assumed. */
export const RESULT_PREVIEW_CHARS = 2000

/** Whole lines up to a character budget — never zero: a single line longer
 * than the budget still has to be shown. */
const clipToChars = (lines: string[], maxChars: number): string[] => {
  const out: string[] = []
  let chars = 0
  for (const line of lines) {
    if (out.length > 0 && chars + line.length > maxChars) {
      break
    }
    out.push(line)
    chars += line.length + 1
  }
  return out
}

export function UserRow({ item }: { item: Extract<TranscriptItem, { kind: 'user' }> }) {
  return (
    <div className="term-user">
      {item.attachments?.length ? (
        <Row glyph={PROMPT_GLYPH} glyphTone="dim" tone="dim">
          {item.attachments.map((attachment) => attachment.name).join(', ')}
        </Row>
      ) : null}
      {/* Only the first line keeps the marker, as a shell continuation does. */}
      {item.text
        ? item.text.split('\n').map((line, index) => (
            <Row key={index} glyph={index === 0 ? PROMPT_GLYPH : undefined} glyphTone="dim" tone="fg">
              {line || ' '}
            </Row>
          ))
        : null}
    </div>
  )
}

export function AssistantRow({ item }: { item: Extract<TranscriptItem, { kind: 'assistant_text' }> }) {
  return (
    // Copy the markdown source, not the rendered text. Absent while streaming
    // — the button would appear mid-sentence.
    <WithActions actions={item.streaming ? null : <CopyAction text={item.text} label="Copy message" />}>
      <Row glyph="●" glyphTone="fg" tone="fg">
        <TerminalMarkdown streaming={item.streaming}>{item.text}</TerminalMarkdown>
      </Row>
    </WithActions>
  )
}

export function ThinkingRow({ item }: { item: Extract<TranscriptItem, { kind: 'thinking' }> }) {
  return (
    <Row glyph="✻" glyphTone="dim" tone="dim">
      <span className="term-em">{item.text}</span>
    </Row>
  )
}

/** The gutter dot's colour: the call's state, said without a badge. */
const TOOL_TONE: Record<string, Tone> = {
  running: 'blue',
  pending: 'blue',
  deferred: 'yellow',
  settled: 'dim',
  failed: 'red',
}

export function ToolRow({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  // Row-local, unlike the fetched text itself (which lands in transcript
  // state) — this is a spinner, not a fact about the session.
  const [fetching, setFetching] = useState(false)
  const fetchResult = useToolResultFetcher()
  const reveal = useRevealOnOpen(open)
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const busy = status === 'running' || status === 'pending'
  const isError = status === 'failed' || item.result?.isError === true
  // Ticks only while this row is really running: an idle transcript starts no
  // timers at all.
  const pulse = usePulse(busy)

  const text = item.result?.text ?? ''
  const lines = text.trimEnd().split('\n')
  // Three states, not two: collapsed shows a few lines, open shows up to a
  // character budget, `full` lifts it. The middle state exists because a
  // hundred-thousand-character result lands in ONE virtual row — the
  // virtualizer mounts rows and cannot help with what is inside a single one,
  // so an unclipped expand commits thousands of DOM nodes.
  const collapsed = collapsedResult(lines, item.result?.totalChars)
  const preview = open ? (full ? lines : clipToChars(lines, RESULT_PREVIEW_CHARS)) : collapsed.shown
  const hidden = lines.length - preview.length
  const clipped = open && !full && hidden > 0
  // The replay sent a head: `full` then means "fetch the rest", and the marker
  // outlives the clip — a head short enough to fit the open budget still is
  // not the result.
  const truncated = item.result?.truncated === true
  const missing = truncated ? (item.result?.totalChars ?? 0) - text.length : 0

  const tone: Tone = isError
    ? 'red'
    : // A settled write is green: "what did it change" is the skimming question.
      status === 'settled' && isMutatingTool(item.name)
      ? 'green'
      : (TOOL_TONE[status] ?? 'dim')

  // Copy the command you would re-run when there is one, otherwise the output.
  const command = (item.input as { command?: unknown } | null)?.command
  const copyable = typeof command === 'string' ? command : text

  return (
    // Open, the whole block keeps a fill: an expansion running past the top of
    // the screen otherwise leaves no mark of where it began.
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <WithActions actions={copyable ? <CopyAction text={copyable} label="Copy" /> : null}>
        <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
          <Row glyph={busy ? pulse : '●'} glyphTone={tone} tone="fg">
            <Ink bold tone="bright">
              {item.name}
            </Ink>
            <Ink tone="dim">({toolInputPreview(item.input)})</Ink>
            {item.backend && item.backend !== 'server' ? <Ink tone="faint"> · {item.backend}</Ink> : null}
          </Row>
        </Pressable>
        {/* Above the output, drawn collapsed as well as open: when a call
          returned a picture, the picture is the answer, not detail. */}
        {item.result?.images?.map((image) => (
          <TerminalImage key={image.partIndex} toolUseId={item.id} image={image} />
        ))}
        {/* A file edit shows its diff, not its result prose; the text stays
          reachable by expanding. */}
        {item.patch && !open ? (
          <TerminalDiff patch={item.patch} />
        ) : text ? (
          <>
            {preview.map((line, index) => (
              <Row key={index} indent={1} columns={3} glyph={index === 0 ? '⎿' : undefined} tone={isError ? 'red' : 'dim'}>
                {line || ' '}
              </Row>
            ))}
            {/* One "there is more" row, pressable exactly when pressing does
              something. Collapsed it is a label (the header is the toggle) and
              its text is the string `height.ts` sizes the row from. */}
            {!open ? (
              collapsed.more ? (
                <Row indent={1} columns={3} tone="faint">
                  {collapsed.more}
                </Row>
              ) : null
            ) : clipped || truncated ? (
              <Row indent={1} columns={3} tone="faint">
                {fetching ? (
                  // Never a row that does nothing when pressed: it says what
                  // it is doing instead.
                  <>… fetching {(item.result?.totalChars ?? 0).toLocaleString()} chars</>
                ) : clipped || truncated ? (
                  <button
                    type="button"
                    className="term-press term-link"
                    onClick={() => {
                      // Lift the clip immediately (local and instant), fetch
                      // the rest when there is a rest — the fetched text lands
                      // in transcript state and the marker goes with it.
                      setFull(true)
                      if (!truncated) {
                        return
                      }
                      setFetching(true)
                      void fetchResult(item.id).finally(() => setFetching(false))
                    }}
                  >
                    {truncated
                      ? `… +${missing.toLocaleString()} chars — fetch the rest`
                      : `… +${hidden} line${hidden === 1 ? '' : 's'} — show all ${text.length.toLocaleString()} chars`}
                  </button>
                ) : (
                  <>
                    … +{hidden} line{hidden === 1 ? '' : 's'}
                  </>
                )}
              </Row>
            ) : hidden > 0 ? (
              <Row indent={1} columns={3} tone="faint">
                … +{hidden} line{hidden === 1 ? '' : 's'}
              </Row>
            ) : null}
          </>
        ) : null}
      </WithActions>
    </div>
  )
}

/** One image part of a tool result, as the reducer holds it. */
type ToolResultImage = NonNullable<NonNullable<ToolCallItem['result']>['images']>[number]

/**
 * A picture a tool returned, in a box of {@link IMAGE_BOX_LINES} whole lines.
 * **Three states, one height** — pending wash, loaded (letterboxed), failed.
 * Nothing here may ever collapse to nothing: in a virtualized list that is a
 * reflow of every row below, and the height calculator would have been lying
 * about the row from plan time.
 */
function TerminalImage({ toolUseId, image }: { toolUseId: string; image: ToolResultImage }) {
  const { src, failed } = useToolResultImageSrc({ toolUseId, ...image })
  return (
    <Row indent={1} columns={3}>
      <div
        className="term-image"
        data-state={src ? 'loaded' : failed ? 'failed' : 'pending'}
        // The one measurement in this file — `height.ts` adds exactly this
        // many lines for exactly this box.
        style={{ height: `calc(var(--term-line) * ${IMAGE_BOX_LINES})` }}
      >
        {src ? (
          <img src={src} alt={imagePlaceholder(image)} />
        ) : (
          <Ink tone="faint">{failed ? IMAGE_UNAVAILABLE : imagePlaceholder(image)}</Ink>
        )}
      </div>
    </Row>
  )
}

/**
 * A run of tool calls, as one line — the CLI's own compression. Membership,
 * wording and failure rules live in `tool-run.ts`, shared with the height
 * calculator. A failure never breaks the run, and only the run's **last** call
 * colours it (see `runFailed`).
 */
export function ToolRunRow({ items }: { items: ToolCallItem[] }) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealOnOpen(open)
  const busy = items.some((item) => {
    const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
    return status === 'running' || status === 'pending'
  })
  const failed = runFailed(items)
  const pulse = usePulse(busy)

  return (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        {/* No marker once settled: a run is an aside. While one is running the
            pulse earns the gutter. */}
        <Row glyph={busy ? pulse : undefined} glyphTone={busy ? 'mark' : undefined} tone={failed ? 'red' : 'dim'}>
          {runSummary(items, busy)}
        </Row>
      </Pressable>
      {open ? (
        <div>
          {items.map((item) => (
            <ToolRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  return (
    <div>
      <Row tone={item.isError ? 'red' : 'faint'}>
        {item.isError ? item.subtype : 'done'} · {formatDuration(item.durationMs)} · {formatCost(item.totalCostUsd)}
      </Row>
      {/* Dropping the reasons would leave "error_during_execution" and nothing
          to act on. */}
      {item.errors?.map((message, index) => (
        <Row key={index} tone="red">
          {message}
        </Row>
      ))}
    </div>
  )
}

export function NoticeRow({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) {
  const error = item.level === 'error'
  return (
    <Row glyph="!" glyphTone={error ? 'red' : 'yellow'} tone={error ? 'red' : 'dim'}>
      {item.text}
    </Row>
  )
}

export function FileRow({ item, href }: { item: Extract<TranscriptItem, { kind: 'file_delivered' }>; href?: string }) {
  return (
    <Row glyph="⤓" glyphTone="blue" tone="dim">
      {href ? (
        <a className="term-link" data-tone="blue" href={href} download>
          {item.path}
        </a>
      ) : (
        <Ink tone="blue">{item.path}</Ink>
      )}
      <Ink tone="faint"> · {formatBytes(item.bytes)}</Ink>
      {item.description ? <Ink tone="faint"> · {item.description}</Ink> : null}
    </Row>
  )
}

/** A once-a-second clock, running only while `on`. */
export function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/**
 * The working line: the mark's pulse, the word, and the run's readings — the
 * CLI's own status line, which is a *row of the transcript* rather than a
 * spinner floating over it.
 */
export function WorkingRow({ label, startedAt, tokens }: { label: string; startedAt?: number; tokens?: number }) {
  const pulse = usePulse(true)
  // The row owns its clock: it is mounted only while a turn is in flight, so
  // an idle transcript runs no interval at all.
  const now = useTicker(startedAt !== undefined)
  const elapsed = startedAt === undefined ? undefined : formatDuration(now - startedAt)
  const readings = [elapsed, tokens ? `↓ ${(tokens / 1000).toFixed(1)}k tokens` : undefined].filter(Boolean)
  return (
    <Row glyph={pulse} glyphTone="mark" tone="mark">
      {label}
      {readings.length ? <Ink tone="faint"> ({readings.join(' · ')})</Ink> : null}
    </Row>
  )
}

export { Band, Blank }
