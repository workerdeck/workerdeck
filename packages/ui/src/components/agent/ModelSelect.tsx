import type { ModelOption } from '@workerdeck/protocol'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export interface ModelSelectProps {
  models: ModelOption[]
  model?: string
  onModelChange: (model?: string) => void
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

const isDefaultOption = (value: string) => value === 'default'

const dropVariant = (id: string) => id.replace(/\[.*\]$/, '')

const family = (id: string): string => {
  const parts = id.toLowerCase().split('-')
  if (parts[0] === 'claude') {
    parts.shift()
  }
  return parts[0] ?? ''
}

const optionMatches = (option: ModelOption, model: string): boolean => {
  if (model === option.value || model === option.resolvedModel) {
    return true
  }
  const stripped = dropVariant(model)
  if (option.resolvedModel) {
    return stripped === dropVariant(option.resolvedModel)
  }
  const token = family(stripped)
  return token !== '' && token === family(dropVariant(option.value))
}

const matchModel = (models: ModelOption[], model?: string): ModelOption | undefined => {
  if (!model) {
    return undefined
  }
  return models.filter((m) => !isDefaultOption(m.value)).find((m) => optionMatches(m, model))
}

export function ModelSelect({ models, model, onModelChange, variant = 'toolbar', disabled, className }: ModelSelectProps) {
  const selected = matchModel(models, model) ?? (model ? undefined : models.find((m) => isDefaultOption(m.value)))
  return (
    <Select
      items={models.map((m) => ({ value: m.value, label: m.displayName }))}
      value={selected?.value ?? null}
      onValueChange={(value) => {
        if (typeof value !== 'string' || value === selected?.value) {
          return
        }
        onModelChange(isDefaultOption(value) ? undefined : value)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Model"
        className={cn(
          variant === 'toolbar' && 'h-6 max-w-56 border-transparent bg-transparent text-fg-3 hover:bg-surface-hover',
          className,
        )}
      >
        <span className={cn('truncate', variant === 'toolbar' && 'font-mono text-label')}>
          <SelectValue placeholder={model ?? 'model'} />
        </span>
      </SelectTrigger>
      <SelectContent className="min-w-72">
        {models.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <SelectItemText>
              <span className="font-medium">{m.displayName}</span>
            </SelectItemText>
            {m.description ? <span className="text-label text-fg-4">{m.description}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
