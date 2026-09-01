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

export const PROMPT_GLYPH = '❯'

export const RESULT_PREVIEW_CHARS = 2000

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
  const [fetching, setFetching] = useState(false)
  const fetchResult = useToolResultFetcher()
  const reveal = useRevealOnOpen(open)
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const busy = status === 'running' || status === 'pending'
  const isError = status === 'failed' || item.result?.isError === true
  const pulse = usePulse(busy)

  const text = item.result?.text ?? ''
  const lines = text.trimEnd().split('\n')
  const collapsed = collapsedResult(lines, item.result?.totalChars)
  const preview = open ? (full ? lines : clipToChars(lines, RESULT_PREVIEW_CHARS)) : collapsed.shown
  const hidden = lines.length - preview.length
  const clipped = open && !full && hidden > 0
  const truncated = item.result?.truncated === true
  const missing = truncated ? (item.result?.totalChars ?? 0) - text.length : 0

  const tone: Tone = isError ? 'red' : status === 'settled' && isMutatingTool(item.name) ? 'green' : (TOOL_TONE[status] ?? 'dim')

  const command = (item.input as { command?: unknown } | null)?.command
  const copyable = typeof command === 'string' ? command : text

  return (
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
        {item.result?.images?.map((image) => (
          <TerminalImage key={image.partIndex} toolUseId={item.id} image={image} />
        ))}
        {item.patch && !open ? (
          <TerminalDiff patch={item.patch} />
        ) : text ? (
          <>
            {preview.map((line, index) => (
              <Row key={index} indent={1} columns={3} glyph={index === 0 ? '⎿' : undefined} tone={isError ? 'red' : 'dim'}>
                {line || ' '}
              </Row>
            ))}
            {!open ? (
              collapsed.more ? (
                <Row indent={1} columns={3} tone="faint">
                  {collapsed.more}
                </Row>
              ) : null
            ) : clipped || truncated ? (
              <Row indent={1} columns={3} tone="faint">
                {fetching ? (
                  <>… fetching {(item.result?.totalChars ?? 0).toLocaleString()} chars</>
                ) : clipped || truncated ? (
                  <button
                    type="button"
                    className="term-press term-link"
                    onClick={() => {
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

type ToolResultImage = NonNullable<NonNullable<ToolCallItem['result']>['images']>[number]

function TerminalImage({ toolUseId, image }: { toolUseId: string; image: ToolResultImage }) {
  const { src, failed } = useToolResultImageSrc({ toolUseId, ...image })
  return (
    <Row indent={1} columns={3}>
      <div
        className="term-image"
        data-state={src ? 'loaded' : failed ? 'failed' : 'pending'}
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

export function WorkingRow({ label, startedAt, tokens }: { label: string; startedAt?: number; tokens?: number }) {
  const pulse = usePulse(true)
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
