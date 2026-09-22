import { useEffect, useState, type ReactNode } from 'react'
import type { MessageOrigin } from '@workerdeck/protocol'
import type { ShellItem, TranscriptItem } from '@workerdeck/react'
import { compactionText, formatBytes, formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { isMutatingTool } from '../../lib/tool-icon.ts'
import { usePulse } from '../agent/pulse.tsx'
import { PromptTokenText } from '../agent/PromptTokenText.tsx'
import { BookmarkAction, CopyAction, WithActions } from './affordances.tsx'
import { TerminalDiff } from './diff.tsx'
import { TerminalMarkdown } from './markdown.tsx'
import { usePeerNames } from './peer-names.tsx'
import { Pressable, useRevealOnOpen } from './press.tsx'
import { IMAGE_BOX_LINES, IMAGE_UNAVAILABLE, imagePlaceholder } from './image-box.ts'
import { collapsedResult } from './result-preview.ts'
import { useToolResultFetcher } from '../agent/tool-result-fetch.tsx'
import { useToolTitle } from '../agent/tool-titles.tsx'
import { useToolResultImageSrc } from '../agent/tool-result-image.tsx'
import { isPeerSend, peerName, peerOneLine, peerSendTarget, peerSendText, planRun, runFailed, runSummary } from './tool-run.ts'
import { todoLine, todoPreview, type TodoPreview, type TodoStatus } from './todos.ts'
import { useShellActions } from '../agent/shell-actions.tsx'
import { SHELL_GLYPH, SHELL_KILL_GLYPH, shellBodyLines, shellFailed, shellFooterText, shellLabel, shellStatusText } from './shell-row.ts'
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

export function peerLabel(origin: MessageOrigin): string {
  const who = origin.name ? `${origin.name} (${origin.sessionId.slice(0, 8)})` : origin.sessionId.slice(0, 8)
  return `message from ${origin.engine ? `${origin.engine} session ` : 'session '}${who}`
}

export const PEER_IN_GLYPH = '↦'
export const PEER_OUT_GLYPH = '↤'

// The row peer traffic draws on, both directions. Never folded into a tool run and never summarised
// away: one agent talking to another is the transcript's headline, not its evidence.
function PeerRow({ glyph, who, body, tone = 'peer', clip }: { glyph: string; who: string; body: ReactNode; tone?: Tone; clip?: boolean }) {
  const line = (
    <>
      <Ink tone={tone} bold>
        {who}
      </Ink>
      {': '}
      {body}
    </>
  )
  return (
    <Row glyph={glyph} glyphTone={tone} tone={tone}>
      {clip ? <span className="term-clip-1">{line}</span> : line}
    </Row>
  )
}

export function PeerSendRow({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(false)
  const names = usePeerNames()
  const reveal = useRevealOnOpen(open)
  const lines = peerSendText(item).split('\n')
  const failed = item.status === 'failed' || item.result?.isError === true
  const tone: Tone = failed ? 'red' : 'peer'

  return (
    <WithActions actions={<BookmarkAction id={item.id} />}>
      <div ref={reveal} className={open ? 'term-open' : undefined}>
        <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
          <PeerRow
            glyph={PEER_OUT_GLYPH}
            who={peerSendTarget(item, names)}
            tone={tone}
            clip={!open}
            body={open ? lines[0] || ' ' : peerOneLine(lines.join(' '))}
          />
        </Pressable>
        {open ? (
          <div>
            {lines.slice(1).map((line, index) => (
              <Row key={index} tone={tone}>
                {line || ' '}
              </Row>
            ))}
            {item.result ? <Row tone="faint">{peerOneLine(item.result.text)}</Row> : null}
          </div>
        ) : null}
      </div>
    </WithActions>
  )
}

export function UserRow({ item }: { item: Extract<TranscriptItem, { kind: 'user' }> }) {
  return (
    <WithActions actions={<BookmarkAction id={item.id} />}>
      <div className="term-user" data-peer={item.origin ? '' : undefined}>
        {item.attachments?.length ? (
          <Row glyph={PROMPT_GLYPH} glyphTone="dim" tone="dim">
            {item.attachments.map((attachment) => attachment.name).join(', ')}
          </Row>
        ) : null}
        {item.text
          ? item.text.split('\n').map((line, index) =>
              item.origin && index === 0 ? (
                <PeerRow
                  key={index}
                  glyph={PEER_IN_GLYPH}
                  who={peerName(item.origin)}
                  body={line ? <PromptTokenText text={line} /> : ' '}
                />
              ) : (
                <Row
                  key={index}
                  glyph={!item.origin && index === 0 ? PROMPT_GLYPH : undefined}
                  glyphTone="dim"
                  tone={item.origin ? 'peer' : 'fg'}
                >
                  {line ? <PromptTokenText text={line} /> : ' '}
                </Row>
              ),
            )
          : null}
      </div>
    </WithActions>
  )
}

export function AssistantRow({ item }: { item: Extract<TranscriptItem, { kind: 'assistant_text' }> }) {
  return (
    <WithActions
      actions={
        <>
          <BookmarkAction id={item.id} />
          {item.streaming ? null : <CopyAction text={item.text} label="Copy message" />}
        </>
      }
    >
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
  const todos = todoPreview(item.name, item.input)
  const title = useToolTitle(item.name)

  return (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <WithActions
        actions={
          <>
            <BookmarkAction id={item.id} />
            {copyable ? <CopyAction text={copyable} label="Copy" /> : null}
          </>
        }
      >
        <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
          <Row glyph={busy ? pulse : '●'} glyphTone={tone} tone="fg" title={title ? item.name : undefined}>
            <Ink bold tone="bright" className={busy ? 'term-shimmer' : undefined}>
              {title ?? item.name}
            </Ink>
            <Ink tone="dim">({todos ? todos.summary : toolInputPreview(item.input)})</Ink>
            {title && open ? <Ink tone="faint"> · {item.name}</Ink> : null}
            {item.backend && item.backend !== 'server' ? <Ink tone="faint"> · {item.backend}</Ink> : null}
          </Row>
        </Pressable>
        {item.result?.images?.map((image) => (
          <TerminalImage key={image.partIndex} toolUseId={item.id} image={image} />
        ))}
        {item.patch && !open ? (
          <TerminalDiff patch={item.patch} />
        ) : todos && !open ? (
          <TerminalTodos preview={todos} />
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
                      ? `… +${missing.toLocaleString()} chars - fetch the rest`
                      : `… +${hidden} line${hidden === 1 ? '' : 's'} - show all ${text.length.toLocaleString()} chars`}
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

const TODO_TONE: Record<TodoStatus, Tone> = {
  pending: 'dim',
  in_progress: 'blue',
  completed: 'faint',
}

function TerminalTodos({ preview }: { preview: TodoPreview }) {
  return (
    <>
      {preview.shown.map((todo, index) => (
        <Row key={index} indent={1} columns={3} glyph={index === 0 ? '⎿' : undefined} tone={TODO_TONE[todo.status]}>
          {todoLine(todo)}
        </Row>
      ))}
      {preview.more ? (
        <Row indent={1} columns={3} tone="faint">
          {preview.more}
        </Row>
      ) : null}
    </>
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
          {busy ? <span className="term-shimmer">{runSummary(items, busy)}</span> : runSummary(items, busy)}
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

export function RunRow({ items }: { items: ToolCallItem[] }) {
  const plan = planRun(items)
  if (plan.kind === 'summary') {
    return <ToolRunRow items={plan.items} />
  }
  return isPeerSend(plan.item) ? <PeerSendRow item={plan.item} /> : <ToolRow item={plan.item} />
}

export function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  return (
    <div>
      <Row tone={item.isError ? 'red' : 'faint'}>
        {item.isError ? item.subtype : 'done'} · {formatDuration(item.durationMs)} · {formatCost(item.costUsd ?? item.totalCostUsd)}
      </Row>
      {item.errors?.map((message, index) => (
        <Row key={index} tone="red">
          {message}
        </Row>
      ))}
    </div>
  )
}

export function CompactionRow({ item }: { item: Extract<TranscriptItem, { kind: 'compaction' }> }) {
  const failed = item.error !== undefined
  return (
    <Row glyph={item.pending ? '⋯' : '≡'} glyphTone={failed ? 'red' : 'yellow'} tone={failed ? 'red' : 'faint'}>
      {compactionText(item)}
    </Row>
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

export function ShellRow({ item }: { item: ShellItem }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const actions = useShellActions()
  const reveal = useRevealOnOpen(open)
  const running = item.shell.status === 'running'
  const failed = shellFailed(item)
  const tone: Tone = failed ? 'red' : running ? 'magenta' : 'dim'
  const lines = shellBodyLines(item, open)
  const footer = shellFooterText(item, open, lines.length)

  const shellId = item.shell.id
  const verify = actions.verify
  useEffect(() => {
    if (running) {
      void verify(shellId)
    }
  }, [running, shellId, verify])

  const press = () => {
    const next = !open
    setOpen(next)
    if (!next || !item.truncated || item.expanded !== undefined || item.missing) {
      return
    }
    setBusy(true)
    void actions.loadOutput(shellId).finally(() => setBusy(false))
  }

  return (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <WithActions
        actions={
          <>
            <BookmarkAction id={item.id} />
            <CopyAction text={item.shell.command} label="Copy command" />
          </>
        }
      >
        <Pressable onPress={press} expanded={open}>
          <Row glyph={SHELL_GLYPH} glyphTone={tone} tone="fg">
            <Ink bold tone="bright">
              {shellLabel(item)}
            </Ink>
            <Ink tone={failed ? 'red' : 'faint'}>
              {' · '}
              {shellStatusText(item)}
            </Ink>
            {running ? (
              <button
                type="button"
                aria-label="Kill this shell"
                title="Kill this shell"
                className="term-press term-link"
                data-tone="red"
                onClick={(event) => {
                  event.stopPropagation()
                  void actions.kill(shellId)
                }}
              >
                {' '}
                {SHELL_KILL_GLYPH}
              </button>
            ) : null}
          </Row>
        </Pressable>
        {lines.map((line, index) => (
          <Row key={index} indent={1} columns={3} glyph={index === 0 ? '⎿' : undefined} tone={failed ? 'red' : 'dim'}>
            {line || ' '}
          </Row>
        ))}
        {footer || busy ? (
          <Row indent={1} columns={3} tone="faint">
            {busy ? '… fetching the full output' : footer}
          </Row>
        ) : null}
      </WithActions>
    </div>
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
      <span className="term-shimmer">{label}</span>
      {readings.length ? <Ink tone="faint"> ({readings.join(' · ')})</Ink> : null}
    </Row>
  )
}

export { Band, Blank }
