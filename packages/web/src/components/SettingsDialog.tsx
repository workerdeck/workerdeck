import { useState } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  PermissionModeSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@workerdeck/ui'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { ThemeToggle } from './shell/ThemeToggle.tsx'
import {
  getDefaultModel,
  getDefaultPermissionMode,
  setDefaultModel,
  setDefaultPermissionMode,
  getTranscriptDensity,
  getTranscriptVariant,
  setTranscriptDensity,
  setTranscriptVariant,
  type DefaultsKind,
  type TranscriptDensity,
  type TranscriptVariant,
} from '@/lib/settings.ts'

function DefaultsRow({ kind, label }: { kind: DefaultsKind; label: string }) {
  const [model, setModel] = useState(() => getDefaultModel(kind))
  const [mode, setMode] = useState(() => getDefaultPermissionMode(kind))
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-3 gap-y-2'>
      <span className='text-body-sm text-fg-2'>{label}</span>
      <div className='flex flex-wrap items-center gap-2'>
        <PermissionModeSelect
          variant='form'
          mode={mode}
          onModeChange={(value) => {
            setMode(value)
            setDefaultPermissionMode(kind, value)
          }}
          className='min-w-40'
        />
        <ModelPicker
          value={model}
          onChange={(value) => {
            setModel(value)
            setDefaultModel(kind, value)
          }}
          className='min-w-44'
        />
      </div>
    </div>
  )
}

/** The density preference. Read on open rather than applied live: the panel
 * stamps it at mount, and re-rendering a mounted transcript under a reader to
 * reflect a settings change made elsewhere is not worth the jump. */
function DensitySelect() {
  const [density, setDensity] = useState<TranscriptDensity>(getTranscriptDensity)
  const options: { value: TranscriptDensity; label: string }[] = [
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' },
  ]
  return (
    <Select
      value={density}
      onValueChange={(value) => {
        const next = value as TranscriptDensity
        setDensity(next)
        setTranscriptDensity(next)
      }}>
      <SelectTrigger aria-label='Transcript density' className='min-w-40'>
        <SelectValue>{options.find((o) => o.value === density)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <SelectItemText>{option.label}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The variant preference. Read on open, like density: the transcript stamps it
 * at mount, and reshaping every row under a reader to reflect a change made on
 * another screen is not worth the jump. */
function VariantSelect() {
  const [variant, setVariant] = useState<TranscriptVariant>(getTranscriptVariant)
  const options: { value: TranscriptVariant; label: string }[] = [
    { value: 'cards', label: 'Cards' },
    { value: 'lines', label: 'Lines' },
  ]
  return (
    <Select
      value={variant}
      onValueChange={(value) => {
        const next = value as TranscriptVariant
        setVariant(next)
        setTranscriptVariant(next)
      }}>
      <SelectTrigger aria-label='Transcript style' className='min-w-40'>
        <SelectValue>{options.find((o) => o.value === variant)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <SelectItemText>{option.label}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Settings as a dialog rather than a destination.
 *
 * These are client-side preferences — theme, transcript shape, the defaults the
 * create forms pre-fill — and none of them is somewhere you *work*. A nav entry
 * that replaced the sidebar and the detail pane to show four rows of selects was
 * spending the whole window on a preference sheet; a modal returns you to what
 * you were doing when you close it, which is the only thing anyone wants from
 * this screen.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='lg'>
        <DialogHeader
          title='Settings'
          description='Client-side preferences. Server policy (auth, cwd roots, API-key requirements) is configured where the worker runs.'
        />
        <DialogBody>
      <div className='flex flex-col gap-4'>
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-3'>
            <div className='flex items-center justify-between'>
              <span className='text-body-sm text-fg-2'>Theme</span>
              <ThemeToggle />
            </div>
            <div className='flex items-center justify-between'>
              <span className='text-body-sm text-fg-2'>Transcript style</span>
              <VariantSelect />
            </div>
            <div className='flex items-center justify-between'>
              <span className='text-body-sm text-fg-2'>Transcript density</span>
              <DensitySelect />
            </div>
            <p className='text-label text-fg-4'>
              Cards is the chat shape; Lines is the terminal one — full-width rows behind a gutter
              glyph, no boxes. Comfortable leaves a blank line between messages, the way the CLI
              does; Compact fits more of a long session on screen. Both take effect on the next
              session you open.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Defaults</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-3'>
            <DefaultsRow kind='session' label='New session' />
            <DefaultsRow kind='job' label='Queue job' />
            <p className='text-label text-fg-4'>
              Pre-fills the permission mode and model on the new-session and schedule-job forms
              (still editable per run). &quot;Default (recommended)&quot; leaves the model to the
              CLI. This list is the Claude aliases, so a profile running another engine will fall
              back to its own default rather than the choice made here.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worker server</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-1 text-body-sm text-fg-2'>
            <div>
              Endpoint: <code className='font-mono text-code'>{location.origin}/v1</code> (dev
              proxy → <code className='font-mono text-code'>WORKER_URL</code>, default{' '}
              <code className='font-mono text-code'>http://127.0.0.1:8787</code>)
            </div>
            <div className='text-label text-fg-4'>
              Anthropic credentials are resolved by the SDK from the server operator’s
              environment — this app never handles them.
            </div>
          </CardContent>
        </Card>
      </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
