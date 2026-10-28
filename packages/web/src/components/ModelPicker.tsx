import type { ModelOption } from '@workerdeck/protocol'
import { ModelSelect } from '@workerdeck/ui'

export function ModelPicker({
  value,
  onChange,
  models,
  defaultModel,
  className,
}: {
  value: string
  onChange: (value: string) => void
  models: ModelOption[]
  defaultModel?: string
  className?: string
}) {
  return (
    <ModelSelect
      variant="form"
      models={models}
      defaultModel={defaultModel}
      model={value || undefined}
      onModelChange={onChange}
      className={className}
    />
  )
}
