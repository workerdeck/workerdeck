import type { EngineCapabilities, ModelOption } from '@workerdeck/protocol'
import { Brain } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'
import { matchModel } from './ModelSelect.tsx'

const DEFAULT_VALUE = 'default'

export function effortChoices(
  models: readonly ModelOption[],
  model: string | undefined,
  capabilities: Pick<EngineCapabilities, 'reasoningEfforts'>,
): readonly string[] {
  return matchModel(models, model)?.reasoningEfforts ?? capabilities.reasoningEfforts ?? []
}

export interface EffortSelectProps {
  efforts: readonly string[]
  effort?: string | null
  onEffortChange: (effort?: string) => void
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

export function EffortSelect({ efforts, effort, onEffortChange, variant = 'toolbar', disabled, className }: EffortSelectProps) {
  const items = [{ value: DEFAULT_VALUE, label: 'Default' }, ...efforts.map((value) => ({ value, label: value }))]
  return (
    <Select
      items={items}
      value={effort ?? null}
      onValueChange={(value) => {
        if (typeof value !== 'string' || value === effort) {
          return
        }
        onEffortChange(value === DEFAULT_VALUE ? undefined : value)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Reasoning effort"
        className={cn(
          variant === 'toolbar' && 'h-6 max-w-32 border-transparent bg-transparent text-fg-3 hover:bg-surface-hover',
          className,
        )}
      >
        <span className={cn('flex items-center gap-1 truncate', variant === 'toolbar' && 'font-mono text-label')}>
          <Brain className="size-3 shrink-0" />
          <SelectValue placeholder="effort" />
        </span>
      </SelectTrigger>
      <SelectContent className="min-w-40">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <SelectItemText>
              <span className="font-medium">{item.label}</span>
            </SelectItemText>
            {item.value === DEFAULT_VALUE ? <span className="text-label text-fg-4">The model's configured default</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
