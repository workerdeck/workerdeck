import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { SlashCommandInfo } from '@workerdeck/protocol'
import type { StagedAttachment, UseAttachmentsResult } from '@workerdeck/react'
import { ArrowUp, FileText, Paperclip, RotateCw, Square, TriangleAlert, X } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { PromptArea } from '../prompt-area/prompt-area.tsx'
import { usePromptAreaState } from '../prompt-area/use-prompt-area-state.ts'
import { commandTrigger, mentionTrigger } from '../prompt-area/trigger-presets.ts'
import type { TriggerSuggestion } from '../prompt-area/types.ts'
import { cn } from '../../lib/utils.ts'
import { formatBytes } from '../../lib/format.ts'

/** Files matching an `@` query, for the composer's file trigger. Structural so
 * the ui package doesn't have to reach for the protocol's `HostFileMatch`. */
export type ComposerFileMatch = { path: string; relative: string }

export interface ComposerProps {
  /** `attachmentIds` are the staged uploads, in the order they were picked. */
  onSend: (text: string, attachmentIds: string[]) => void
  onInterrupt: () => void
  busy: boolean
  /** Disable input entirely (session failed/closed). */
  disabled?: boolean
  placeholder?: string
  /** Slash commands offered as autocomplete; picked ones render as chips. */
  commands?: SlashCommandInfo[]
  /** Host-file search behind the `@` trigger. Omit to leave `@` inert — a
   * gateway without host files has nothing to complete. */
  onSearchFiles?: (query: string, options: { signal: AbortSignal }) => Promise<ComposerFileMatch[]>
  /** Attachment staging (see `useAttachments`). Omit for a text-only composer. */
  attachments?: UseAttachmentsResult
  /** Left side of the toolbar row (mode selects, …). */
  toolbar?: ReactNode
  className?: string
}

/** CLI names may carry display annotations (e.g. "foo (MCP)") the parser rejects. */
const cleanName = (name: string) => name.replace(/\s*\(MCP\)$/i, '')

/**
 * Framed prompt input built on prompt-area's contentEditable.
 *
 * Two completions ride the same field and behave nothing alike: `/` is the CLI's
 * command list, which arrives with `capabilities` and so filters locally and
 * completely; `@` is a search against the host filesystem, debounced and
 * abortable so a fast typist makes one request rather than eight. Both resolve
 * into inline chips.
 *
 * Files can arrive three ways — the paperclip, a drop, or a paste — because on a
 * desktop all three are things people already do, and the upload starts the
 * moment one lands rather than at send time.
 */
export function Composer({
  onSend,
  onInterrupt,
  busy,
  disabled,
  placeholder = 'Message the agent…',
  commands,
  onSearchFiles,
  attachments,
  toolbar,
  className,
}: ComposerProps) {
  const { bind, plainText, isEmpty, clear, focus } = usePromptAreaState()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const triggers = useMemo(() => {
    const configured = []
    if (commands && commands.length > 0) {
      // The CLI list can contain the same skill name from several sources — first wins.
      const seen = new Set<string>()
      const unique = commands.flatMap((c) => {
        const name = cleanName(c.name)
        if (seen.has(name)) return []
        seen.add(name)
        return [{ ...c, name }]
      })
      configured.push(
        commandTrigger({
          onSearch: (query: string): TriggerSuggestion[] => {
            const needle = query.toLowerCase()
            const scored = unique.flatMap((c) => {
              // "wrapup" should find "dev:wrapup" — the bare half of a
              // namespaced name is what people type.
              const haystacks = [c.name, ...(c.aliases ?? []), ...c.name.split(':')].map((s) =>
                s.toLowerCase(),
              )
              const score = haystacks.some((h) => h.startsWith(needle))
                ? 2
                : haystacks.some((h) => h.includes(needle))
                  ? 1
                  : 0
              return score === 0 ? [] : [{ c, score }]
            })
            scored.sort((a, b) => b.score - a.score)
            return scored.map(({ c }) => ({
              value: c.name,
              label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
              description: c.description,
            }))
          },
          // Chip text renders as trigger + displayText — return the bare name so
          // the chip reads "/name" (label carries the argument hint for the menu).
          onSelect: (suggestion) => suggestion.value,
          chipClassName: 'font-mono',
        }),
      )
    }
    if (onSearchFiles) {
      configured.push(
        mentionTrigger({
          // A round trip per keystroke would be eight requests for one word; the
          // route is cheap but not free.
          searchDebounceMs: 150,
          onSearch: async (query, options) => {
            const matches = await onSearchFiles(query, options)
            return matches.map((match) => ({
              value: match.relative,
              label: match.relative,
              description: match.path,
            }))
          },
          onSelect: (suggestion) => suggestion.value,
          chipStyle: 'inline',
          chipClassName: 'font-mono',
          emptyMessage: 'No matching files',
        }),
      )
    }
    return configured.length > 0 ? configured : undefined
  }, [commands, onSearchFiles])

  const staged = attachments?.items ?? []
  // A photo on its own is a message — send doesn't wait for text. It does wait
  // for the upload, since an id that hasn't landed can't be named.
  const canSend =
    !disabled &&
    (!isEmpty || staged.length > 0) &&
    !attachments?.uploading &&
    !attachments?.hasFailure

  const submit = () => {
    if (!canSend) return
    onSend(plainText.trim(), attachments?.readyIds ?? [])
    attachments?.clear()
    clear()
    focus()
  }

  const pick = (files: FileList | null) => {
    if (files && files.length > 0) attachments?.add(files)
  }

  return (
    <div data-slot='composer' className={cn('px-3 pb-3', className)}>
      <div
        onDragOver={(e) => {
          if (attachments && !attachments.disabled) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!attachments || attachments.disabled) return
          e.preventDefault()
          setDragging(false)
          pick(e.dataTransfer.files)
        }}
        className={cn(
          'mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-xs)',
          'transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          dragging && 'border-ring ring-2 ring-ring/30',
          disabled && 'opacity-60',
        )}>
        {/* Above the field, like the picture you are talking about should be. */}
        {staged.length > 0 && attachments ? (
          <AttachmentStrip attachments={attachments} />
        ) : null}
        <PromptArea
          {...bind}
          triggers={triggers}
          onSubmit={submit}
          disabled={disabled}
          placeholder={disabled ? 'Session ended' : placeholder}
          minHeight={28}
          maxHeight={192}
          aria-label='Message the agent'
          className='px-3 pt-2.5 pb-1 text-body-sm text-text'
          onImagePaste={(file) => attachments?.add([file])}
        />
        <div className='flex items-center justify-between gap-2 px-2 pb-2'>
          <div className='flex min-w-0 items-center gap-1'>
            {/* An attach affordance the engine has no meaning for is not a
                choice — the capability record decides whether it exists. */}
            {attachments && !attachments.disabled ? (
              <>
                <input
                  ref={fileInput}
                  type='file'
                  multiple
                  accept={attachments.accept || undefined}
                  className='hidden'
                  onChange={(e) => {
                    pick(e.target.files)
                    // Re-picking the same file must fire `change` again.
                    e.target.value = ''
                  }}
                />
                <Button
                  variant='ghost'
                  size='icon-sm'
                  aria-label='Attach files'
                  disabled={disabled}
                  onClick={() => fileInput.current?.click()}>
                  <Paperclip className='size-4' />
                </Button>
              </>
            ) : null}
            {toolbar}
          </div>
          {busy && !canSend ? (
            <Button
              variant='outline'
              size='icon-sm'
              aria-label='Interrupt'
              className='rounded-full'
              onClick={onInterrupt}>
              <Square className='size-3' />
            </Button>
          ) : (
            <Button
              size='icon-sm'
              aria-label='Send'
              className='rounded-full'
              disabled={!canSend}
              onClick={submit}>
              <ArrowUp className='size-4' />
            </Button>
          )}
        </div>
      </div>
      {attachments?.error ? (
        <div className='mx-auto mt-1 flex w-full max-w-3xl items-center gap-2 text-label text-danger'>
          <TriangleAlert className='size-3 shrink-0' />
          <span className='min-w-0 flex-1'>{attachments.error}</span>
          <button
            type='button'
            onClick={attachments.dismissError}
            aria-label='Dismiss'
            className='shrink-0 opacity-70 hover:opacity-100'>
            <X className='size-3' />
          </button>
        </div>
      ) : (
        <div className='mx-auto mt-1 w-full max-w-3xl text-center text-label text-fg-4'>
          Enter to send · Shift+Enter for a new line
        </div>
      )}
    </div>
  )
}

/** Staged files as a scrolling row of chips above the field. The thumbnail is
 * the local blob, so nothing here waits on the network; the upload's state rides
 * on top of it and the ✕ takes it back off. */
function AttachmentStrip({ attachments }: { attachments: UseAttachmentsResult }) {
  return (
    <div className='flex gap-2 overflow-x-auto border-b border-border px-2 py-2'>
      {attachments.items.map((item) => (
        <AttachmentChip
          key={item.key}
          item={item}
          onRetry={() => attachments.retry(item.key)}
          onRemove={() => attachments.remove(item.key)}
        />
      ))}
    </div>
  )
}

function AttachmentChip({
  item,
  onRetry,
  onRemove,
}: {
  item: StagedAttachment
  onRetry: () => void
  onRemove: () => void
}) {
  const failed = item.status === 'failed'
  return (
    <div
      className='group relative shrink-0'
      title={failed ? `${item.name} — ${item.error}` : `${item.name} · ${formatBytes(item.bytes)}`}>
      <div
        className={cn(
          'flex size-14 items-center justify-center overflow-hidden rounded-md border border-border bg-surface',
          failed && 'border-danger/50',
        )}>
        {item.previewUrl ? (
          <img src={item.previewUrl} alt={item.name} className='size-full object-cover' />
        ) : (
          <div className='flex flex-col items-center gap-0.5 text-fg-3'>
            <FileText className='size-4' />
            <span className='max-w-12 truncate text-[9px] font-semibold uppercase'>
              {extensionOf(item.name)}
            </span>
          </div>
        )}
      </div>
      {item.status === 'uploading' ? (
        <div className='absolute inset-0 flex items-center justify-center rounded-md bg-black/35'>
          <Spinner className='size-4 text-white' />
        </div>
      ) : null}
      {failed ? (
        <button
          type='button'
          onClick={onRetry}
          aria-label={`Retry ${item.name}`}
          className='absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-warning'>
          <RotateCw className='size-4' />
        </button>
      ) : null}
      <button
        type='button'
        onClick={onRemove}
        aria-label={`Remove ${item.name}`}
        className='absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border border-border bg-surface text-fg-3 shadow-(--shadow-xs) hover:text-fg-1'>
        <X className='size-2.5' />
      </button>
    </div>
  )
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}
