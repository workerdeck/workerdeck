import { useEffect, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { ChevronDown, Clock } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { CodeBlock } from '../ui/CodeBlock.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { toolInputPreview } from '../../lib/format.ts'
import { isMutatingTool, toolIcon } from '../../lib/tool-icon.ts'
import { LINE_INDENT, LinePayload } from './line-prompt.tsx'
import { usePulse } from './pulse.tsx'
import { LineGlyph, useLines } from './transcript-variant.tsx'

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

const RESULT_PREVIEW_CHARS = 2000

/** Codex's built-in image tools name a host path rather than sending bytes —
 * an event log carries references, never base64. Rendering the picture means
 * reading that path back through the gateway's host-file route. */
const IMAGE_TOOLS = new Set(['CodexImageGeneration', 'CodexImageView'])

const imagePathOf = (item: ToolCallItem): string | undefined => {
  if (!IMAGE_TOOLS.has(item.name)) return undefined
  const input = item.input as { savedPath?: unknown; path?: unknown } | null
  const path = input?.savedPath ?? input?.path
  return typeof path === 'string' ? path : undefined
}

export interface ToolCallCardProps {
  item: ToolCallItem
  /**
   * Reads a host file as a data URL, for tools whose output is a picture on the
   * host. Resolves `undefined` when the gateway won't serve that path — a
   * generated image saved outside the allowed roots (codex's default
   * `$CODEX_HOME/generated_images/`) is one, and the card then names the path
   * instead of showing it.
   */
  hostImage?: (path: string) => Promise<string | undefined>
  className?: string
}

/** Badge per execution state. `pending`/`deferred` mean the work is happening
 * somewhere else (this tab's sandbox, a queue) — distinct from the model still
 * running the call itself. */
const STATE_BADGE = {
  running: { label: 'Running', variant: 'info', busy: true },
  pending: { label: 'Executing', variant: 'info', busy: true },
  deferred: { label: 'Deferred', variant: 'accent', busy: false },
  settled: { label: 'Done', variant: 'success', busy: false },
  failed: { label: 'Error', variant: 'danger', busy: false },
} as const

/** The gutter dot's colour in `lines`: the state, said without a badge. */
const STATE_GLYPH = {
  running: 'text-info',
  pending: 'text-info',
  deferred: 'text-accent',
  settled: 'text-fg-4',
  failed: 'text-danger',
} as const

/**
 * The language to highlight a payload as.
 *
 * Parameters are always JSON. A result is whatever file the call was about — so
 * the extension in `file_path`/`path` is the best evidence there is, and a call
 * that names no file gets no guess (plain text renders fine and a wrong grammar
 * is worse than none).
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json', md: 'md', mdx: 'md', css: 'css', scss: 'scss',
  html: 'html', xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', sql: 'sql',
  graphql: 'graphql', dockerfile: 'dockerfile', diff: 'diff', patch: 'diff',
}

function resultLanguage(item: ToolCallItem): string | undefined {
  if (item.name === 'Bash' || item.name === 'CodexCommand') return 'bash'
  if (item.name === 'CodexFileChange') return 'diff'
  const input = item.input as { file_path?: unknown; path?: unknown } | null
  const path = input?.file_path ?? input?.path
  if (typeof path !== 'string') return undefined
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return EXTENSION_LANGUAGE[extension]
}

type Status = keyof typeof STATE_BADGE

export function ToolCallCard({ item, hostImage, className }: ToolCallCardProps) {
  const lines = useLines()
  const [open, setOpen] = useState(false)
  const [fullResult, setFullResult] = useState(false)
  const imagePath = imagePathOf(item)
  const status: Status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const badge = STATE_BADGE[status]
  const isError = status === 'failed' || item.result?.isError === true
  // Ticks only while this row is actually running, and only in the variant with a
  // gutter to pulse in — an idle transcript of a hundred settled tools starts no
  // timers at all.
  const pulse = usePulse(lines && badge.busy)
  const Icon = toolIcon(item.name)

  const resultText = item.result?.text ?? ''
  const truncated = !fullResult && resultText.length > RESULT_PREVIEW_CHARS
  const shownResult = truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) : resultText

  // In `lines` the payloads are dim label + highlighted band, not framed cards:
  // a tool call is already one row, and boxing what it expands into puts back
  // the chrome the variant exists to remove.
  const blockVariant = lines ? 'plain' : 'panel'
  const Payload = lines ? HighlightedPayload : PlainPayload
  const details = open ? (
    <div className={cn('flex flex-col', lines ? 'gap-1 py-1' : 'gap-2 border-t border-border p-2.5')}>
      <Payload
        code={JSON.stringify(item.input, null, 2)}
        language='json'
        label='Parameters'
        variant={blockVariant}
      />
      {item.logs?.length ? (
        <Payload code={item.logs.join('\n')} label='Logs' variant={blockVariant} />
      ) : null}
      {item.result !== undefined ? (
        <div>
          <Payload
            code={shownResult || '(empty result)'}
            language={resultLanguage(item)}
            label={isError ? 'Error' : 'Result'}
            variant={blockVariant}
            className={cn(isError && (lines ? '[&_pre]:text-danger' : 'border-danger/40 [&_pre]:text-danger'))}
          />
          {truncated ? (
            <button
              type='button'
              className='mt-1 text-label text-fg-3 underline-offset-2 hover:underline'
              onClick={() => setFullResult(true)}>
              Show all {resultText.length.toLocaleString()} chars
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null

  // The picture is the point of the call — shown without expanding, the way the
  // tool's own output would be if the engine had sent bytes.
  const image = imagePath && hostImage ? <HostImage path={imagePath} load={hostImage} lines={lines} /> : null

  if (lines) {
    return (
      <div data-slot='tool-call' data-state={status} className={cn('w-full', className)}>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          className='flex w-full items-baseline gap-2 text-left outline-none'>
          <LineGlyph
            className={
              // A settled write is green: skimming a run, "what did it change"
              // is the question you come back to, and it is the one you might
              // need to undo. Every other state keeps its own colour — a failed
              // write is a failure first.
              status === 'settled' && !isError && isMutatingTool(item.name)
                ? 'text-success'
                : STATE_GLYPH[status]
            }>
            {/* Running: the mark's own pulse, so a working tool row and the
                transcript's working line beat together. Settled: a plain dot,
                which reads as "done" precisely by not moving. */}
            {badge.busy ? pulse : '●'}
          </LineGlyph>
          <span className='min-w-0 flex-1 truncate text-body-sm leading-5 text-fg-3'>
            <span className='font-medium text-fg-1'>{item.name}</span>
            <span className='text-fg-4'>({toolInputPreview(item.input)})</span>
          </span>
          {item.backend && item.backend !== 'server' ? (
            <span className='shrink-0 text-label text-fg-4'>{item.backend}</span>
          ) : null}
          {/* No Spinner here: the gutter glyph animates now, and two spinners on
              one row is one too many. `cards` keeps its own — it has no gutter. */}
          {status === 'deferred' ? <Clock className='size-3 shrink-0 self-center text-fg-4' /> : null}
          {isError && !badge.busy ? (
            <span className='shrink-0 text-label text-danger'>error</span>
          ) : null}
        </button>
        {/* Collapsed, the first line of the output is the whole story most of
            the time — a summary line costs one row and saves an expand. */}
        {!open && resultText ? (
          <div className='flex items-baseline gap-2'>
            <LineGlyph className='text-fg-4'>⎿</LineGlyph>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-label leading-5',
                isError ? 'text-danger' : 'text-fg-4',
              )}>
              {resultSummary(resultText)}
            </span>
          </div>
        ) : null}
        {image}
        {details ? <div className={LINE_INDENT}>{details}</div> : null}
      </div>
    )
  }

  return (
    <div
      data-slot='tool-call'
      data-state={status}
      className={cn('w-full overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors outline-none',
          'hover:bg-surface-hover focus-visible:bg-surface-hover',
        )}>
        <Icon className='size-3.5 shrink-0 text-fg-3' />
        <span className='shrink-0 font-mono text-body-sm font-medium text-fg-1'>{item.name}</span>
        {item.backend && item.backend !== 'server' ? (
          <Badge variant='neutral' className='shrink-0'>
            {item.backend}
          </Badge>
        ) : null}
        <span className='min-w-0 flex-1 truncate font-mono text-label text-fg-4'>
          {toolInputPreview(item.input)}
        </span>
        <Badge variant={badge.variant} dot={!badge.busy} className='shrink-0 gap-1'>
          {badge.busy ? <Spinner className='size-3 text-current' /> : null}
          {status === 'deferred' ? <Clock className='size-3 text-current' /> : null}
          {badge.label}
        </Badge>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', open && 'rotate-180')}
        />
      </button>
      {image}
      {details}
    </div>
  )
}

/** The first line worth showing of a tool result, for the collapsed summary. */
function resultSummary(text: string): string {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? ''
  const rest = text.trimEnd().split('\n').length - 1
  const trimmed = first.trim()
  return rest > 0 ? `${trimmed} (+${rest} lines)` : trimmed
}

type PayloadProps = {
  code: string
  label: string
  language?: string
  variant: 'panel' | 'plain'
  className?: string
}

/** The framed card, for the `cards` transcript. Unhighlighted by design: it is
 * structured data in a panel, not a file. */
function PlainPayload({ code, label, variant, className }: PayloadProps) {
  return <CodeBlock code={code} label={label} variant={variant} className={className} />
}

/** The terminal payload — shared with the line-shaped prompts. */
function HighlightedPayload({ code, label, language, className }: PayloadProps) {
  return <LinePayload code={code} label={label} language={language} className={className} />
}

/**
 * A picture that lives on the host, fetched through the gateway's host-file
 * route and shown inline.
 *
 * Silent on failure by design: a path outside the server's allowed roots is the
 * *expected* case for codex's default save location, and the card's result text
 * already names where the file went. An error banner over that would be noise
 * about a thing the operator can fix in one line of config.
 */
function HostImage({
  path,
  load,
  lines,
}: {
  path: string
  load: (path: string) => Promise<string | undefined>
  lines?: boolean
}) {
  const [src, setSrc] = useState<string | undefined>()
  useEffect(() => {
    let cancelled = false
    setSrc(undefined)
    load(path)
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        // Not readable from here — the path in the result is the answer.
      })
    return () => {
      cancelled = true
    }
  }, [path, load])
  if (!src) return null
  return (
    <div className={cn(lines ? cn('py-1', LINE_INDENT) : 'border-t border-border p-2.5')}>
      <img
        src={src}
        alt={path.split('/').pop() ?? 'Generated image'}
        className='max-h-96 w-auto max-w-full rounded-md border border-border'
      />
    </div>
  )
}
