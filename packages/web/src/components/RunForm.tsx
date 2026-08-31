import { useEffect, useId, useMemo, useState } from 'react'
import type { CreateSessionRequest, PermissionMode, SessionInfo } from '@workerdeck/protocol'
import {
  Input,
  PermissionModeSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@workerdeck/ui'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { ProfileSelect } from '@/components/ProfileSelect.tsx'
import { client } from '@/lib/client.ts'
import { engineFormOptions } from '@/lib/engine.ts'
import { type DefaultsKind } from '@/lib/settings.ts'
import { useProfileChoice } from '@/hooks/useProfiles.ts'

const CWD_KEY = 'workerdeck.last-cwd'

function useCwdCandidates(sessions: SessionInfo[]): string[] {
  const [roots, setRoots] = useState<string[]>([])
  useEffect(() => {
    client()
      ?.listHostRoots()
      .then((r) => setRoots(r.roots.map((root) => root.path)))
      // A gateway serving no host files is the normal case, and the field still takes a typed path.
      .catch(() => setRoots([]))
  }, [])
  return useMemo(() => {
    const last = localStorage.getItem(CWD_KEY)
    const ordered = [
      ...(last ? [last] : []),
      ...[...sessions].sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt)).map((s) => s.cwd),
      ...roots,
    ]
    return [...new Set(ordered)].slice(0, 12)
  }, [sessions, roots])
}

// Deliberately not configurable: an unattended job that stops at every file write has not run.
const MODE_FALLBACK: Record<DefaultsKind, PermissionMode> = {
  session: 'default',
  job: 'acceptEdits',
}

export type RunForm = ReturnType<typeof useRunForm>

export function useRunForm(kind: DefaultsKind) {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) ?? '')
  const [prompt, setPrompt] = useState('')
  // Empty means "whatever the profile says": the gateway fills any omitted field from `ProfileInfo.defaults`.
  const [model, setModel] = useState('')
  const [modeChoice, setModeChoice] = useState<PermissionMode | undefined>(undefined)
  const [effort, setEffort] = useState('')
  const { profiles, profile, selected, select: selectProfile } = useProfileChoice()
  const mode = modeChoice ?? selected?.defaults?.permissionMode ?? MODE_FALLBACK[kind]
  const engine = engineFormOptions(selected, mode, model)

  // `allowBypass` is the caller's: an interactive session pre-authorizes `bypassPermissions` because the CLI refuses
  // the switch mid-session, while a job makes it an opt-in.
  const sessionFields = (options: { prompt?: string; resume?: string; allowBypass?: boolean }): CreateSessionRequest => ({
    // Omitted for an engine with no host filesystem, which would otherwise drag a never-opened path through `allowedCwdRoots`.
    cwd: engine.capabilities.hostCwd === false ? undefined : cwd.trim(),
    profile: profile || undefined,
    prompt: options.prompt,
    permissionMode: engine.mode,
    model: engine.model.trim() || undefined,
    resume: options.resume,
    // Only a value the current model offers: a sticky choice from another profile must not 400.
    reasoningEffort: effort && engine.reasoningEfforts.includes(effort) ? effort : undefined,
    ...(engine.capabilities.settingSources
      ? {
          settingSources: ['user' as const, 'project' as const],
          allowDangerouslySkipPermissions: options.allowBypass || undefined,
        }
      : {}),
  })

  const rememberCwd = (used: string) => localStorage.setItem(CWD_KEY, cwd.trim() || used)

  return {
    cwd,
    setCwd,
    prompt,
    setPrompt,
    mode: engine.mode,
    setMode: setModeChoice as (mode: PermissionMode) => void,
    model,
    setModel,
    effort,
    setEffort,
    profiles,
    profile,
    selectProfile,
    engine,
    sessionFields,
    rememberCwd,
  }
}

export interface RunFormFieldsProps {
  form: RunForm
  sessions: SessionInfo[]
  promptLabel: string
  promptPlaceholder?: string
  extras?: React.ReactNode
  actions?: React.ReactNode
  onProfileChange?: (name: string) => void
}

export function RunFormFields({
  form,
  sessions,
  promptLabel,
  promptPlaceholder = 'e.g. /verify-content 42, or a task description',
  extras,
  actions,
  onProfileChange,
}: RunFormFieldsProps) {
  const candidates = useCwdCandidates(sessions)
  const listId = useId()
  const { engine } = form

  return (
    <>
      {engine.capabilities.hostCwd !== false && (
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-fg-3">Working directory</span>
          <Input
            value={form.cwd}
            list={listId}
            onChange={(e) => form.setCwd(e.target.value)}
            placeholder="/path/to/project"
            spellCheck={false}
            className="font-mono"
          />
          <datalist id={listId}>
            {candidates.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-label font-medium text-fg-3">{promptLabel}</span>
        <Textarea value={form.prompt} onChange={(e) => form.setPrompt(e.target.value)} rows={2} placeholder={promptPlaceholder} />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <ProfileSelect
          profiles={form.profiles}
          value={form.profile}
          onChange={(name) => {
            form.selectProfile(name)
            onProfileChange?.(name)
          }}
          className="min-w-32"
        />
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-label font-medium text-fg-3">Permission mode</span>
          <PermissionModeSelect variant="form" mode={engine.mode} onModeChange={form.setMode} modes={engine.modes} className="min-w-44" />
        </label>
        {extras}
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-label font-medium text-fg-3">Model</span>
          <ModelPicker value={engine.model} onChange={form.setModel} models={engine.models} className="min-w-40" />
        </label>
        {engine.reasoningEfforts.length > 0 ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-label font-medium text-fg-3">Effort</span>
            <Select
              items={[{ value: 'default', label: 'Default' }, ...engine.reasoningEfforts.map((e) => ({ value: e, label: e }))]}
              value={form.effort || 'default'}
              onValueChange={(value) => form.setEffort(value === 'default' ? '' : String(value))}
            >
              <SelectTrigger className="min-w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['default', ...engine.reasoningEfforts].map((e) => (
                  <SelectItem key={e} value={e}>
                    <SelectItemText>{e}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {actions}
      </div>
    </>
  )
}
