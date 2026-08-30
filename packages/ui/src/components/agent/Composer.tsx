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

/** Files matching an `@` query, for the composer's file trigger. Structural so
 * the ui package doesn't have to reach for the protocol's `HostFileMatch`. */
export type ComposerFileMatch = { path: string; relative: string }

/** Imperative surface for panels that draft a message the user then finishes —
 * the skills dialog's "Use this skill". Nothing here sends. */
export type ComposerHandle = {
  /** Append plain text at the caret's end and focus, separating it from
   * whatever is already there. */
  insertText: (text: string) => void
  /** Put the caret in the field, changing nothing. */
  focus: () => void
}

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
  /**
   * Skills offered under a **`$`** popover of their own — codex's sigil, kept
   * separate from `/` because the two behave differently. Picking one inserts
   * editable text and sends nothing; no engine parses `$skillname` as syntax,
   * which is why these can never resolve to a chip the way `commands` do.
   */
  skills?: SkillInfo[]
  /** Host-file search behind the `@` trigger. Omit to leave `@` inert — a
   * gateway without host files has nothing to complete. */
  onSearchFiles?: (query: string, options: { signal: AbortSignal }) => Promise<ComposerFileMatch[]>
  /** Attachment staging (see `useAttachments`). Omit for a text-only composer. */
  attachments?: UseAttachmentsResult
  /** Left side of the toolbar row (mode selects, …). */
  toolbar?: ReactNode
  /**
   * `'stacked'` (default) gives the buttons a row of their own under the field.
   * `'inline'` puts field and buttons on ONE line, growing as the message does —
   * for a host whose session controls live in its own chrome.
   */
  layout?: 'stacked' | 'inline'
  /**
   * Terminal theme only: the cell the composer draws on. **It has to be
   * passed** — the composer sits outside the transcript's scroller, so it
   * establishes a second {@link TerminalSurface}, and one handed no metrics
   * falls back to the 13/18 default and puts the caret on a different column
   * from the text above it.
   */
  fontSize?: number
  lineHeight?: number
  /** Terminal theme only; see {@link TerminalAffordances}. */
  affordances?: TerminalAffordances | boolean
  className?: string
  ref?: Ref<ComposerHandle>
}

/** CLI names may carry display annotations (e.g. "foo (MCP)") the parser rejects. */
const cleanName = (name: string) => name.replace(/\s*\(MCP\)$/i, '')

/**
 * What a picked skill types into the composer: the engine's own `defaultPrompt`,
 * else `$name` — codex's native way of referring to a skill in prompt text.
 * Ordinary text, ending in a space; nothing is submitted or parsed back out.
 */
export const skillPrompt = (skill: SkillInfo): string => {
  const base = skill.defaultPrompt?.trim() || `$${skill.name}`
  return /\s$/.test(base) ? base : base + ' '
}

/** Ranks a haystack set against the typed query: 2 for a prefix hit, 1 for a
 * substring, 0 for no match. Shared so commands and skills sort as one list
 * rather than two concatenated ones. */
const matchScore = (query: string, haystacks: string[]): number => {
  const needle = query.toLowerCase()
  const lowered = haystacks.map((s) => s.toLowerCase())
  if (lowered.some((h) => h.startsWith(needle))) {
    return 2
  }
  return lowered.some((h) => h.includes(needle)) ? 1 : 0
}

/**
 * Framed prompt input built on prompt-area's contentEditable.
 *
 * Three completions ride the same field: `/` (commands) and `$` (skills) are
 * local and filter instantly, `@` searches the host filesystem, debounced and
 * abortable. A command resolves to a **chip** because the CLI really does parse
 * `/name` out of the message; a skill resolves to plain editable **text**
 * because no engine parses `$name` as syntax.
 *
 * Files arrive three ways — paperclip, drop, paste — and the upload starts the
 * moment one lands rather than at send time.
 */
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
        // A space in front only when there is something to separate from, so a
        // draft into an empty composer doesn't start with one.
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
      // The CLI list can contain the same skill name from several sources — first wins.
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
              // "wrapup" should find "dev:wrapup" — the bare half of a
              // namespaced name is what people type.
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
          // Chip text renders as trigger + displayText — return the bare name so
          // the chip reads "/name" (label carries the argument hint for the menu).
          onSelect: (suggestion) => suggestion.value,
          chipClassName: 'font-mono',
        }),
      )
    }
    if (usableSkills.length > 0) {
      // `$`, not `/`: codex's TUI completes skills on `$` and reserves `/` for
      // commands, and its bundled prompts refer to skills that way in prose.
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
          // Always text, never a chip: a skill is not wire syntax the engine
          // parses back out, so what lands stays ordinary editable prose.
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
          // A round trip per keystroke would be eight requests for one word.
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
  // A photo on its own is a message, but send waits for the upload: an id that
  // has not landed cannot be named.
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

  // Built once, placed twice: stacked gives these a toolbar row, inline sets
  // them either side of the field.
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

  // The terminal composer's gutter cell: `✕` to stop while busy, `+` to attach
  // otherwise, `❯` when neither applies so the column is never empty and the
  // typed line never shifts. `✕` rather than `■` because the square reads as a
  // *state* in a column where `●` and `◆` really are states — and because it
  // measures exactly 1ch in JetBrains Mono, which `⏹`/`⏸`/`⏻` do not.
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
    // Terminal furniture: a glyph that lights up on hover/focus, not a pill.
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
    // The CLI's own prompt on the CLI's own grid: the gutter cell aligns what
    // you type with what you are reading. That alignment is why this is its own
    // branch — the composer is outside the transcript's scroller and needs a
    // surface of its own at the same metrics.
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
              {/* The hidden input only — its trigger lives in the gutter. */}
              {canAttach ? fileField : null}
              {gutter}
              <div className="flex min-w-0 items-start">
                <PromptArea
                  {...bind}
                  triggers={triggers}
                  // The agent receives markdown, so the typed marker must
                  // survive. Left on, the editor rewrites `- ` to `• ` in the
                  // *model*, and `• item` is not a list to any markdown parser.
                  // Off, `insertListContinuation` still reuses the line's own
                  // marker, so Enter after `- item` inserts `\n- `.
                  normalizeBullets={false}
                  onSubmit={submit}
                  disabled={disabled}
                  placeholder={disabled ? 'Session ended' : placeholder}
                  // The field's metrics are the cell's: one row is one line.
                  minHeight={line}
                  maxHeight={line * 10}
                  aria-label="Message the agent"
                  className="term-composer-field min-w-0 flex-1"
                  onImagePaste={(file) => attachments?.add([file])}
                />
                {submitButton}
              </div>
            </div>
            {/* Model and mode below the prompt, on the body column so they read
                as a continuation of the line rather than new chrome. Absent
                under `controlsSurface: 'external'`. */}
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
        {/* Above the field, like the picture you are talking about should be. */}
        {staged.length > 0 && attachments ? <AttachmentStrip attachments={attachments} /> : null}
        {inline ? (
          // One row until the message needs more. On a single line the 28px
          // buttons and 20px text need 4px of padding either side so their
          // centres land on the same line.
          <div className="flex items-end gap-1 p-1">
            {attach}
            <PromptArea
              {...bind}
              triggers={triggers}
              // See the terminal composer above: `•` is not a markdown list
              // marker, and this rewrite reaches the sent message.
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
              // See the terminal composer above: `•` is not a markdown list
              // marker, and this rewrite reaches the sent message.
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

/** A composer action as a **character**: one cell wide and one line tall
 * (`term-glyph` in `terminal.css`), so removing it would move nothing. */
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
  /** Standing in the gutter cell rather than at the row's trailing edge, so the
   * glyph aligns to the column's start like every transcript marker instead of
   * centring in the 2ch cell — see `.term-glyph[data-gutter]`. */
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

/** Staged files as a scrolling row of chips above the field. The thumbnail is
 * the local blob, so nothing here waits on the network. */
const AttachmentStrip = ({ attachments }: { attachments: UseAttachmentsResult }) => {
  const terminal = useTranscriptVariant() === 'terminal'
  return (
    <div
      className={cn(
        'flex gap-2 overflow-x-auto',
        // The terminal form draws no rule of its own: the composer's frame is
        // already directly below. Geometry in `terminal.css`.
        terminal ? 'term-attachments' : 'border-b border-border px-2 py-2',
      )}
    >
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
  // Corners are the whole difference: rounded and floating in `cards`, square
  // and inside the frame here. One flag so a thumbnail and its overlays cannot
  // disagree about their shape.
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
          // Cards hang it off the corner as a round badge; the terminal tucks
          // it inside, squared (`terminal.css`).
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
