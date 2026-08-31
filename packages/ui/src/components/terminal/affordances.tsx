import { createContext, useContext, useState, type ReactNode } from 'react'
import { copyText } from '../../lib/clipboard.ts'
import { cn } from '../../lib/utils.ts'

export type TerminalAffordances = {
  hover?: boolean
  actions?: boolean
}

const DEFAULTS: Required<TerminalAffordances> = { hover: true, actions: true }

const AffordanceContext = createContext<Required<TerminalAffordances>>(DEFAULTS)

export function useAffordances(): Required<TerminalAffordances> {
  return useContext(AffordanceContext)
}

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

export function OpenSubagentAction({ onOpen, label = 'Open sub-agent' }: { onOpen: () => void; label?: string }) {
  return (
    <button
      type="button"
      className="term-action"
      title={label}
      aria-label={label}
      onClick={(event) => {
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
        event.stopPropagation()
        void copyText(text).then((ok) => {
          if (!ok) {
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}
