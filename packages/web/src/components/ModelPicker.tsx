import type { ModelOption } from '@workerdeck/protocol'
import { ModelSelect } from '@workerdeck/ui'
import { MODEL_OPTIONS } from '@/lib/settings.ts'

/** Form-styled model dropdown. '' = the engine's default model — the CLI's for a
 * Claude profile, the profile's declared one for a provider profile. `models`
 * defaults to the static Claude alias list. */
export function ModelPicker({
  value,
  onChange,
  models = MODEL_OPTIONS,
  className,
}: {
  value: string
  onChange: (value: string) => void
  models?: ModelOption[]
  className?: string
}) {
  return (
    <ModelSelect
      variant="form"
      models={models}
      model={value || undefined}
      onModelChange={(model) => onChange(model ?? '')}
      className={className}
    />
  )
}
