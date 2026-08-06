import { useEffect, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { ChevronDown, Clock } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { CodeBlock } from '../ui/CodeBlock.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { toolInputPreview } from '../../lib/format.ts'
import { toolIcon } from '../../lib/tool-icon.ts'

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

export function ToolCallCard({ item, hostImage, className }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const [fullResult, setFullResult] = useState(false)
  const imagePath = imagePathOf(item)
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const badge = STATE_BADGE[status]
  const isError = status === 'failed' || item.result?.isError === true
  const Icon = toolIcon(item.name)

  const resultText = item.result?.text ?? ''
  const truncated = !fullResult && resultText.length > RESULT_PREVIEW_CHARS
  const shownResult = truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) : resultText

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
      {/* The picture is the point of the call — shown without expanding, the
          way the tool's own output would be if the engine had sent bytes. */}
      {imagePath && hostImage ? (
        <HostImage path={imagePath} load={hostImage} />
      ) : null}
      {open ? (
        <div className='flex flex-col gap-2 border-t border-border p-2.5'>
          <CodeBlock code={JSON.stringify(item.input, null, 2)} label='Parameters' />
          {item.logs?.length ? (
            <CodeBlock code={item.logs.join('\n')} label='Logs' />
          ) : null}
          {item.result !== undefined ? (
            <div>
              <CodeBlock
                code={shownResult || '(empty result)'}
                label={isError ? 'Error' : 'Result'}
                className={cn(isError && 'border-danger/40 [&_pre]:text-danger')}
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
      ) : null}
    </div>
  )
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
}: {
  path: string
  load: (path: string) => Promise<string | undefined>
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
    <div className='border-t border-border p-2.5'>
      <img
        src={src}
        alt={path.split('/').pop() ?? 'Generated image'}
        className='max-h-96 w-auto max-w-full rounded-md border border-border'
      />
    </div>
  )
}
