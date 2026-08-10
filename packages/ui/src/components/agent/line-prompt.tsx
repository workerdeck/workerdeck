import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'
import { Response } from './Response.tsx'
import { LineGlyph } from './transcript-variant.tsx'

/**
 * The parts a terminal-shaped prompt is built from.
 *
 * The `lines` transcript answers a question the `cards` one does not have to:
 * an approval and a question are *interactive*, so "no boxes" has to be paid for
 * by something else carrying the affordance. That something is the keyboard —
 * a roving `❯` marker, numbered rows, and a hint line — which is what a terminal
 * would do anyway, and what makes the prompt answerable without reaching for the
 * mouse in a dock where the rows are two lines tall.
 *
 * Everything here indents to the same gutter as every other line item, so an
 * approval reads as one more row in the run rather than a dialog dropped on top
 * of it.
 */

/** The left inset that lines up body text with a `LineGlyph`'d row above it. */
export const LINE_INDENT = 'pl-[calc(0.875rem+0.5rem)]'

export type LineChoice = {
  key: string
  label: string
  description?: string
  /**
   * Rendered under the row, outside the button — a preview, an input. The caller
   * decides when it exists (focused, checked); a button may not contain one.
   */
  detail?: ReactNode
  /**
   * Present → the row carries a selection state and draws it. `marker` says in
   * which idiom: a checkbox for a multi-select, a radio for a one-of. Absent →
   * the row is an action (allow, deny), which has no state to show.
   */
  checked?: boolean
  marker?: 'check' | 'radio'
  danger?: boolean
}

/** The two-state glyph pairs, in the character forms a terminal would use. */
const MARKERS = {
  check: ['[ ]', '[x]'],
  radio: ['( )', '(•)'],
} as const

export interface LineOptionListProps {
  options: LineChoice[]
  /** Roving index: the one row that is tab-reachable and wears the marker. */
  focused: number
  onFocus: (index: number) => void
  onChoose: (index: number) => void
  /**
   * Own the DOM focus, moving it with the roving index. False while something
   * else inside the prompt holds it (a reason input, another question's list) —
   * two lists both chasing `focused` would tear the caret back and forth.
   */
  active?: boolean
  label: string
  className?: string
}

/**
 * A keyboard-first list of choices as line items: `↑`/`↓` move, `1`–`9` pick
 * directly, `Enter`/`Space` take the focused one (the button does that itself).
 */
export function LineOptionList({
  options,
  focused,
  onFocus,
  onChoose,
  active = true,
  label,
  className,
}: LineOptionListProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (active) refs.current[focused]?.focus()
  }, [active, focused])

  const move = (delta: number) => {
    if (options.length > 0) onFocus((focused + delta + options.length) % options.length)
  }

  return (
    <div
      role='group'
      aria-label={label}
      className={cn('flex flex-col', className)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          move(1)
          event.preventDefault()
          return
        }
        if (event.key === 'ArrowUp') {
          move(-1)
          event.preventDefault()
          return
        }
        // Digits are the whole point of numbering the rows — but only up to the
        // rows that exist, so `9` on a three-option prompt stays a no-op rather
        // than a silent miss.
        const digit = Number(event.key)
        if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(options.length, 9)) {
          onFocus(digit - 1)
          onChoose(digit - 1)
          event.preventDefault()
        }
      }}>
      {options.map((option, index) => {
        const isFocused = index === focused
        return (
          <div key={option.key} className='flex flex-col'>
            <button
              ref={(element) => {
                refs.current[index] = element
              }}
              type='button'
              tabIndex={isFocused ? 0 : -1}
              aria-pressed={option.checked}
              onFocus={() => onFocus(index)}
              onClick={() => onChoose(index)}
              className={cn(
                'flex w-full items-baseline gap-2 text-left outline-none',
                isFocused ? 'bg-surface-hover' : 'hover:bg-surface-hover/60',
              )}>
              <LineGlyph className={isFocused ? 'text-accent' : undefined}>
                {isFocused ? '❯' : ' '}
              </LineGlyph>
              <span className='shrink-0 font-mono text-label leading-5 text-fg-4'>{index + 1}</span>
              {option.checked !== undefined ? (
                <span
                  className={cn(
                    'shrink-0 font-mono text-label leading-5',
                    option.checked ? 'text-accent' : 'text-fg-4',
                  )}>
                  {MARKERS[option.marker ?? 'check'][option.checked ? 1 : 0]}
                </span>
              ) : null}
              <span
                className={cn(
                  'min-w-0 flex-1 text-body-sm leading-5',
                  option.danger ? 'text-danger' : 'text-fg-1',
                )}>
                {option.label}
                {option.description ? (
                  <span className='text-fg-4'> — {option.description}</span>
                ) : null}
              </span>
            </button>
            {option.detail ? <div className={LINE_INDENT}>{option.detail}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

/** The dim key legend under a prompt. Separated by `·`, like a status line. */
export function LineHint({ children }: { children: ReactNode }) {
  return (
    <div className={cn(LINE_INDENT, 'text-label leading-5 text-fg-4')}>{children}</div>
  )
}

/** A single-line text field in the terminal idiom: a caret glyph and a rule,
 * no box. `Enter` commits, `Escape` backs out — the caller says what those mean. */
export function LineInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  placeholder?: string
}) {
  return (
    <div className='flex items-baseline gap-2'>
      <LineGlyph className='text-accent'>›</LineGlyph>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
          if (event.key === 'Escape') {
            // The prompt's own Escape means "deny"/"dismiss"; inside the field it
            // only closes the field, so it must not travel further.
            event.stopPropagation()
            onCancel()
          }
        }}
        className='min-w-0 flex-1 border-b border-border bg-transparent text-body-sm leading-5 text-fg-1 outline-none placeholder:text-fg-4 focus:border-accent'
      />
    </div>
  )
}

/**
 * A payload in the terminal idiom: a dim label line over a **highlighted** band.
 *
 * Highlighting goes through `Response` — the markdown renderer already carries
 * shiki, so wrapping the text in a fence costs no new dependency, no second
 * highlighter and no second theme to keep in sync, and it inherits the terminal
 * flattening plus the hover copy/download the renderer draws for every code
 * block. Text with no language still goes through it, as an unlabelled fence:
 * same band, same grid, no grammar guessed.
 */
export function LinePayload({
  code,
  label,
  language,
  className,
}: {
  code: string
  label: string
  language?: string
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <span className='block truncate text-label leading-5 text-fg-4'>{label}</span>
      <Response>{fence(code, language)}</Response>
    </div>
  )
}

/**
 * Wrap text as a markdown code fence, with a fence long enough to survive the
 * content: a payload containing ``` would otherwise close the block early and
 * spill the rest of it into the transcript as markdown.
 */
export function fence(code: string, language?: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${language ?? ''}\n${code}\n${ticks}`
}
