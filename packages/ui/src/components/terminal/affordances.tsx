import { createContext, useContext, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * The pointer affordances a real terminal cannot have. The rule that keeps
 * them honest: **each one costs no layout** — a hover fill is a background, an
 * action button an absolutely positioned overlay — so turning them all off
 * (`affordances={false}`) moves no glyph. Both default on.
 */
export type TerminalAffordances = {
  /** Fill the row under the pointer, on anything pressable. */
  hover?: boolean
  /** Reveal a row's actions (copy, and whatever a row adds) on hover or focus. */
  actions?: boolean
}

const DEFAULTS: Required<TerminalAffordances> = { hover: true, actions: true }

const AffordanceContext = createContext<Required<TerminalAffordances>>(DEFAULTS)

export function useAffordances(): Required<TerminalAffordances> {
  return useContext(AffordanceContext)
}

/** Resolve the surface's prop — `false` means none, `true`/absent means all. */
export function resolveAffordances(value: TerminalAffordances | boolean | undefined): Required<TerminalAffordances> {
  if (value === false) {
    return { hover: false, actions: false }
  }
  if (value === true || value === undefined) {
    return DEFAULTS
  }
  return { ...DEFAULTS, ...value }
}

export function AffordanceProvider({ value, children }: { value: Required<TerminalAffordances>; children: ReactNode }) {
  return <AffordanceContext.Provider value={value}>{children}</AffordanceContext.Provider>
}

/**
 * A block that reveals its actions on hover. Wraps rather than decorates: the
 * actions belong to the block, not to whichever row the pointer is over.
 */
export function WithActions({ actions, children, className }: { actions: ReactNode; children: ReactNode; className?: string }) {
  const { actions: enabled } = useAffordances()
  if (!enabled) {
    return <>{children}</>
  }
  return (
    <div className={cn('term-hoverable', className)}>
      {children}
      <div className="term-actions">{actions}</div>
    </div>
  )
}

/**
 * Open a sub-agent's own surface. A row *action*, not the row's press — the
 * press already means expand/collapse. Lives in the hover overlay, so a
 * collapsed Task row is exactly as tall with it as without, which keeps the
 * height book honest.
 */
export function OpenSubagentAction({ onOpen, label = 'Open sub-agent' }: { onOpen: () => void; label?: string }) {
  return (
    <button
      type="button"
      className="term-action"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The row underneath expands; opening is not expanding.
        event.stopPropagation()
        onOpen()
      }}
    >
      ⤢
    </button>
  )
}

/** Copy as a glyph, not an SVG: `✓` replaces `⧉` in place, so the confirmation costs no width. */
export function CopyAction({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="term-action"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The row underneath is usually pressable; copying is not expanding.
        event.stopPropagation()
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
          // No toast, no error row: a failed copy that says nothing is better
          // than a transcript that grows an error.
          .catch(() => {})
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}
