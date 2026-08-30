import { createContext, useContext, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * The things a terminal cannot do, and this can.
 *
 * The theme's whole discipline is that it renders like a CLI — but it is not a
 * CLI, and refusing every affordance a pointer makes possible would be cosplay
 * rather than design. A terminal cannot highlight the row under your cursor and
 * cannot put a copy button on a block of output; a web view can do both for free
 * and they are genuinely useful.
 *
 * The rule that keeps this honest is that **each one costs no layout**. A hover
 * fill is a background. An action button is an overlay at the row's right edge,
 * one line tall, absolutely positioned so it displaces nothing. Turn them all
 * off and every glyph is on exactly the same cell it was on — which is what
 * makes `off` a real option rather than a degraded mode, and why it is the mode
 * a host projecting to a real terminal would choose.
 *
 * Off by nothing in particular: both default **on**, because the surface these
 * render on is a browser and pretending otherwise helps nobody. A host that
 * wants the pure article passes `affordances={false}`.
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
 * A block that reveals its actions on hover.
 *
 * Wraps rather than decorates because the actions belong to the *block* — a
 * message is many rows and its copy button belongs at the top right of all of
 * them, not on whichever row the pointer happens to be over.
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
 * Copy, as a character.
 *
 * `⧉` and `✓` rather than an SVG for the same reason the rest of the theme uses
 * glyphs: an icon drawn at some other size sits between the cells everything
 * else is on, and reads as a button borrowed from another application. The tick
 * replaces the glyph in place, so the confirmation costs no width either.
 */
/**
 * Open a sub-agent's own surface, as a character.
 *
 * A row **action** and not the row's press, because the press already means
 * expand/collapse and that is the cheaper, more common intent — a reader
 * glancing at what an agent did wants the four rows inline, not a new screen.
 * Taking over the panel is the deliberate move, so it gets the deliberate
 * target. Same zero-layout contract as `CopyAction`: it lives in the hover
 * actions overlay, so a collapsed Task row is exactly as tall with it as
 * without, which is what keeps the height book honest.
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

export function CopyAction({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="term-action"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The row underneath is usually pressable (a tool call expands); copying
        // is not expanding.
        event.stopPropagation()
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
          // No toast, no error row: a refused clipboard (an insecure origin, a
          // denied permission) is the host's business, and a failed copy that
          // says nothing is better than a transcript that grows an error.
          .catch(() => {})
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}
