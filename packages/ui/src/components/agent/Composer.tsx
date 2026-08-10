import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { SkillInfo, SlashCommandInfo } from '@workerdeck/protocol'
import type { StagedAttachment, UseAttachmentsResult } from '@workerdeck/react'
import {
  ArrowUp,
  FileText,
  Paperclip,
  RotateCw,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
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

/** Imperative surface for panels that draft a message the user then finishes —
 * the skills dialog's "Use this skill". Nothing here sends. */
export type ComposerHandle = {
  /** Append plain text at the caret's end and focus, separating it from
   * whatever is already there. */
  insertText: (text: string) => void
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
   * separate from `/` because the two behave differently. A skill is a typing
   * aid, not a command: picking one inserts editable text (the skill's own
   * `defaultPrompt` where it has one, else `$name`) and nothing is sent. No
   * engine parses `$skillname` as syntax, which is exactly why these can never
   * resolve to a chip the way `commands` do.
   */
  skills?: SkillInfo[]
  /** Host-file search behind the `@` trigger. Omit to leave `@` inert — a
   * gateway without host files has nothing to complete. */
  onSearchFiles?: (query: string, options: { signal: AbortSignal }) => Promise<ComposerFileMatch[]>
  /** Attachment staging (see `useAttachments`). Omit for a text-only composer. */
  attachments?: UseAttachmentsResult
  /** Left side of the toolbar row (mode selects, …). */
  toolbar?: ReactNode
  className?: string
  ref?: Ref<ComposerHandle>
}

/** CLI names may carry display annotations (e.g. "foo (MCP)") the parser rejects. */
const cleanName = (name: string) => name.replace(/\s*\(MCP\)$/i, '')

/**
 * What a picked skill types into the composer.
 *
 * The engine's own `defaultPrompt` when it declared one — it knows what its
 * skill wants to be asked — and otherwise `$name`, which is codex's native way
 * of referring to a skill in prompt text: its `skill-creator` documents the form
 * (`Use $skill-x at /path/to/skill-x to solve problem y`) and its own bundled
 * prompts are written that way ("Use $pdf to …"). Spelling it the way the engine
 * spells it beats paraphrasing into "Use the X skill to".
 *
 * Either way it ends in a space so the caret lands ready for the rest of the
 * sentence, and either way it is ordinary text: nothing here is submitted, and
 * nothing is parsed back out.
 */
export function skillPrompt(skill: SkillInfo): string {
  const base = skill.defaultPrompt?.trim() || `$${skill.name}`
  return /\s$/.test(base) ? base : base + ' '
}

/** Ranks a haystack set against the typed query: 2 for a prefix hit, 1 for a
 * substring, 0 for no match. Shared so commands and skills sort as one list
 * rather than two concatenated ones. */
function matchScore(query: string, haystacks: string[]): number {
  const needle = query.toLowerCase()
  const lowered = haystacks.map((s) => s.toLowerCase())
  if (lowered.some((h) => h.startsWith(needle))) return 2
  return lowered.some((h) => h.includes(needle)) ? 1 : 0
}

/**
 * Framed prompt input built on prompt-area's contentEditable.
 *
 * Three completions ride the same field and behave nothing alike. `/` is the
 * CLI's command list and `$` is the engine's skill list — both local, so they
 * filter completely and instantly; `@` is a search against the host filesystem,
 * debounced and abortable so a fast typist makes one request rather than eight.
 *
 * `/` and `$` are separate keys rather than one merged menu, and that mirrors
 * the engines themselves: codex completes skills on `$` and reserves `/` for
 * commands. The behaviours differ too — a command resolves to a **chip**,
 * because the CLI really does parse `/name` out of the message, while a skill
 * resolves to plain editable **text**, because no engine parses `$name` as
 * syntax; it is prose the model reads. Rendering them alike would promise
 * something that does not happen.
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
  skills,
  onSearchFiles,
  attachments,
  toolbar,
  className,
  ref,
}: ComposerProps) {
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
        if (seen.has(name)) return []
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
              if (score === 0) continue
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
      // `$`, not `/`, because that is codex's own sigil — its TUI completes
      // skills on `$` and reserves `/` for commands, and its bundled prompts
      // refer to skills that way in prose ("Use $pdf to …"). Matching it means
      // muscle memory transfers, and it keeps the two lists from being one
      // ambiguous menu of things that behave differently.
      configured.push(
        commandTrigger({
          char: '$',
          accessibilityLabel: 'skill',
          onSearch: (query: string): TriggerSuggestion[] => {
            const scored: Array<{ score: number; suggestion: TriggerSuggestion }> = []
            for (const skill of usableSkills) {
              const score = matchScore(query, [skill.name, ...skill.name.split(/[-:_]/)])
              if (score === 0) continue
              const summary = skill.shortDescription ?? skill.description
              scored.push({
                score,
                suggestion: {
                  value: skill.name,
                  label: skill.displayName ?? skill.name,
                  description: summary
                    ? `Skill · ${summary}`
                    : 'Skill · inserts a message you can edit',
                  icon: <Sparkles className='size-3.5 text-fg-3' />,
                },
              })
            }
            scored.sort((a, b) => b.score - a.score)
            return scored.map(({ suggestion }) => suggestion)
          },
          // Always text, never a chip: a skill is not wire syntax the engine
          // parses back out, so what lands has to stay ordinary editable prose.
          // Returning a string unconditionally is what makes this trigger's
          // whole list behave that way.
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
  }, [commands, skills, onSearchFiles])

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
          'mx-auto w-full max-w-[var(--wd-content-max-w,48rem)] overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-xs)',
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
        <div className='mx-auto mt-1 flex w-full max-w-[var(--wd-content-max-w,48rem)] items-center gap-2 text-label text-danger'>
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
        <div
          data-slot='composer-hint'
          className='mx-auto mt-1 w-full max-w-[var(--wd-content-max-w,48rem)] text-center text-label text-fg-4'>
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
