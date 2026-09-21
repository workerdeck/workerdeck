import { Check, ChevronDown } from 'lucide-react'
import type { SubagentDisplay } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.tsx'
import { cn } from '../../lib/utils.ts'

export const SUBAGENT_DISPLAY_ORDER: readonly SubagentDisplay[] = ['all', 'active', 'none']

export const SUBAGENT_DISPLAY_META: Record<SubagentDisplay, { label: string; hint: string }> = {
  all: { label: 'All sub-agents', hint: 'Showing every sub-agent' },
  active: { label: 'Hide completed', hint: 'Showing running and failed sub-agents' },
  none: { label: 'Hide sub-agents', hint: 'Sub-agents hidden' },
}

const HIDDEN_ROW = 0.34

// A session line at full strength over two child rows, and a hidden child is greyed rather than
// struck: a sub-agent the card is not drawing has not failed, and a cross would say it had.
export function SubagentDisplayIcon({ value, className }: { value: SubagentDisplay; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 5h18" />
      <path d="M9 12h12" opacity={value === 'none' ? HIDDEN_ROW : 1} />
      <path d="M9 19h12" opacity={value === 'all' ? 1 : HIDDEN_ROW} />
    </svg>
  )
}

export type SubagentToggleProps = {
  value: SubagentDisplay
  onChange: (value: SubagentDisplay) => void
  className?: string
}

// A menu rather than a press-to-cycle button: three stops are one more than a person can read off
// a single glyph, and the caret is what promises the other two.
export function SubagentToggle({ value, onChange, className }: SubagentToggleProps) {
  const meta = SUBAGENT_DISPLAY_META[value]
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Sub-agents: ${meta.label}`} title={meta.hint} className={cn('w-9 gap-0.5', className)}>
            <SubagentDisplayIcon value={value} className="size-4" />
            <ChevronDown className="size-2.5 text-fg-4" />
          </Button>
        }
      />
      <MenuContent className="min-w-44">
        {SUBAGENT_DISPLAY_ORDER.map((option) => (
          <MenuItem key={option} onClick={() => onChange(option)}>
            <SubagentDisplayIcon value={option} className="size-4 shrink-0 text-fg-3" />
            <span className="flex-1">{SUBAGENT_DISPLAY_META[option].label}</span>
            {option === value ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
