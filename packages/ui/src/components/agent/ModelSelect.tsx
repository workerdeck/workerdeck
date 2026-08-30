import type { ModelOption } from '@workerdeck/protocol'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
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

/** Everything before a '[1m]'-style context-window suffix. */
const dropVariant = (id: string) => id.replace(/\[.*\]$/, '')

/** 'claude-opus-4-8' → "opus", 'sonnet' → "sonnet". The vendor prefix and the
 * version tail are dropped; what is left is the name a person would say. */
function family(id: string): string {
  const parts = id.toLowerCase().split('-')
  if (parts[0] === 'claude') {
    parts.shift()
  }
  return parts[0] ?? ''
}

/**
 * Whether a row is the one naming `model`.
 *
 * Three passes, narrowest first, because the rows and the id a session *reports*
 * are written differently: the rows are aliases ('opus[1m]', 'sonnet',
 * 'claude-fable-5[1m]') and a session reports a resolved wire id
 * ('claude-opus-5[1m]'). `resolvedModel` is the server's own answer to this and
 * wins when present; the family fallback covers a server that doesn't send it,
 * which is the difference between the chip reading "Opus 5" and reading
 * `claude-opus-5[1m]`. Kept identical to the iOS client's `ModelOption.matches`.
 */
function optionMatches(option: ModelOption, model: string): boolean {
  if (model === option.value || model === option.resolvedModel) {
    return true
  }
  const stripped = dropVariant(model)
  // A row that declares what it resolves to is *authoritative*, including when
  // it disagrees: two rows of the same family ("Opus 5" and "Opus 4.8") differ
  // only here, so falling through to the family would match both.
  if (option.resolvedModel) {
    return stripped === dropVariant(option.resolvedModel)
  }
  const token = family(stripped)
  return token !== '' && token === family(dropVariant(option.value))
}

/** Find the option matching a (possibly decorated/aliased) session model id. */
function matchModel(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) {
    return undefined
  }
  return models.filter((m) => !isDefaultOption(m.value)).find((m) => optionMatches(m, model))
}

/** Compact model switcher for the composer toolbar; fed by the `capabilities` event.
 * Rows render CLI-style: bold display name with the model's description beneath. */
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
