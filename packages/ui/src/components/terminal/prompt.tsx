import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'
import { Blank, Ink, Row } from './row.tsx'

export function Rule({ dashed }: { dashed?: boolean }) {
  return <div className={cn('term-rule-row', dashed && 'term-rule-dashed')} aria-hidden />
}

export function Hint({ children }: { children: ReactNode }) {
  return <Row tone="faint">{children}</Row>
}

export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('term-box', className)}>{children}</div>
}

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
  description?: string
  checked?: boolean
  marker?: 'check' | 'radio'
  selected?: boolean
  danger?: boolean
  detail?: ReactNode
}

const MARKERS = {
  check: ['[ ]', '[✓]'],
  radio: ['( )', '(•)'],
} as const

export interface ChoicesProps {
  options: Choice[]
  focused: number
  onFocus: (index: number) => void
  onChoose: (index: number) => void
  active?: boolean
  autoFocus?: boolean
  label: string
}

function isTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  const editable = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable
  if (!editable) {
    return false
  }
  const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? '')
  return text.trim().length > 0
}

export function Choices({ options, focused, onFocus, onChoose, active = true, autoFocus = true, label }: ChoicesProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!active) {
      return
    }
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
            event.stopPropagation()
            onCancel()
          }
        }}
        className="term-input"
      />
    </Row>
  )
}

export function TabStrip({
  tabs,
  active,
  onSelect,
}: {
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
