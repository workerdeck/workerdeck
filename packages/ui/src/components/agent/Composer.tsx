import { useImperativeHandle, useMemo, useRef, useState, type DragEvent, type ReactNode, type Ref } from 'react'
import type { SkillInfo, SlashCommandInfo } from '@workerdeck/protocol'
import type { StagedAttachment, UseAttachmentsResult } from '@workerdeck/react'
import { ArrowUp, FileText, Paperclip, RotateCw, Sparkles, Square, TriangleAlert, X } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { PromptArea } from '../prompt-area/prompt-area.tsx'
import { usePromptAreaState } from '../prompt-area/use-prompt-area-state.ts'
import { commandTrigger, mentionTrigger } from '../prompt-area/trigger-presets.ts'
import { useTranscriptVariant } from './transcript-variant.tsx'
import type { TerminalAffordances } from '../terminal/affordances.tsx'
import { PROMPT_GLYPH } from '../terminal/items.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import type { TriggerSuggestion } from '../prompt-area/types.ts'
import { cn } from '../../lib/utils.ts'
import { formatBytes } from '../../lib/format.ts'

export type ComposerFileMatch = { path: string; relative: string }

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
  onSearchFiles?: (query: string, options: { signal: AbortSignal }) => Promise<ComposerFileMatch[]>
  attachments?: UseAttachmentsResult
  toolbar?: ReactNode
  layout?: 'stacked' | 'inline'
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  className?: string
  ref?: Ref<ComposerHandle>
}

const cleanName = (name: string) => name.replace(/\s*\(MCP\)$/i, '')

export const skillPrompt = (skill: SkillInfo): string => {
  const base = skill.defaultPrompt?.trim() || `$${skill.name}`
  return /\s$/.test(base) ? base : base + ' '
}

const matchScore = (query: string, haystacks: string[]): number => {
  const needle = query.toLowerCase()
  const lowered = haystacks.map((s) => s.toLowerCase())
  if (lowered.some((h) => h.startsWith(needle))) {
    return 2
  }
  return lowered.some((h) => h.includes(needle)) ? 1 : 0
}

export function Composer({
  onSend,
  onInterrupt,
  busy,
  disabled,
  placeholder = 'Message the agent…',
  commands,
  skills,
  onSearchFiles,
  attachments,
  toolbar,
  layout = 'stacked',
  fontSize,
  lineHeight,
  affordances,
  className,
  ref,
}: ComposerProps) {
  const inline = layout === 'inline'
  const terminal = useTranscriptVariant() === 'terminal'
  const { bind, plainText, isEmpty, clear, focus } = usePromptAreaState()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

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
    const usableSkills = (skills ?? []).filter((s) => s.enabled)
    if (commands && commands.length > 0) {
      const seen = new Set<string>()
      const unique = commands.flatMap((c) => {
        const name = cleanName(c.name)
        if (seen.has(name)) {
          return []
        }
        seen.add(name)
        return [{ ...c, name }]
      })
      configured.push(
        commandTrigger({
          onSearch: (query: string): TriggerSuggestion[] => {
            const scored: Array<{ score: number; suggestion: TriggerSuggestion }> = []
            for (const c of unique) {
              const score = matchScore(query, [c.name, ...(c.aliases ?? []), ...c.name.split(':')])
              if (score === 0) {
                continue
              }
              scored.push({
                score,
                suggestion: {
                  value: c.name,
                  label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
                  description: c.description,
                },
              })
            }
            scored.sort((a, b) => b.score - a.score)
            return scored.map(({ suggestion }) => suggestion)
          },
          onSelect: (suggestion) => suggestion.value,
          chipClassName: 'font-mono',
        }),
      )
    }
    if (usableSkills.length > 0) {
      configured.push(
        commandTrigger({
          char: '$',
          accessibilityLabel: 'skill',
          onSearch: (query: string): TriggerSuggestion[] => {
            const scored: Array<{ score: number; suggestion: TriggerSuggestion }> = []
            for (const skill of usableSkills) {
              const score = matchScore(query, [skill.name, ...skill.name.split(/[-:_]/)])
              if (score === 0) {
                continue
              }
              const summary = skill.shortDescription ?? skill.description
              scored.push({
                score,
                suggestion: {
                  value: skill.name,
                  label: skill.displayName ?? skill.name,
                  description: summary ? `Skill · ${summary}` : 'Skill · inserts a message you can edit',
                  icon: <Sparkles className="size-3.5 text-fg-3" />,
                },
              })
            }
            scored.sort((a, b) => b.score - a.score)
            return scored.map(({ suggestion }) => suggestion)
          },
          insertAsText: (suggestion) => {
            const skill = usableSkills.find((s) => s.name === suggestion.value)
            return skill ? skillPrompt(skill) : `$${suggestion.value} `
          },
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
    return configured.length > 0 ? configured : undefined
  }, [commands, skills, onSearchFiles])

  const staged = attachments?.items ?? []
  const canSend = !disabled && (!isEmpty || staged.length > 0) && !attachments?.uploading && !attachments?.hasFailure

  const submit = () => {
    if (!canSend) {
      return
    }
    onSend(plainText.trim(), attachments?.readyIds ?? [])
    attachments?.clear()
    clear()
    focus()
  }

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

  const gutter = busy ? (
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
          className={cn('term-composer', disabled && 'opacity-60')}
        >
          <div className="term-composer-body">
            {staged.length > 0 && attachments ? <AttachmentStrip attachments={attachments} /> : null}
            <div className="term-row">
              {canAttach ? fileField : null}
              {gutter}
              <div className="flex min-w-0 items-start">
                <PromptArea
                  {...bind}
                  triggers={triggers}
                  normalizeBullets={false}
                  onSubmit={submit}
                  disabled={disabled}
                  placeholder={disabled ? 'Session ended' : placeholder}
                  minHeight={line}
                  maxHeight={line * 10}
                  aria-label="Message the agent"
                  className="term-composer-field min-w-0 flex-1"
                  onImagePaste={(file) => attachments?.add([file])}
                />
                {submitButton}
              </div>
            </div>
            {toolbar ? (
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
      <div
        {...dropHandlers}
        className={cn(
          'mx-auto w-full max-w-[var(--wd-transcript-max-width)] overflow-hidden border border-border bg-bg',
          'transition-colors rounded-lg shadow-(--shadow-xs)',
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          dragging && 'border-ring ring-2 ring-ring/30',
          disabled && 'opacity-60',
        )}
      >
        {staged.length > 0 && attachments ? <AttachmentStrip attachments={attachments} /> : null}
        {inline ? (
          <div className="flex items-end gap-1 p-1">
            {attach}
            <PromptArea
              {...bind}
              triggers={triggers}
              normalizeBullets={false}
              onSubmit={submit}
              disabled={disabled}
              placeholder={disabled ? 'Session ended' : placeholder}
              minHeight={20}
              maxHeight={192}
              aria-label="Message the agent"
              className="min-w-0 flex-1 py-1 text-body-sm text-text"
              onImagePaste={(file) => attachments?.add([file])}
            />
            {submitButton}
          </div>
        ) : (
          <>
            <PromptArea
              {...bind}
              triggers={triggers}
              normalizeBullets={false}
              onSubmit={submit}
              disabled={disabled}
              placeholder={disabled ? 'Session ended' : placeholder}
              minHeight={28}
              maxHeight={192}
              aria-label="Message the agent"
              className="px-3 pt-2.5 pb-0 text-body-sm text-text"
              onImagePaste={(file) => attachments?.add([file])}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex min-w-0 items-center gap-1">
                {attach}
                {toolbar}
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

const GlyphButton = ({
  tone,
  label,
  disabled,
  onClick,
  gutter,
  className,
  children,
}: {
  tone?: 'blue' | 'yellow'
  label: string
  disabled?: boolean
  onClick: () => void
  gutter?: boolean
  className?: string
  children: ReactNode
}) => {
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

const AttachmentStrip = ({ attachments }: { attachments: UseAttachmentsResult }) => {
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
    <div className="group relative shrink-0" title={failed ? `${item.name} — ${item.error}` : `${item.name} · ${formatBytes(item.bytes)}`}>
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

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}
