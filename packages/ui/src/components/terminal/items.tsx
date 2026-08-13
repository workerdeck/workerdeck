import { useEffect, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { formatBytes, formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { isMutatingTool } from '../../lib/tool-icon.ts'
import { usePulse } from '../agent/pulse.tsx'
import { CopyAction, WithActions } from './affordances.tsx'
import { TerminalDiff } from './diff.tsx'
import { TerminalMarkdown } from './markdown.tsx'
import { Band, Blank, Ink, Row, type Tone } from './row.tsx'

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
 * | `>`   | what you typed                           |
 * | `●`   | what the model said, or a tool it called |
 * | `⎿`   | that tool's output, one level in         |
 * | `✻`   | thinking                                 |
 * | `!`   | a notice from the runner, not the model  |
 */

/** How much of a tool result the collapsed row is willing to hold. */
const RESULT_PREVIEW_LINES = 4
/** And how much the expanded one shows before offering the rest. */
const RESULT_PREVIEW_CHARS = 2000

export function UserRow({ item }: { item: Extract<TranscriptItem, { kind: 'user' }> }) {
  return (
    <div className='term-user'>
      {item.attachments?.length ? (
        <Row glyph='>' glyphTone='dim' tone='dim'>
          {item.attachments.map((attachment) => attachment.name).join(', ')}
        </Row>
      ) : null}
      {/* Every line of a multi-line prompt keeps the band and the column; only
          the first keeps the marker, exactly as a shell continuation does. */}
      {item.text
        ? item.text.split('\n').map((line, index) => (
            <Row key={index} glyph={index === 0 ? '>' : undefined} glyphTone='dim' tone='fg'>
              {line || ' '}
            </Row>
          ))
        : null}
    </div>
  )
}

export function AssistantRow({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'assistant_text' }>
}) {
  return (
    // Copy the markdown source, not the rendered text: what you paste into an
    // issue or a commit message should keep its lists and its code fences.
    // Absent while streaming — half a message is not a thing anyone wants on
    // their clipboard, and the button would appear mid-sentence.
    <WithActions
      actions={item.streaming ? null : <CopyAction text={item.text} label='Copy message' />}>
      <Row glyph='●' glyphTone='fg' tone='fg'>
        <TerminalMarkdown streaming={item.streaming}>{item.text}</TerminalMarkdown>
      </Row>
    </WithActions>
  )
}

export function ThinkingRow({ item }: { item: Extract<TranscriptItem, { kind: 'thinking' }> }) {
  return (
    <Row glyph='✻' glyphTone='dim' tone='dim'>
      <span className='term-em'>{item.text}</span>
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

export function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const busy = status === 'running' || status === 'pending'
  const isError = status === 'failed' || item.result?.isError === true
  // Ticks only while this row is really running: an idle transcript of a hundred
  // settled calls starts no timers at all.
  const pulse = usePulse(busy)

  const text = item.result?.text ?? ''
  const lines = text.trimEnd().split('\n')
  const preview = open ? lines : lines.slice(0, RESULT_PREVIEW_LINES)
  const hidden = lines.length - preview.length
  const clipped = open && !full && text.length > RESULT_PREVIEW_CHARS

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
    <WithActions
      actions={copyable ? <CopyAction text={copyable} label='Copy' /> : null}>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='term-press'
        aria-expanded={open}>
        <Row glyph={busy ? pulse : '●'} glyphTone={tone} tone='fg'>
          <Ink bold tone='bright'>
            {item.name}
          </Ink>
          <Ink tone='dim'>({toolInputPreview(item.input)})</Ink>
          {item.backend && item.backend !== 'server' ? (
            <Ink tone='faint'> · {item.backend}</Ink>
          ) : null}
        </Row>
      </button>
      {/* A file edit shows its diff, not its result prose: "The file has been
          updated" is what the *model* needed to hear, and the change is what the
          reader did. The text stays reachable by expanding. */}
      {item.patch && !open ? (
        <TerminalDiff patch={item.patch} />
      ) : text ? (
        <>
          {preview.map((line, index) => (
            <Row
              key={index}
              indent={1}
              columns={3}
              glyph={index === 0 ? '⎿' : undefined}
              tone={isError ? 'red' : 'dim'}>
              {line || ' '}
            </Row>
          ))}
          {hidden > 0 ? (
            <Row indent={1} columns={3} tone='faint'>
              … +{hidden} line{hidden === 1 ? '' : 's'}
            </Row>
          ) : null}
          {clipped ? (
            <Row indent={1} columns={3} tone='faint'>
              <button type='button' className='term-press term-link' onClick={() => setFull(true)}>
                show all {text.length.toLocaleString()} chars
              </button>
            </Row>
          ) : null}
        </>
      ) : null}
    </WithActions>
  )
}

export function TurnResultRow({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'turn_result' }>
}) {
  return (
    <div>
      <Row tone={item.isError ? 'red' : 'faint'}>
        {item.isError ? item.subtype : 'done'} · {formatDuration(item.durationMs)} ·{' '}
        {formatCost(item.totalCostUsd)}
      </Row>
      {/* A failed turn's reasons are the whole point of the row — dropping them
          leaves "error_during_execution" and nothing to act on. */}
      {item.errors?.map((message, index) => (
        <Row key={index} tone='red'>
          {message}
        </Row>
      ))}
    </div>
  )
}

export function NoticeRow({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) {
  const error = item.level === 'error'
  return (
    <Row glyph='!' glyphTone={error ? 'red' : 'yellow'} tone={error ? 'red' : 'dim'}>
      {item.text}
    </Row>
  )
}

export function FileRow({
  item,
  href,
}: {
  item: Extract<TranscriptItem, { kind: 'file_delivered' }>
  href?: string
}) {
  return (
    <Row glyph='⤓' glyphTone='blue' tone='dim'>
      {href ? (
        <a className='term-link' data-tone='blue' href={href} download>
          {item.path}
        </a>
      ) : (
        <Ink tone='blue'>{item.path}</Ink>
      )}
      <Ink tone='faint'> · {formatBytes(item.bytes)}</Ink>
      {item.description ? <Ink tone='faint'> · {item.description}</Ink> : null}
    </Row>
  )
}

/** A once-a-second clock, running only while `on`. */
function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
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
export function WorkingRow({
  label,
  startedAt,
  tokens,
}: {
  label: string
  startedAt?: number
  tokens?: number
}) {
  const pulse = usePulse(true)
  // The row owns its clock rather than taking `now` from above, because it is
  // mounted only while a turn is in flight: the ticking starts and stops with
  // the thing being timed, and an idle transcript runs no interval at all.
  const now = useTicker(startedAt !== undefined)
  const elapsed = startedAt === undefined ? undefined : formatDuration(now - startedAt)
  const readings = [elapsed, tokens ? `↓ ${(tokens / 1000).toFixed(1)}k tokens` : undefined].filter(
    Boolean,
  )
  return (
    <Row glyph={pulse} glyphTone='mark' tone='mark'>
      {label}
      {readings.length ? <Ink tone='faint'> ({readings.join(' · ')})</Ink> : null}
    </Row>
  )
}

/** Spacing between two items: a blank line, unless the pair belongs together.
 * Tool output already sits under its call, and a run of tool calls reads as one
 * block — the CLI leaves no blank line inside either. */
export function needsBlank(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (previous.kind === 'tool_call' && next.kind === 'tool_call') return false
  return true
}

export { Band, Blank }
