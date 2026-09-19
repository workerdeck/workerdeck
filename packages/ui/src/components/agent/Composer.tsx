import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import type { SkillInfo, SlashCommandInfo } from '@workerdeck/protocol'
import type { StagedAttachment, UseAttachmentsResult } from '@workerdeck/react'
import { ArrowUp, FileText, Paperclip, RotateCw, SlidersHorizontal, Sparkles, Square, TriangleAlert, X } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { PromptArea } from '../prompt-area/prompt-area.tsx'
import { usePromptAreaState } from '../prompt-area/use-prompt-area-state.ts'
import { plainTextToSegments } from '../prompt-area/prompt-area-engine.ts'
import { commandTrigger, launchTrigger, mentionTrigger } from '../prompt-area/trigger-presets.ts'
import { mergeComposerRows, rankComposerRows, skillPrompt, type ClientCommand } from './composer-commands.ts'
import { useTranscriptVariant } from './transcript-variant.tsx'
import type { TerminalAffordances } from '../terminal/affordances.tsx'
import { PROMPT_GLYPH } from '../terminal/items.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import type { TriggerSuggestion } from '../prompt-area/types.ts'
import { cn } from '../../lib/utils.ts'
import { formatBytes } from '../../lib/format.ts'

export type ComposerFileMatch = { path: string; relative: string }

const SHELL_PLACEHOLDER = 'Run a command on the host…'
const SHELL_HINT = '! shell mode · esc to exit'

export type ComposerHandle = {
  insertText: (text: string) => void
  focus: () => void
}

export interface ComposerProps {
  onSend: (text: string, attachmentIds: string[]) => void
  onInterrupt: () => void
  busy: boolean
  disabled?: boolean
  placeholder?: string
  commands?: SlashCommandInfo[]
  skills?: SkillInfo[]
  // Session controls the host offers as `/` rows. Merged into the same ranked list as the engine's own
  // commands, and suppressed name-for-name by an engine command so the real one always wins.
  clientCommands?: ClientCommand[]
  onSearchFiles?: (query: string, options: { signal: AbortSignal }) => Promise<ComposerFileMatch[]>
  // Shell mode: `!` as the first character turns the composer into a host shell prompt. Omit to leave the
  // mode off entirely - the gateway only offers it to an operator on a session whose engine reaches a host cwd.
  onShellCommand?: (command: string) => void
  attachments?: UseAttachmentsResult
  toolbar?: ReactNode
  layout?: 'stacked' | 'inline'
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  // Where unsent text is remembered between mounts. The composer is remounted on every session switch, so without
  // this a half-written prompt dies with the switch. Omit to keep the composer stateless across mounts.
  draft?: { initialText: string; save: (text: string) => void; clear: () => void }
  className?: string
  ref?: Ref<ComposerHandle>
}

export function Composer({
  onSend,
  onInterrupt,
  busy,
  disabled,
  placeholder = 'Message the agent…',
  commands,
  skills,
  clientCommands,
  onSearchFiles,
  onShellCommand,
  attachments,
  toolbar,
  layout = 'stacked',
  fontSize,
  lineHeight,
  affordances,
  draft,
  className,
  ref,
}: ComposerProps) {
  const inline = layout === 'inline'
  const terminal = useTranscriptVariant() === 'terminal'
  // Read once, on mount: re-seeding mid-session would fight whatever is being typed.
  const [initialDraft] = useState(() => draft?.initialText ?? '')
  const { bind, plainText, isEmpty, clear, focus } = usePromptAreaState(
    initialDraft === '' ? undefined : { initialValue: plainTextToSegments(initialDraft) },
  )
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [shellMode, setShellMode] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  useImperativeHandle(
    ref,
    () => ({
      insertText: (text: string) => {
        const prefix = plainText.length > 0 && !/\s$/.test(plainText) ? ' ' : ''
        bind.ref.current?.appendText(prefix + text)
        focus()
      },
      focus,
    }),
    [bind.ref, plainText, focus],
  )

  const triggers = useMemo(() => {
    const configured = []
    const rows = mergeComposerRows({ commands, clientCommands, skills })
    if (rows.length > 0) {
      // Keyed by kind as well as name: an engine command and a skill may share one, and a chip's `data`
      // is serialized into the DOM, so the row itself never travels there.
      const byTag = new Map(rows.map((row) => [`${row.kind}:${row.name}`, row]))
      configured.push(
        commandTrigger({
          onSearch: (query: string): TriggerSuggestion[] =>
            rankComposerRows(query, rows).map((row) =>
              row.kind === 'skill'
                ? {
                    value: row.name,
                    label: row.label,
                    description: row.description ? `Skill · ${row.description}` : 'Skill · inserts a message you can edit',
                    icon: <Sparkles className="size-3.5 text-fg-3" />,
                    data: `${row.kind}:${row.name}`,
                  }
                : {
                    value: row.name,
                    label: `/${row.name}${row.argumentHint ? ` ${row.argumentHint}` : ''}`,
                    description: row.description,
                    icon: row.kind === 'client' ? <SlidersHorizontal className="size-3.5 text-fg-3" /> : undefined,
                    data: `${row.kind}:${row.name}`,
                  },
            ),
          insertAsText: (suggestion) => {
            const row = byTag.get(String(suggestion.data))
            if (row?.kind === 'skill') {
              return skillPrompt(row.skill)
            }
            return row?.kind === 'client' && row.command.requiresArgs ? `/${row.name} ` : undefined
          },
          onSelect: (suggestion) => suggestion.value,
          chipClassName: 'font-mono',
        }),
      )
    }
    if (onSearchFiles) {
      configured.push(
        mentionTrigger({
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
    if (onShellCommand) {
      configured.push(
        launchTrigger({
          char: '!',
          accessibilityLabel: 'shell mode',
          onActivate: () => setShellMode(true),
        }),
      )
    }
    return configured.length > 0 ? configured : undefined
  }, [commands, skills, clientCommands, onSearchFiles, onShellCommand])

  const saveDraft = draft?.save
  useEffect(() => {
    saveDraft?.(plainText)
  }, [plainText, saveDraft])

  const staged = attachments?.items ?? []
  const canSend = !disabled && (!isEmpty || staged.length > 0) && !attachments?.uploading && !attachments?.hasFailure

  const submit = () => {
    if (!canSend) {
      return
    }
    if (shellMode) {
      const command = plainText.trim()
      if (command === '') {
        return
      }
      onShellCommand?.(command)
      setShellMode(false)
      draft?.clear()
      clear()
      focus()
      return
    }
    onSend(plainText.trim(), attachments?.readyIds ?? [])
    attachments?.clear()
    draft?.clear()
    clear()
    focus()
  }

  const leaveShellMode = () => {
    setShellMode(false)
    focus()
  }

  const hints = [
    triggers?.some((t) => t.char === '/') ? { key: '/', what: 'commands and skills' } : undefined,
    onSearchFiles ? { key: '@', what: 'mention a file' } : undefined,
    onShellCommand ? { key: '!', what: 'run a shell command' } : undefined,
    { key: '?', what: 'this list, on an empty composer' },
  ].filter((h) => h !== undefined)
  // Escape and backspace-on-empty both leave, because both are what a person reaches for when the
  // pink frame was not what they meant. Backspace only when there is nothing left to delete.
  const shellKeys = shellMode
    ? {
        onEscape: leaveShellMode,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Backspace' && isEmpty) {
            e.preventDefault()
            leaveShellMode()
          }
        },
      }
    : {
        onEscape: helpOpen ? () => setHelpOpen(false) : undefined,
        // Only on a genuinely empty composer, so a message that opens with a question mark still types.
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === '?' && isEmpty && !e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            setHelpOpen(true)
            return
          }
          if (helpOpen) {
            setHelpOpen(false)
          }
        },
      }

  const helpHints = helpOpen ? (
    <>
      {hints.map((hint) => (
        <span key={hint.key} className="flex items-center gap-1">
          <kbd className="font-mono text-text">{hint.key}</kbd>
          {hint.what}
        </span>
      ))}
    </>
  ) : null
  const helpRow = helpOpen ? (
    <div
      role="note"
      aria-label="Composer shortcuts"
      className="mx-auto mb-1 flex w-full max-w-[var(--wd-transcript-max-width)] flex-wrap items-center gap-x-3 gap-y-1 text-label text-fg-3"
    >
      {helpHints}
    </div>
  ) : null

  const pick = (files: FileList | null) => {
    if (files && files.length > 0) {
      attachments?.add(files)
    }
  }

  const fileField =
    attachments && !attachments.disabled ? (
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={attachments.accept || undefined}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files)
          // Re-picking the same file must fire `change` again.
          e.target.value = ''
        }}
      />
    ) : null
  const canAttach = !!attachments && !attachments.disabled

  const attach = canAttach ? (
    <>
      {fileField}
      <Button variant="ghost" size="icon-sm" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>
        <Paperclip className="size-4" />
      </Button>
    </>
  ) : null

  const gutter = shellMode ? (
    <GlyphButton gutter label="Leave shell mode" tone="magenta" onClick={leaveShellMode}>
      !
    </GlyphButton>
  ) : busy ? (
    <GlyphButton gutter label="Interrupt" tone="yellow" onClick={onInterrupt}>
      ✕
    </GlyphButton>
  ) : canAttach ? (
    <GlyphButton gutter label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>
      +
    </GlyphButton>
  ) : (
    <span aria-hidden className="term-gutter" data-tone="blue">
      {PROMPT_GLYPH}
    </span>
  )

  const interrupting = busy && !canSend
  const submitButton = terminal ? (
    <GlyphButton label="Send" disabled={!canSend} onClick={submit} tone={canSend ? 'blue' : undefined}>
      ↵
    </GlyphButton>
  ) : interrupting ? (
    <Button variant="outline" size="icon-sm" aria-label="Interrupt" className="rounded-full" onClick={onInterrupt}>
      <Square className="size-3" />
    </Button>
  ) : (
    <Button size="icon-sm" aria-label="Send" className="rounded-full" disabled={!canSend} onClick={submit}>
      <ArrowUp className="size-4" />
    </Button>
  )

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (attachments && !attachments.disabled) {
        e.preventDefault()
        setDragging(true)
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      if (!attachments || attachments.disabled) {
        return
      }
      e.preventDefault()
      setDragging(false)
      pick(e.dataTransfer.files)
    },
  }

  const errorRow = attachments?.error ? (
    <div className={cn('mx-auto mt-1 flex w-full max-w-[var(--wd-transcript-max-width)] items-center gap-2 text-label text-danger')}>
      <TriangleAlert className="size-3 shrink-0" />
      <span className="min-w-0 flex-1">{attachments.error}</span>
      <button type="button" onClick={attachments.dismissError} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
        <X className="size-3" />
      </button>
    </div>
  ) : null

  if (terminal) {
    const line = lineHeight ?? 18
    return (
      <div data-slot="composer" className={cn('shrink-0', className)}>
        <TerminalSurface
          {...dropHandlers}
          fontSize={fontSize}
          lineHeight={lineHeight}
          affordances={affordances}
          bleed="1ch"
          data-dragging={dragging || undefined}
          className={cn('term-composer', shellMode && 'term-composer-shell', disabled && 'opacity-60')}
        >
          <div className="term-composer-body">
            {staged.length > 0 && attachments ? <AttachmentStrip attachments={attachments} /> : null}
            <div className="term-row">
              {canAttach && !shellMode ? fileField : null}
              {gutter}
              <div className="flex min-w-0 items-start">
                <PromptArea
                  {...bind}
                  triggers={triggers}
                  markdown={false}
                  normalizeBullets={false}
                  onSubmit={submit}
                  disabled={disabled}
                  placeholder={disabled ? 'Session ended' : shellMode ? SHELL_PLACEHOLDER : placeholder}
                  minHeight={line}
                  maxHeight={line * 10}
                  aria-label={shellMode ? 'Run a shell command' : 'Message the agent'}
                  className="term-composer-field min-w-0 flex-1"
                  onImagePaste={(file) => attachments?.add([file])}
                  {...shellKeys}
                />
                {submitButton}
              </div>
            </div>
            {helpOpen ? (
              <div role="note" aria-label="Composer shortcuts" className="term-row">
                <span aria-hidden className="term-gutter" />
                <div className="flex min-w-0 flex-wrap items-center gap-x-[2ch] text-fg-3">{helpHints}</div>
              </div>
            ) : null}
            {shellMode ? (
              <div className="term-row">
                <span aria-hidden className="term-gutter" />
                <span className="term-composer-shell-hint">{SHELL_HINT}</span>
              </div>
            ) : toolbar ? (
              <div className="term-row">
                <span aria-hidden className="term-gutter" />
                <div className="flex min-w-0 items-center gap-[1ch]">{toolbar}</div>
              </div>
            ) : null}
          </div>
        </TerminalSurface>
        {errorRow}
      </div>
    )
  }

  return (
    <div data-slot="composer" className={cn('px-[var(--wd-composer-padding)] pb-[var(--wd-composer-padding)]', className)}>
      {helpRow}
      <div
        {...dropHandlers}
        className={cn(
          'mx-auto w-full max-w-[var(--wd-transcript-max-width)] overflow-hidden border border-border bg-bg',
          'transition-colors rounded-lg shadow-(--shadow-xs)',
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          dragging && 'border-ring ring-2 ring-ring/30',
          shellMode &&
            'border-[var(--wd-shell-accent)] focus-within:border-[var(--wd-shell-accent)] focus-within:ring-[var(--wd-shell-accent)]/30',
          disabled && 'opacity-60',
        )}
      >
        {staged.length > 0 && attachments ? <AttachmentStrip attachments={attachments} /> : null}
        {inline ? (
          <div className="flex items-end gap-1 p-1">
            {shellMode ? <ShellBadge onLeave={leaveShellMode} /> : attach}
            <PromptArea
              {...bind}
              triggers={triggers}
              markdown={false}
              normalizeBullets={false}
              onSubmit={submit}
              disabled={disabled}
              placeholder={disabled ? 'Session ended' : shellMode ? SHELL_PLACEHOLDER : placeholder}
              minHeight={20}
              maxHeight={192}
              aria-label={shellMode ? 'Run a shell command' : 'Message the agent'}
              className="min-w-0 flex-1 py-1 text-body-sm text-text"
              onImagePaste={(file) => attachments?.add([file])}
              {...shellKeys}
            />
            {submitButton}
          </div>
        ) : (
          <>
            <PromptArea
              {...bind}
              triggers={triggers}
              markdown={false}
              normalizeBullets={false}
              onSubmit={submit}
              disabled={disabled}
              placeholder={disabled ? 'Session ended' : shellMode ? SHELL_PLACEHOLDER : placeholder}
              minHeight={28}
              maxHeight={192}
              aria-label={shellMode ? 'Run a shell command' : 'Message the agent'}
              className="px-3 pt-2.5 pb-0 text-body-sm text-text"
              onImagePaste={(file) => attachments?.add([file])}
              {...shellKeys}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex min-w-0 items-center gap-1">
                {shellMode ? <ShellBadge onLeave={leaveShellMode} /> : attach}
                {shellMode ? <span className="text-label text-text-muted">{SHELL_HINT}</span> : toolbar}
              </div>
              {submitButton}
            </div>
          </>
        )}
      </div>
      {errorRow}
    </div>
  )
}

function GlyphButton({
  tone,
  label,
  disabled,
  onClick,
  gutter,
  className,
  children,
}: {
  tone?: 'blue' | 'yellow' | 'magenta'
  label: string
  disabled?: boolean
  onClick: () => void
  gutter?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-tone={tone}
      data-gutter={gutter || undefined}
      className={cn('term-glyph', className)}
    >
      {children}
    </button>
  )
}

function AttachmentStrip({ attachments }: { attachments: UseAttachmentsResult }) {
  const terminal = useTranscriptVariant() === 'terminal'
  return (
    <div className={cn('flex gap-2 overflow-x-auto', terminal ? 'term-attachments' : 'border-b border-border px-2 py-2')}>
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

function AttachmentChip({ item, onRetry, onRemove }: { item: StagedAttachment; onRetry: () => void; onRemove: () => void }) {
  const failed = item.status === 'failed'
  const terminal = useTranscriptVariant() === 'terminal'
  const round = terminal ? '' : 'rounded-md'
  return (
    <div className="group relative shrink-0" title={failed ? `${item.name} - ${item.error}` : `${item.name} · ${formatBytes(item.bytes)}`}>
      <div
        className={cn(
          'flex size-14 items-center justify-center overflow-hidden bg-surface',
          round,
          terminal ? 'term-attachment' : 'border border-border',
          failed && 'border-danger/50',
        )}
        data-failed={terminal && failed ? '' : undefined}
      >
        {item.previewUrl ? (
          <img src={item.previewUrl} alt={item.name} className="size-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-0.5 text-fg-3">
            <FileText className="size-4" />
            <span className="max-w-12 truncate text-[9px] font-semibold uppercase">{extensionOf(item.name)}</span>
          </div>
        )}
      </div>
      {item.status === 'uploading' ? (
        <div className={cn('absolute inset-0 flex items-center justify-center bg-black/35', round)}>
          <Spinner className="size-4 text-white" />
        </div>
      ) : null}
      {failed ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`Retry ${item.name}`}
          className={cn('absolute inset-0 flex items-center justify-center bg-black/45 text-warning', round)}
        >
          <RotateCw className="size-4" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.name}`}
        className={cn(
          'absolute flex size-4 items-center justify-center bg-surface text-fg-3 hover:text-fg-1',
          terminal ? 'term-attachment-remove' : '-top-1 -right-1 rounded-full border border-border shadow-(--shadow-xs)',
        )}
      >
        <X className="size-2.5" />
      </button>
    </div>
  )
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}

function ShellBadge({ onLeave }: { onLeave: () => void }) {
  return (
    <button
      type="button"
      aria-label="Leave shell mode"
      title="Leave shell mode"
      onClick={onLeave}
      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-label font-semibold text-[var(--wd-shell-accent)]"
    >
      !
    </button>
  )
}
