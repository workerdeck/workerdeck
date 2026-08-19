import { useEffect, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { ChevronDown, Clock } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { CodeBlock } from '../ui/CodeBlock.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { toolInputPreview } from '../../lib/format.ts'
import { toolIcon } from '../../lib/tool-icon.ts'
import { useToolResultFetcher } from './tool-result-fetch.tsx'
import { useToolResultImageSrc } from './tool-result-image.tsx'
// From the terminal folder, which is where the box's one spelling lives: the
// height calculator is the reason it is a constant at all, and a second copy
// here would be a second thing to keep in step for no gain. Cards has no
// calculator — this frame is about not reflowing a virtualized list when the
// bytes land, which is a claim both themes make.
import { IMAGE_UNAVAILABLE, imagePlaceholder } from '../terminal/image-box.ts'

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
  const [open, setOpen] = useState(false)
  const [fullResult, setFullResult] = useState(false)
  const [fetching, setFetching] = useState(false)
  const fetchResult = useToolResultFetcher()
  const imagePath = imagePathOf(item)
  const status: Status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  const badge = STATE_BADGE[status]
  const isError = status === 'failed' || item.result?.isError === true
  const Icon = toolIcon(item.name)

  const resultText = item.result?.text ?? ''
  const clipped = !fullResult && resultText.length > RESULT_PREVIEW_CHARS
  const shownResult = clipped ? resultText.slice(0, RESULT_PREVIEW_CHARS) : resultText
  // The replay sent a head (see protocol's `ToolResultBlock.truncated`): what is
  // on screen is not merely clipped, it is all this client was given. The press
  // therefore fetches rather than only lifting the clip, and the count has to be
  // the real one — `resultText.length` here is the head's.
  const headOnly = item.result?.truncated === true
  const totalChars = item.result?.totalChars ?? resultText.length

  const details = open ? (
    <div className='flex flex-col gap-2 border-t border-border p-2.5'>
      <PlainPayload
        code={JSON.stringify(item.input, null, 2)}
        language='json'
        label='Parameters'
      />
      {item.logs?.length ? (
        <PlainPayload code={item.logs.join('\n')} label='Logs'/>
      ) : null}
      {item.result !== undefined ? (
        <div>
          <PlainPayload
            code={shownResult || '(empty result)'}
            language={resultLanguage(item)}
            label={isError ? 'Error' : 'Result'}
                className={cn(isError && 'border-danger/40 [&_pre]:text-danger')}
          />
          {fetching ? (
            <p className='mt-1 text-label text-fg-3'>
              Fetching {totalChars.toLocaleString()} chars…
            </p>
          ) : clipped || headOnly ? (
            <button
              type='button'
              className='mt-1 text-label text-fg-3 underline-offset-2 hover:underline'
              onClick={() => {
                setFullResult(true)
                if (!headOnly) return
                setFetching(true)
                void fetchResult(item.id).finally(() => setFetching(false))
              }}>
              Show all {totalChars.toLocaleString()} chars
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null

  // The picture is the point of the call — shown without expanding, the way the
  // tool's own output would be if the engine had sent bytes.
  const image = imagePath && hostImage ? <HostImage path={imagePath} load={hostImage} /> : null

  // Beside the host-path picture above, never instead of it: that one is a file
  // the engine wrote, read back through `/produced` or `/fs`; these are image
  // parts of the result itself, addressed by `(seq, toolUseId, part)`. Different
  // store, different route, and a call can plausibly have both.
  const resultImages = item.result?.images?.length ? (
    <div className='flex flex-col gap-2 border-t border-border p-2.5'>
      {item.result.images.map((ref) => (
        <ResultImage key={ref.partIndex} toolUseId={item.id} image={ref} />
      ))}
    </div>
  ) : null

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
      {resultImages}
      {details}
    </div>
  )
}

/** The framed card the `cards` transcript expands into. Unhighlighted by
 * design: it is structured data in a panel, not a file. */
function PlainPayload({
  code,
  label,
  className,
}: {
  code: string
  label: string
  language?: string
  className?: string
}) {
  return <CodeBlock code={code} label={label} variant='panel' className={className} />
}

/** One image part of a tool result, as the reducer holds it. */
type ToolResultImage = NonNullable<NonNullable<ToolCallItem['result']>['images']>[number]

/**
 * An image part of the result, fetched by reference.
 *
 * The frame is a **fixed height in all three states** — placeholder, picture,
 * failure — which is the one rule this shares with the terminal theme and the
 * only reason it is worth a component: the transcript is virtualized in both,
 * and a box that appears when the bytes land shoves every row below it down
 * while the reader is mid-sentence. Unlike `HostImage`, a failure here is *said*
 * rather than swallowed: there is no host path in the result text to fall back
 * on, so silence would be a blank frame with no account of itself.
 */
function ResultImage({ toolUseId, image }: { toolUseId: string; image: ToolResultImage }) {
  const { src, failed } = useToolResultImageSrc({ toolUseId, ...image })
  return (
    <div className='flex h-60 items-start overflow-hidden rounded-md border border-border bg-surface-hover'>
      {src ? (
        <img src={src} alt={imagePlaceholder(image)} className='h-full max-w-full object-contain' />
      ) : (
        <span className='p-2 text-label text-fg-4'>
          {failed ? IMAGE_UNAVAILABLE : imagePlaceholder(image)}
        </span>
      )}
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
