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

// The pure block model — which rows exist — lives in `blocks.ts` now that a
// task block made it non-trivial; re-exported here because this file is where
// consumers have always found it.
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
 * One transcript item, drawn as terminal rows.
 *
 * Each renderer here answers the same two questions the CLI answers: which
 * marker goes in the gutter, and what the body says. Nothing chooses a spacing,
 * a radius or a border — a row is a row, and the space between blocks is a
 * {@link Blank} decided by the transcript, which is the only thing that knows
 * whether two blocks belong together.
 *
 * The markers are the CLI's:
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
 * The prompt marker, in the transcript and in the composer both.
 *
 * `❯` rather than `>`: it is the shell prompt of every terminal anyone has
 * configured this decade, and it reads as a *prompt* where `>` reads as a
 * quotation or a greater-than. Exported because the composer is the same
 * marker in the same gutter cell — that is the whole claim of the terminal
 * composer, and two spellings of it would put the caret one glyph off the
 * column the rows above start on.
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

/** Whole lines up to a character budget — never zero, because a single line
 * longer than the budget still has to be shown or the row would open onto
 * nothing. */
function clipToChars(lines: string[], maxChars: number): string[] {
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
      {/* Every line of a multi-line prompt keeps the band and the column; only
          the first keeps the marker, exactly as a shell continuation does. */}
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
    // Copy the markdown source, not the rendered text: what you paste into an
    // issue or a commit message should keep its lists and its code fences.
    // Absent while streaming — half a message is not a thing anyone wants on
    // their clipboard, and the button would appear mid-sentence.
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
  // Set while the rest of a truncated result is in flight. Row-local, unlike the
  // text itself, which lands in transcript state — this is a spinner, not a
  // fact about the session.
  const [fetching, setFetching] = useState(false)
  const fetchResult = useToolResultFetcher()
  const reveal = useRevealOnOpen(open)
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const busy = status === 'running' || status === 'pending'
  const isError = status === 'failed' || item.result?.isError === true
  // Ticks only while this row is really running: an idle transcript of a hundred
  // settled calls starts no timers at all.
  const pulse = usePulse(busy)

  const text = item.result?.text ?? ''
  const lines = text.trimEnd().split('\n')
  // Three states, not two. Collapsed shows a few lines; open shows the output up
  // to a character budget; `full` lifts the budget. The middle one is the reason
  // the budget exists at all: a tool result can be a hundred thousand characters
  // (a test run, a `find /`), and the whole of it lands in **one** virtual row —
  // the virtualizer mounts rows, so it cannot help with what is inside a single
  // one. Without the clip, expanding one row commits thousands of DOM nodes and
  // the transcript stops being smooth for the rest of the session.
  // The true total when the replay delivered only a head — the row must count
  // what is missing, not what it happens to hold.
  const collapsed = collapsedResult(lines, item.result?.totalChars)
  const preview = open ? (full ? lines : clipToChars(lines, RESULT_PREVIEW_CHARS)) : collapsed.shown
  const hidden = lines.length - preview.length
  const clipped = open && !full && hidden > 0
  // The replay sent a head. `full` then means "fetch the rest", not "lift the
  // clip" — and the marker outlives the clip, because a head short enough to fit
  // the open budget still is not the result.
  const truncated = item.result?.truncated === true
  const missing = truncated ? (item.result?.totalChars ?? 0) - text.length : 0

  const tone: Tone = isError
    ? 'red'
    : // A settled write is green: skimming a run, "what did it change" is the
      // question you come back to, and the one you might need to undo.
      status === 'settled' && isMutatingTool(item.name)
      ? 'green'
      : (TOOL_TONE[status] ?? 'dim')

  // What is worth having on the clipboard from a tool call is the command you
  // would re-run, when there is one, and otherwise its output.
  const command = (item.input as { command?: unknown } | null)?.command
  const copyable = typeof command === 'string' ? command : text

  return (
    // Open, the whole block keeps a fill: an expansion that runs past the top of
    // the screen otherwise leaves no mark of where it began, and the reader has
    // to guess which rows they opened.
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
        {/* Above the output, because when a call returned a picture the picture is
          what the call was: a screenshot's result text is "took a screenshot".
          Drawn collapsed as well as open — this is not detail behind a press,
          it is the answer. */}
        {item.result?.images?.map((image) => (
          <TerminalImage key={image.partIndex} toolUseId={item.id} image={image} />
        ))}
        {/* A file edit shows its diff, not its result prose: "The file has been
          updated" is what the *model* needed to hear, and the change is what the
          reader did. The text stays reachable by expanding. */}
        {item.patch && !open ? (
          <TerminalDiff patch={item.patch} />
        ) : text ? (
          <>
            {preview.map((line, index) => (
              <Row key={index} indent={1} columns={3} glyph={index === 0 ? '⎿' : undefined} tone={isError ? 'red' : 'dim'}>
                {line || ' '}
              </Row>
            ))}
            {/* One row for "there is more", pressable exactly when pressing it
              would do something. Collapsed, the count is a label — the header
              above is already the toggle, and a second control for the same act
              is one too many. Open and clipped, it is the way to the rest.
              Collapsed spells its own label (it may be counting characters
              rather than lines, having cut inside one), and it is the string
              `height.ts` sizes the row from. */}
            {!open ? (
              collapsed.more ? (
                <Row indent={1} columns={3} tone="faint">
                  {collapsed.more}
                </Row>
              ) : null
            ) : clipped || truncated ? (
              <Row indent={1} columns={3} tone="faint">
                {fetching ? (
                  // Never a row that does nothing when pressed: it says what it is
                  // doing instead. See `planToolCall`'s comment on the same rule.
                  <>… fetching {(item.result?.totalChars ?? 0).toLocaleString()} chars</>
                ) : clipped || truncated ? (
                  <button
                    type="button"
                    className="term-press term-link"
                    onClick={() => {
                      // One press, two acts, in the order that keeps the row
                      // honest: lift the clip immediately (that part is local and
                      // instant), and fetch the rest when there is a rest. The
                      // fetched text lands in transcript state, so the row
                      // re-renders with the marker gone.
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
 *
 * **Three states, one height.** Before the fetch lands the box is a wash and the
 * size the gateway declared; after it, the picture, letterboxed inside the same
 * box; on a refusal, `image unavailable` in it. Nothing here may ever collapse
 * to nothing — that is `HostImage`'s return-null-then-pop, which in a
 * *virtualized* list is not a flicker but a reflow of every row below it, and
 * the height calculator would have been lying about the row from plan time.
 *
 * The box is why the calculator can stay exact: it is a constant, not a function
 * of pixels nobody has downloaded yet.
 */
function TerminalImage({ toolUseId, image }: { toolUseId: string; image: ToolResultImage }) {
  const { src, failed } = useToolResultImageSrc({ toolUseId, ...image })
  return (
    <Row indent={1} columns={3}>
      <div
        className="term-image"
        data-state={src ? 'loaded' : failed ? 'failed' : 'pending'}
        // The one measurement in this file, and it is the shared constant
        // spelled once — `height.ts` adds exactly this many lines for exactly
        // this box.
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
 * A run of tool calls, as one line.
 *
 * The CLI's own compression, and the reason it works: a tool call is almost
 * never what you came back to read. `Bash(pnpm -w typecheck)` and forty lines of
 * its output say nothing the model's next sentence doesn't say better, and six
 * of them in a row bury that sentence a screen and a half down. So a run
 * collapses to its count and gets out of the way — and opens, in full, the
 * moment it is the thing you actually want.
 *
 * The membership, wording and failure rules live in `tool-run.ts`, shared with
 * the height calculator. A failure never breaks the run — fragmenting it around
 * one would hide the failure in a longer list rather than surface it — but only
 * the run's **last** call colours it, because that is the run's outcome and an
 * outcome is what a collapsed row can honestly claim (see `runFailed`).
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
        {/* No marker once settled: a run of calls is an aside, and a bullet
            would give it the weight of something the model said. While one is
            running the pulse earns the gutter — that much is news. */}
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
      {/* A failed turn's reasons are the whole point of the row — dropping them
          leaves "error_during_execution" and nothing to act on. */}
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
  // The row owns its clock rather than taking `now` from above, because it is
  // mounted only while a turn is in flight: the ticking starts and stops with
  // the thing being timed, and an idle transcript runs no interval at all.
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
