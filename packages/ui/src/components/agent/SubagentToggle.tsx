import { ListFilter, ListTree, ListX } from 'lucide-react'
import type { SubagentDisplay } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'

export const SUBAGENT_DISPLAY_ORDER: readonly SubagentDisplay[] = ['active', 'all', 'none']

export const SUBAGENT_DISPLAY_META: Record<SubagentDisplay, { label: string; hint: string }> = {
  all: { label: 'All sub-agents', hint: 'Showing every sub-agent' },
  active: { label: 'Hide completed', hint: 'Showing running and failed sub-agents' },
  none: { label: 'Hide sub-agents', hint: 'Sub-agents hidden' },
}

export function nextSubagentDisplay(value: SubagentDisplay): SubagentDisplay {
  const index = SUBAGENT_DISPLAY_ORDER.indexOf(value)
  return SUBAGENT_DISPLAY_ORDER[(index + 1) % SUBAGENT_DISPLAY_ORDER.length]!
}

export function SubagentDisplayIcon({ value, className }: { value: SubagentDisplay; className?: string }) {
  const Icon = value === 'all' ? ListTree : value === 'active' ? ListFilter : ListX
  return <Icon className={className} />
}

export type SubagentToggleProps = {
  value: SubagentDisplay
  onChange: (value: SubagentDisplay) => void
  className?: string
}

// One press advances to the next mode, so the icon is both the reading and the control.
export function SubagentToggle({ value, onChange, className }: SubagentToggleProps) {
  const meta = SUBAGENT_DISPLAY_META[value]
  const next = SUBAGENT_DISPLAY_META[nextSubagentDisplay(value)]
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Sub-agents: ${meta.label}`}
      title={`${meta.hint} · click for ${next.label.toLowerCase()}`}
      onClick={() => onChange(nextSubagentDisplay(value))}
      className={className}
    >
      <SubagentDisplayIcon value={value} className={cn('size-4', value === 'none' ? 'text-fg-4' : undefined)} />
    </Button>
  )
}
