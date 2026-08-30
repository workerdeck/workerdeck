/**
 * The parts a terminal prompt is built from, in the CLI's idiom: a rule marks
 * where the run stops and the decision starts, options are numbered so a key
 * press is an answer, a hint line says which keys. Everything stays on the
 * grid — rules and box frames are drawn by backgrounds, never borders that
 * would cost layout.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'
import { Blank, Ink, Row } from './row.tsx'

/**
 * The boundary above a prompt. Solid separates the run from the decision;
 * dashed separates parts *within* it.
 */
export function Rule({ dashed }: { dashed?: boolean }) {
  return <div className={cn('term-rule-row', dashed && 'term-rule-dashed')} aria-hidden />
}

/** The dim `·`-separated key legend under a prompt. */
export function Hint({ children }: { children: ReactNode }) {
  return <Row tone="faint">{children}</Row>
}

/**
 * A framed payload — a preview, a snippet. The frame is background gradients,
 * not a border: a 1px border would push the contents off the column grid.
 */
export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('term-box', className)}>{children}</div>
}

/**
 * The prompt's heading: the action (`displayName`), then the subject it acts
 * on — the CLI's own two lines.
 */
export function PromptTitle({ title, subject }: { title: string; subject?: string }) {
  return (
    <>
      <Row tone="blue" bold>
        {title}
      </Row>
      {subject ? <Row tone="dim">{subject}</Row> : null}
    </>
  )
}

export type Choice = {
  key: string
  label: string
  /** Rendered dim on its own row under the label — never appended to it. */
  description?: string
  /**
   * Present → the row carries selection state; `marker` says in which idiom
   * (`[x]` multi-select, `(•)` one-of). Absent → the row is an action.
   */
  checked?: boolean
  marker?: 'check' | 'radio'
  /** Chosen, in a list that draws no markers (a one-of) — the colour is the
   * only trace of the answer when tabbing back. */
  selected?: boolean
  danger?: boolean
  /** Rendered under the row, outside the button (a preview, a text field) — a
   * button may not hold one. */
  detail?: ReactNode
}

/** The two-state glyph pairs, in the forms a terminal would use. */
const MARKERS = {
  check: ['[ ]', '[✓]'],
  radio: ['( )', '(•)'],
} as const

export interface ChoicesProps {
  options: Choice[]
  /** Roving index: the one row that is tab-reachable and wears the `❯`. */
  focused: number
  onFocus: (index: number) => void
  onChoose: (index: number) => void
  /**
   * Own the DOM focus, moving it with the roving index. False while something
   * else inside the prompt holds it — two lists both chasing `focused` would
   * tear the caret back and forth.
   */
  active?: boolean
  /**
   * Take the keyboard when the list first appears (default true). A first-mount
   * decision only, and it declines while the reader is mid-message (see
   * {@link isTyping}): an approval landing mid-sentence must not steal the caret.
   */
  autoFocus?: boolean
  label: string
}

/** Is the reader mid-keystroke somewhere that keeps its own caret? */
const isTyping = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  const editable = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable
  if (!editable) {
    return false
  }
  // Only a message in progress is worth protecting, not mere focus in a field:
  // some hosts (VS Code) keep the composer focused at all times, and guarding
  // on focus alone means the prompt can never take the keyboard. An empty
  // field has nothing to lose.
  const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? '')
  return text.trim().length > 0
}

/**
 * A keyboard-first list of choices, as rows: `↑`/`↓` move, `1`–`9` pick
 * directly, `Enter`/`Space` take the focused one. The number is part of the
 * gutter, not the label, so every option's text starts on the same column.
 */
export function Choices({ options, focused, onFocus, onChoose, active = true, autoFocus = true, label }: ChoicesProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!active) {
      return
    }
    // Told apart by where the keyboard already is, NOT by how many times this
    // has run: if focus is on one of these rows the DOM must follow `focused`
    // unconditionally (or the `❯` and the caret drift apart); otherwise this
    // is the refusable initial takeover. A `mounted` ref is not safe here —
    // StrictMode's simulated remount preserves refs, so it skips the guard and
    // steals focus in dev.
    const focusIsInList = refs.current.some((row) => row !== null && row === document.activeElement)
    if (!focusIsInList && (!autoFocus || isTyping(document.activeElement))) {
      return
    }
    refs.current[focused]?.focus()
  }, [active, focused, autoFocus])

  const move = (delta: number) => {
    if (options.length > 0) {
      onFocus((focused + delta + options.length) % options.length)
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
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
        // Digits pick directly — but only rows that exist; `9` on a
        // three-option prompt stays a no-op.
        const digit = Number(event.key)
        if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(options.length, 9)) {
          onFocus(digit - 1)
          onChoose(digit - 1)
          event.preventDefault()
        }
      }}
    >
      {options.map((option, index) => {
        const isFocused = index === focused
        return (
          <div key={option.key}>
            <button
              ref={(element) => {
                refs.current[index] = element
              }}
              type="button"
              tabIndex={isFocused ? 0 : -1}
              aria-pressed={option.checked}
              onFocus={() => onFocus(index)}
              onClick={() => onChoose(index)}
              className="term-press"
            >
              {/* `❯ 1.` is the gutter, so the label starts on one column
                  whether or not the row is focused. */}
              <Row
                columns={5}
                glyph={`${isFocused ? '❯' : ' '} ${index + 1}.`}
                glyphTone={isFocused ? 'fg' : 'faint'}
                tone={option.danger ? 'red' : option.selected ? 'green' : 'fg'}
                data-focused={isFocused ? '' : undefined}
              >
                {option.checked !== undefined ? (
                  <Ink tone={option.checked ? 'green' : 'faint'}>{MARKERS[option.marker ?? 'check'][option.checked ? 1 : 0]} </Ink>
                ) : null}
                <Ink bold={isFocused || option.selected}>{option.label}</Ink>
              </Row>
            </button>
            {option.description ? (
              <Row columns={5} tone="dim">
                {option.description}
              </Row>
            ) : null}
            {option.detail ? <div className="term-detail">{option.detail}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A single-line text field in the terminal idiom: a caret and a rule, no box.
 * `Enter` commits, `Escape` backs out — the caller says what those mean.
 */
export function PromptInput({
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
    <Row columns={5} glyph="   ›" glyphTone="dim">
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
            // The prompt's own Escape means deny/dismiss; inside the field it
            // only closes the field, so it must not travel further.
            event.stopPropagation()
            onCancel()
          }
        }}
        className="term-input"
      />
    </Row>
  )
}

/**
 * The question strip: one chip per question plus the submit step, active one
 * filled — a form that hides two of its three questions has to say so. The
 * arrows are the legend for `Tab`/`Shift+Tab`, not controls.
 */
export function TabStrip({
  tabs,
  active,
  onSelect,
}: {
  /** `glyph` rather than a derived done/not-done mark: the submit step is
   * always a `✓`, not a thing to answer. */
  tabs: { key: string; label: string; glyph: string }[]
  active: number
  onSelect: (index: number) => void
}) {
  return (
    <Row glyph="←" glyphTone="faint">
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          type="button"
          tabIndex={-1}
          onClick={() => onSelect(index)}
          className={cn('term-tab', index === active && 'term-tab-active')}
        >
          {tab.glyph} {tab.label}
        </button>
      ))}
      <Ink tone="faint"> →</Ink>
    </Row>
  )
}

export { Blank }
