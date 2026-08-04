import type { ModelOption } from '@workerdeck/protocol'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export interface ModelSelectProps {
  /** Models the session can switch to (TranscriptState.models). */
  models: ModelOption[]
  /** The session's current model id (TranscriptState.model), possibly decorated
   * (e.g. "claude-fable-5[1m]") — matched leniently against the options.
   * `undefined` selects the list's default row, if it has one. */
  model?: string
  /** `undefined` = back to the CLI's default model. */
  onModelChange: (model?: string) => void
  /** 'toolbar' (default) is the composer's compact borderless trigger;
   * 'form' is a standard field-sized Select for create/settings forms. */
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

/** The CLI's supportedModels list leads with a "Default (recommended)" row whose value
 * is a sentinel, not a model id — selecting it means "clear the override". */
const isDefaultOption = (value: string) => value === 'default'

/** Find the option matching a (possibly decorated/aliased) session model id. */
function matchModel(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) return undefined
  const normalized = model.replace(/\[.*\]$/, '')
  const concrete = models.filter((m) => !isDefaultOption(m.value))
  return (
    concrete.find((m) => m.value === normalized) ??
    concrete.find((m) => normalized.includes(m.value) || m.value.includes(normalized))
  )
}

/** Compact model switcher for the composer toolbar; fed by the `capabilities` event.
 * Rows render CLI-style: bold display name with the model's description beneath. */
export function ModelSelect({
  models,
  model,
  onModelChange,
  variant = 'toolbar',
  disabled,
  className,
}: ModelSelectProps) {
  const selected =
    matchModel(models, model) ?? (model ? undefined : models.find((m) => isDefaultOption(m.value)))
  return (
    <Select
      items={models.map((m) => ({ value: m.value, label: m.displayName }))}
      value={selected?.value ?? null}
      onValueChange={(value) => {
        if (typeof value !== 'string' || value === selected?.value) return
        onModelChange(isDefaultOption(value) ? undefined : value)
      }}
      disabled={disabled}>
      <SelectTrigger
        aria-label='Model'
        className={cn(
          variant === 'toolbar' &&
            'h-6 max-w-56 border-transparent bg-transparent text-fg-3 hover:bg-surface-hover',
          className,
        )}>
        <span className={cn('truncate', variant === 'toolbar' && 'font-mono text-label')}>
          <SelectValue placeholder={model ?? 'model'} />
        </span>
      </SelectTrigger>
      <SelectContent className='min-w-72'>
        {models.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <SelectItemText>
              <span className='font-medium'>{m.displayName}</span>
            </SelectItemText>
            {m.description ? <span className='text-label text-fg-4'>{m.description}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
