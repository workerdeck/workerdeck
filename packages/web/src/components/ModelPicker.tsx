import type { ModelOption } from '@workerdeck/protocol'
import { ModelSelect } from '@workerdeck/ui'
import { MODEL_OPTIONS } from '@/lib/settings.ts'

export function ModelPicker({
  value,
  onChange,
  models = MODEL_OPTIONS,
  defaultModel,
  className,
}: {
  value: string
  onChange: (value: string) => void
  models?: ModelOption[]
  defaultModel?: string
  className?: string
}) {
  return (
    <ModelSelect
      variant="form"
      models={models}
      defaultModel={defaultModel}
      model={value || undefined}
      onModelChange={(model) => onChange(model ?? '')}
      className={className}
    />
  )
}
