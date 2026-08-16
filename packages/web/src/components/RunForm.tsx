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

/**
 * The half of a run that a session and a queue job describe identically: where
 * it runs, what to do, and which engine settings it starts with.
 *
 * It was two copies, and they had already drifted — different placement, and one
 * silently pre-authorizing `bypassPermissions` where the other made it a
 * checkbox. That difference is real and deliberate (an interactive operator is
 * present; an unattended job's operator is not), so it stays a *parameter* here
 * rather than being flattened away. What must not differ — how a cwd is
 * remembered, how a sticky model is reconciled against the chosen profile, which
 * controls a capability record hides — is what this owns.
 */
const CWD_KEY = 'workerdeck.last-cwd'

/**
 * Where a run's directory can plausibly be, best first: the one used last, then
 * the directories sessions are already running in, then the gateway's own roots.
 *
 * The roots are authoritative and the only source that works on a fresh install
 * with no sessions, but they are also the least specific, so they come last.
 * Offered as a datalist rather than a modal browser: the field stays typeable,
 * which is what someone who knows the path actually wants.
 */
function useCwdCandidates(sessions: SessionInfo[]): string[] {
  const [roots, setRoots] = useState<string[]>([])
  useEffect(() => {
    client()
      ?.listHostRoots()
      .then((r) => setRoots(r.roots.map((root) => root.path)))
      // A gateway serving no host files is the normal case, not an error — the
      // field still takes a typed path.
      .catch(() => setRoots([]))
  }, [])
  return useMemo(() => {
    const last = localStorage.getItem(CWD_KEY)
    const ordered = [
      ...(last ? [last] : []),
      ...[...sessions]
        .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
        .map((s) => s.cwd),
      ...roots,
    ]
    return [...new Set(ordered)].slice(0, 12)
  }, [sessions, roots])
}

/**
 * Where the permission mode lands when neither the run nor its profile says.
 *
 * Not a preference and not configurable — the one thing that genuinely differs
 * between the two forms. An operator is watching an interactive session, so it
 * asks; an unattended job that stops at every file write has not run, so it
 * accepts edits. A profile default overrides both.
 */
const MODE_FALLBACK: Record<DefaultsKind, PermissionMode> = {
  session: 'default',
  job: 'acceptEdits',
}

export type RunForm = ReturnType<typeof useRunForm>

export function useRunForm(kind: DefaultsKind) {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) ?? '')
  const [prompt, setPrompt] = useState('')
  // Empty means "whatever the profile says": the gateway fills `model` and
  // `permissionMode` from `ProfileInfo.defaults` for any field the request
  // leaves out, so an unset picker is a real choice rather than a missing one.
  const [model, setModel] = useState('')
  const [modeChoice, setModeChoice] = useState<PermissionMode | undefined>(undefined)
  const [effort, setEffort] = useState('')
  const { profiles, profile, selected, select: selectProfile } = useProfileChoice()
  // What the mode select shows, most specific first: this run's own pick, then
  // the profile's default, then the per-kind fallback. The fallback is not a
  // preference — an unattended job that stops at every file write has not run,
  // so it accepts edits unless something above it says otherwise.
  const mode = modeChoice ?? selected?.defaults?.permissionMode ?? MODE_FALLBACK[kind]
  const engine = engineFormOptions(selected, mode, model)

  /**
   * The engine-shaped half of a `CreateSessionRequest`.
   *
   * `allowBypass` is the caller's call, not this hook's: an interactive session
   * pre-authorizes `bypassPermissions` because the operator is present and the
   * CLI refuses the switch mid-session otherwise, while an unattended job makes
   * it an explicit opt-in.
   */
  const sessionFields = (options: {
    prompt?: string
    resume?: string
    allowBypass?: boolean
  }): CreateSessionRequest => ({
    // Omitted entirely for an engine with no host filesystem: the gateway takes
    // no cwd there, and sending one would put a path on a session that never
    // opens a directory (and drag it through `allowedCwdRoots` for nothing).
    cwd: engine.capabilities.hostCwd === false ? undefined : cwd.trim(),
    profile: profile || undefined,
    prompt: options.prompt,
    permissionMode: engine.mode,
    model: engine.model.trim() || undefined,
    resume: options.resume,
    // Only when the engine takes one, and only a value the current model offers
    // — a sticky choice from another profile must not 400 here.
    reasoningEffort: effort && engine.reasoningEfforts.includes(effort) ? effort : undefined,
    ...(engine.capabilities.settingSources
      ? {
          settingSources: ['user' as const, 'project' as const],
          allowDangerouslySkipPermissions: options.allowBypass || undefined,
        }
      : {}),
  })

  /** Remember the directory a run actually used, for the next form. */
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
  /** Live sessions, for the directory candidates. */
  sessions: SessionInfo[]
  promptLabel: string
  promptPlaceholder?: string
  /** Rendered inside the controls row, after the permission mode — where the
   * job form's Questions select goes. */
  extras?: React.ReactNode
  /** Rendered at the end of the controls row: the submit button. */
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
        <label className='flex flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Working directory</span>
          <Input
            value={form.cwd}
            list={listId}
            onChange={(e) => form.setCwd(e.target.value)}
            placeholder='/path/to/project'
            spellCheck={false}
            className='font-mono'
          />
          <datalist id={listId}>
            {candidates.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </label>
      )}
      <label className='flex flex-col gap-1'>
        <span className='text-label font-medium text-fg-3'>{promptLabel}</span>
        <Textarea
          value={form.prompt}
          onChange={(e) => form.setPrompt(e.target.value)}
          rows={2}
          placeholder={promptPlaceholder}
        />
      </label>
      <div className='flex flex-wrap items-end gap-3'>
        <ProfileSelect
          profiles={form.profiles}
          value={form.profile}
          onChange={(name) => {
            form.selectProfile(name)
            onProfileChange?.(name)
          }}
          className='min-w-32'
        />
        <label className='flex min-w-0 flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Permission mode</span>
          <PermissionModeSelect
            variant='form'
            mode={engine.mode}
            onModeChange={form.setMode}
            modes={engine.modes}
            className='min-w-44'
          />
        </label>
        {extras}
        <label className='flex min-w-0 flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Model</span>
          <ModelPicker
            value={engine.model}
            onChange={form.setModel}
            models={engine.models}
            className='min-w-40'
          />
        </label>
        {/* Present exactly when the record (or the chosen model's catalog row)
            declares efforts — never a control that does nothing. */}
        {engine.reasoningEfforts.length > 0 ? (
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Effort</span>
            <Select
              items={[
                { value: 'default', label: 'Default' },
                ...engine.reasoningEfforts.map((e) => ({ value: e, label: e })),
              ]}
              value={form.effort || 'default'}
              onValueChange={(value) => form.setEffort(value === 'default' ? '' : String(value))}>
              <SelectTrigger className='min-w-28'>
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
