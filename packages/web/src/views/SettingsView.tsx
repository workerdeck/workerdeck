import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, PermissionModeSelect } from '@workerdeck/ui'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { ThemeToggle } from '@/components/shell/ThemeToggle.tsx'
import {
  getDefaultModel,
  getDefaultPermissionMode,
  setDefaultModel,
  setDefaultPermissionMode,
  type DefaultsKind,
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

export function SettingsView() {
  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6'>
        <header>
          <h1 className='text-display-sm font-semibold tracking-tight text-text'>Settings</h1>
          <p className='mt-0.5 text-body-sm text-muted-foreground'>
            Client-side preferences. Server policy (auth, cwd roots, API-key requirements) is
            configured where the worker runs.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent className='flex items-center justify-between'>
            <span className='text-body-sm text-fg-2'>Theme</span>
            <ThemeToggle />
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
              CLI.
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
    </div>
  )
}
