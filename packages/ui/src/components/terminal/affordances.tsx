import { Bot, BotOff, Check, Copy, Maximize2, SquareTerminal, Star, X, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { copyText } from '../../lib/clipboard.ts'
import { cn } from '../../lib/utils.ts'

export type TerminalAffordances = {
  hover?: boolean
  actions?: boolean
  labels?: boolean
}

const DEFAULTS: Required<TerminalAffordances> = { hover: true, actions: true, labels: false }

const AffordanceContext = createContext<Required<TerminalAffordances>>(DEFAULTS)

export function useAffordances(): Required<TerminalAffordances> {
  return useContext(AffordanceContext)
}

export function resolveAffordances(value: TerminalAffordances | boolean | undefined): Required<TerminalAffordances> {
  if (value === false) {
    return { hover: false, actions: false, labels: false }
  }
  if (value === true || value === undefined) {
    return DEFAULTS
  }
  return { ...DEFAULTS, ...value }
}

export function AffordanceProvider({ value, children }: { value: Required<TerminalAffordances>; children: ReactNode }) {
  return <AffordanceContext.Provider value={value}>{children}</AffordanceContext.Provider>
}

export type ActionPlacement = 'below' | 'inline'

const PlacementContext = createContext<ActionPlacement>('below')

export function ActionPlacementProvider({ value, children }: { value: ActionPlacement; children: ReactNode }) {
  return <PlacementContext.Provider value={value}>{children}</PlacementContext.Provider>
}

export function WithActions({
  actions,
  children,
  className,
  placement,
}: {
  actions: ReactNode
  children: ReactNode
  className?: string
  placement?: ActionPlacement
}) {
  const { actions: enabled } = useAffordances()
  const inherited = useContext(PlacementContext)
  if (!enabled) {
    return <>{children}</>
  }
  return (
    <div className={cn('term-hoverable', className)} data-placement={placement ?? inherited}>
      <PlacementContext.Provider value="below">{children}</PlacementContext.Provider>
      <div className="term-actions">{actions}</div>
    </div>
  )
}

type Tone = 'magenta' | 'yellow' | 'red' | 'danger'

function ActionButton({
  icon: Icon,
  word,
  label,
  tone,
  pressed,
  filled,
  onPress,
}: {
  icon: LucideIcon
  word: string
  label: string
  tone?: Tone
  pressed?: boolean
  filled?: boolean
  onPress: () => void
}) {
  const { labels } = useAffordances()
  return (
    <button
      type="button"
      className="term-action"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-tone={tone}
      onClick={(event) => {
        event.stopPropagation()
        onPress()
      }}
    >
      <Icon aria-hidden className="term-action-icon" fill={filled ? 'currentColor' : 'none'} />
      {labels ? <span className="term-action-word">{word}</span> : null}
    </button>
  )
}

// Bookmarks are a host concern (which items, where they persist); the transcript only needs
// membership and a toggle. A missing provider renders no action at all.
export type BookmarkHandle = {
  has: (itemId: string) => boolean
  toggle: (itemId: string) => void
}

const BookmarkContext = createContext<BookmarkHandle | undefined>(undefined)

export function BookmarkProvider({ value, children }: { value: BookmarkHandle | undefined; children: ReactNode }) {
  return <BookmarkContext.Provider value={value}>{children}</BookmarkContext.Provider>
}

export function BookmarkAction({ id }: { id: string }) {
  const handle = useContext(BookmarkContext)
  if (!handle) {
    return null
  }
  const active = handle.has(id)
  return (
    <ActionButton
      icon={Star}
      filled
      word={active ? 'bookmarked' : 'bookmark'}
      label={active ? 'Remove bookmark' : 'Bookmark'}
      tone={active ? 'yellow' : undefined}
      pressed={active}
      onPress={() => handle.toggle(id)}
    />
  )
}

export function OpenSubagentAction({ onOpen, label = 'Open sub-agent' }: { onOpen: () => void; label?: string }) {
  return <ActionButton icon={Maximize2} word="open" label={label} onPress={onOpen} />
}

export function OpenShellAction({ onOpen, label = 'Open terminal' }: { onOpen: () => void; label?: string }) {
  return <ActionButton icon={SquareTerminal} word="enter shell" label={label} tone="magenta" onPress={onOpen} />
}

export function KillShellAction({ onKill, label = 'Kill this shell' }: { onKill: () => void; label?: string }) {
  return <ActionButton icon={X} word="kill" label={label} tone="danger" onPress={onKill} />
}

export function AgentWriteAction({ granted, label, onToggle }: { granted: boolean; label: string; onToggle: () => void }) {
  return (
    <ActionButton
      icon={granted ? Bot : BotOff}
      word={granted ? 'agent can type' : 'agent read-only'}
      label={label}
      tone={granted ? 'yellow' : undefined}
      pressed={granted}
      onPress={onToggle}
    />
  )
}

export function CopyAction({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <ActionButton
      icon={copied ? Check : Copy}
      word={copied ? 'copied' : 'copy'}
      label={label}
      onPress={() => {
        void copyText(text).then((ok) => {
          if (!ok) {
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    />
  )
}

export function AgentWriteIcon({ granted, className }: { granted: boolean; className?: string }) {
  const Icon = granted ? Bot : BotOff
  return <Icon aria-hidden className={className} />
}
