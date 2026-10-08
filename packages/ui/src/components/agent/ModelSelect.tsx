import { useRef, useState } from 'react'
import { modelMenu, type ModelOption } from '@workerdeck/protocol'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export interface ModelSelectProps {
  models: ModelOption[]
  model?: string
  defaultModel?: string
  onModelChange: (model?: string) => void
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

function isDefaultOption(value: string) {
  return value === 'default'
}

function dropVariant(id: string) {
  return id.replace(/\[.*\]$/, '')
}

function family(id: string): string {
  const parts = id.toLowerCase().split('-')
  if (parts[0] === 'claude') {
    parts.shift()
  }
  return parts[0] ?? ''
}

function optionMatches(option: ModelOption, model: string): boolean {
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

export function matchModel(models: readonly ModelOption[], model?: string): ModelOption | undefined {
  if (!model) {
    return undefined
  }
  return models.filter((m) => !isDefaultOption(m.value)).find((m) => optionMatches(m, model))
}

const MORE = '\u0000more'

export function ModelSelect({ models, model, defaultModel, onModelChange, variant = 'toolbar', disabled, className }: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const keepOpen = useRef(false)
  const menu = modelMenu(models, defaultModel)
  const sentinel = menu.defaultRow ? undefined : models.find((m) => isDefaultOption(m.value))
  const selected = matchModel(menu.more, model) ?? (model ? undefined : (menu.defaultRow ?? sentinel))
  const main = [...menu.main, ...(sentinel ? [sentinel] : [])]
  if (selected && !main.includes(selected)) {
    main.push(selected)
  }
  const rows = expanded ? [...menu.more, ...(sentinel ? [sentinel] : [])] : main
  const hasMore = !expanded && menu.more.some((m) => !main.includes(m))
  const choose = (value: string) => {
    if (value === MORE) {
      keepOpen.current = true
      setExpanded(true)
      return
    }
    const row = models.find((m) => m.value === value)
    if (!row || row === selected) {
      return
    }
    onModelChange(isDefaultOption(value) || row === menu.defaultRow ? undefined : value)
  }
  return (
    <Select
      items={models.map((m) => ({ value: m.value, label: m.displayName }))}
      value={selected?.value ?? null}
      open={open}
      onOpenChange={(next) => {
        if (!next && keepOpen.current) {
          keepOpen.current = false
          return
        }
        if (next) {
          setExpanded(false)
        }
        setOpen(next)
      }}
      onValueChange={(value) => {
        if (typeof value === 'string') {
          choose(value)
        }
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
        {rows.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <span className="flex items-baseline gap-1.5">
              <SelectItemText>
                <span className="font-medium">{m.displayName}</span>
              </SelectItemText>
              {m === menu.defaultRow ? <span className="text-label text-fg-4">default</span> : null}
            </span>
            {m.description ? <span className="text-label text-fg-4">{m.description}</span> : null}
          </SelectItem>
        ))}
        {hasMore ? (
          <SelectItem key={MORE} value={MORE} className="mt-1 border-t border-border pt-2">
            <span className="text-fg-3">More models ({menu.more.length})</span>
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}
