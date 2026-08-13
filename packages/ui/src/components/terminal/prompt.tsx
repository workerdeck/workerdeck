import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'
import { Blank, Ink, Row } from './row.tsx'

/**
 * The parts a terminal prompt is built from.
 *
 * An approval and a question are the two places the transcript stops being a log
 * and becomes a form, and "no boxes" has to be paid for by something. In the CLI
 * it is paid for three ways, and all three are here: a **rule** marks where the
 * run stops and the decision starts, the options are **numbered** so a key press
 * is an answer, and a **hint line** says which keys. That is what makes a prompt
 * answerable without reaching for the mouse — which is the whole reason a
 * terminal UI can be faster than a dialog.
 *
 * Everything stays on the grid: the rules are one line tall with the stroke
 * drawn through the middle by a background (a border would cost layout), and the
 * roving `❯` lives in the same gutter cell every other row uses.
 */

/**
 * The boundary above a prompt. Solid separates the run from the decision; dashed
 * separates parts *within* it (the CLI puts one between a diff and its question),
 * which is why there are two weights and not one.
 */
export function Rule({ dashed }: { dashed?: boolean }) {
  return <div className={cn('term-rule-row', dashed && 'term-rule-dashed')} aria-hidden />
}

/** The dim `·`-separated key legend under a prompt. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <Row tone='faint'>
      {children}
    </Row>
  )
}

/**
 * A framed payload — a preview, a snippet. The frame is drawn with four
 * background gradients rather than a border, so it costs no layout: a 1px border
 * would push its contents a pixel off the column every other row sits on.
 */
export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('term-box', className)}>{children}</div>
}

/**
 * The prompt's heading: what is being asked, and about what.
 *
 * Two lines because the engine gives two — `displayName` ("Edit file") is the
 * action, and the subject (the path) is the thing it acts on. The CLI shows them
 * exactly this way, and it is the one place in the theme where colour is used
 * for emphasis rather than for state.
 */
export function PromptTitle({ title, subject }: { title: string; subject?: string }) {
  return (
    <>
      <Row tone='blue' bold>
        {title}
      </Row>
      {subject ? <Row tone='dim'>{subject}</Row> : null}
    </>
  )
}

export type Choice = {
  key: string
  label: string
  /** Rendered dim on its own row under the label, as the CLI does for a
   * multi-select's options — never appended to the label, which would make the
   * row wrap and cost the list its scannability. */
  description?: string
  /**
   * Present → the row carries selection state and draws it. `marker` says in
   * which idiom: `[x]` for a multi-select, `(•)` for a one-of. Absent → the row
   * is an action (Allow, Cancel), which has no state to show.
   */
  checked?: boolean
  marker?: 'check' | 'radio'
  /**
   * Chosen, in a list that draws no markers (a one-of). The colour is the whole
   * signal there: without it, tabbing back to an answered question would show no
   * trace of the answer given.
   */
  selected?: boolean
  danger?: boolean
  /** Rendered under the row, outside the button — a preview, a text field. The
   * caller decides when it exists (focused, checked); a button may not hold one. */
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
   * else inside the prompt holds it (a text field, another question's list) —
   * two lists both chasing `focused` would tear the caret back and forth.
   */
  active?: boolean
  /**
   * Take the keyboard when the list first appears. True by default — a prompt
   * whose whole affordance is "press 1" is useless if the keys go somewhere
   * else, and the CLI hands the keyboard over the moment it asks.
   *
   * It is a *first mount* decision only, and it declines when the reader is
   * already typing (see {@link isTyping}): an approval landing mid-sentence must
   * not pull the caret out of the composer and scatter the rest of the sentence
   * across an option list.
   */
  autoFocus?: boolean
  label: string
}

/** Is the reader mid-keystroke somewhere that keeps its own caret? */
function isTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable
  )
}

/**
 * A keyboard-first list of choices, as rows: `↑`/`↓` move, `1`–`9` pick
 * directly, `Enter`/`Space` take the focused one (the button does that itself).
 *
 * The number is part of the gutter, not the label, so every option's text starts
 * on the same column and the list reads as a column of answers rather than a
 * ragged paragraph.
 */
export function Choices({
  options,
  focused,
  onFocus,
  onChoose,
  active = true,
  autoFocus = true,
  label,
}: ChoicesProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const mounted = useRef(false)

  useEffect(() => {
    if (!active) return
    // The first pass is the takeover and is refusable; every pass after it is
    // the roving cursor moving, which must always follow — by then the keyboard
    // is already in this list, and not moving it would strand the `❯`.
    if (!mounted.current) {
      mounted.current = true
      if (!autoFocus || isTyping(document.activeElement)) return
    }
    refs.current[focused]?.focus()
  }, [active, focused, autoFocus])

  const move = (delta: number) => {
    if (options.length > 0) onFocus((focused + delta + options.length) % options.length)
  }

  return (
    <div
      role='group'
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
        // Digits are the whole point of numbering the rows — but only as far as
        // the rows that exist, so `9` on a three-option prompt stays a no-op
        // rather than a silent miss.
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
          <div key={option.key}>
            <button
              ref={(element) => {
                refs.current[index] = element
              }}
              type='button'
              tabIndex={isFocused ? 0 : -1}
              aria-pressed={option.checked}
              onFocus={() => onFocus(index)}
              onClick={() => onChoose(index)}
              className='term-press'>
              {/* `❯ 1.` is the gutter: marker and number together, so the label
                  starts on one column whether or not the row is focused. */}
              <Row
                columns={5}
                glyph={`${isFocused ? '❯' : ' '} ${index + 1}.`}
                glyphTone={isFocused ? 'fg' : 'faint'}
                tone={option.danger ? 'red' : option.selected ? 'green' : 'fg'}
                data-focused={isFocused ? '' : undefined}>
                {option.checked !== undefined ? (
                  <Ink tone={option.checked ? 'green' : 'faint'}>
                    {MARKERS[option.marker ?? 'check'][option.checked ? 1 : 0]}{' '}
                  </Ink>
                ) : null}
                <Ink bold={isFocused || option.selected}>{option.label}</Ink>
              </Row>
            </button>
            {option.description ? (
              <Row columns={5} tone='dim'>
                {option.description}
              </Row>
            ) : null}
            {option.detail ? <div className='term-detail'>{option.detail}</div> : null}
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
    <Row columns={5} glyph='   ›' glyphTone='dim'>
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
        className='term-input'
      />
    </Row>
  )
}

/**
 * The question strip: one chip per question plus the submit step, with the
 * active one filled.
 *
 * It exists because the CLI asks **one question at a time**, and a form that
 * hides two of its three questions has to say so — otherwise answering the first
 * looks like finishing. The arrows are not controls, they are the legend for
 * `Tab`/`Shift+Tab`, which is what actually moves between them.
 */
export function TabStrip({
  tabs,
  active,
  onSelect,
}: {
  /** `glyph` rather than a derived done/not-done mark: the submit step is always
   * a `✓` (it is the act of finishing, not a thing to answer), and deriving it
   * would make it a hollow box until every question was done. */
  tabs: { key: string; label: string; glyph: string }[]
  active: number
  onSelect: (index: number) => void
}) {
  return (
    <Row glyph='←' glyphTone='faint'>
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          type='button'
          tabIndex={-1}
          onClick={() => onSelect(index)}
          className={cn('term-tab', index === active && 'term-tab-active')}>
          {tab.glyph} {tab.label}
        </button>
      ))}
      <Ink tone='faint'> →</Ink>
    </Row>
  )
}

export { Blank }
