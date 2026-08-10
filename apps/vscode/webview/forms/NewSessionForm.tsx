import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { ENGINE_CAPABILITIES, type ProfileInfo, type SdkSessionSummary } from '@workerdeck/protocol'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  formatRelativeTime,
} from '@workerdeck/ui'
import { History } from 'lucide-react'
import type { WireHost } from '../../src/bridge-protocol.ts'
import type { Bridge } from '../bridge.ts'

/**
 * The new-session flow: gateway → profile (fetched live through the bridged
 * client, availability-aware) → cwd → optional first prompt. Creates the
 * session ITSELF over REST — the bridge injects the gateway's credentials host
 * side — and hands the id up via onCreated; errors stay inline.
 *
 * The same form resumes: an engine with a browsable session store lists what is
 * on disk for the chosen directory, and picking one creates a session that
 * continues that engine session instead of a fresh one. Same route, one flag
 * (`resume`) — which is why it is here and not a screen of its own.
 */
export function NewSessionForm({
  bridge,
  hosts,
  preselectedHostId,
  onCreated,
  onCancel,
}: {
  bridge: Bridge
  hosts: WireHost[]
  preselectedHostId: string | undefined
  onCreated: (hostId: string, sessionId: string) => void
  onCancel: () => void
}) {
  const [hostId, setHostId] = useState(preselectedHostId ?? hosts[0]?.id ?? '')
  const host = hosts.find((h) => h.id === hostId)
  const [cwd, setCwd] = useState(host?.cwdSuggestion ?? '')
  const [cwdTouched, setCwdTouched] = useState(false)
  const [profile, setProfile] = useState<string | undefined>(undefined)
  const [profiles, setProfiles] = useState<ProfileInfo[] | undefined>(undefined)
  const [profilesError, setProfilesError] = useState<string | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [stored, setStored] = useState<SdkSessionSummary[] | undefined>(undefined)
  const [loadingStored, setLoadingStored] = useState(false)

  const client = useMemo(
    () =>
      host
        ? new WorkerDeckClient({
            baseUrl: host.baseUrl,
            fetchImpl: bridge.fetch,
            WebSocketImpl: bridge.WebSocketImpl,
          })
        : undefined,
    [bridge, host?.baseUrl],
  )

  useEffect(() => {
    if (!cwdTouched) setCwd(host?.cwdSuggestion ?? '')
  }, [hostId])

  useEffect(() => {
    setProfiles(undefined)
    setProfilesError(undefined)
    setProfile(undefined)
    if (!client) return
    let stale = false
    client
      .listProfiles()
      .then(({ profiles }) => {
        if (stale) return
        setProfiles(profiles)
        // Single profile = implicit server-side; preselect the first available otherwise.
        if (profiles.length > 1) {
          setProfile((profiles.find((p) => p.available !== false) ?? profiles[0]).name)
        }
      })
      .catch((err: unknown) => {
        if (!stale) setProfilesError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      stale = true
    }
  }, [client])

  // The stored list is per directory and per engine store — a change to either
  // makes what is on screen answer a question nobody is asking any more.
  useEffect(() => setStored(undefined), [client, profile, cwd])

  const submit = async (resume?: SdkSessionSummary) => {
    if (!client || !host) return
    setBusy(true)
    setError(undefined)
    try {
      const info = await client.createSession({
        // A stored session knows its own directory; trust it over the field.
        cwd: resume?.cwd ?? cwd.trim(),
        profile,
        // The engine replays the thread it is resuming — a first prompt on top
        // of that would be a second turn nobody asked for.
        prompt: resume ? undefined : prompt.trim() || undefined,
        resume: resume?.sessionId,
      })
      onCreated(host.id, info.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const cwdValid = cwd.trim().startsWith('/')
  // With one profile the server resolves it implicitly (and the picker is
  // hidden), so that profile is still what the session will run under.
  const selectedProfile =
    profiles?.find((p) => p.name === profile) ?? (profiles?.length === 1 ? profiles[0] : undefined)
  // Absent record = the engine's default, exactly as the panel resolves it.
  const capabilities =
    selectedProfile?.capabilities ?? ENGINE_CAPABILITIES[selectedProfile?.engine ?? 'claude']

  const loadStored = async () => {
    if (!client || !cwdValid) return
    setLoadingStored(true)
    setError(undefined)
    try {
      // Named so the gateway lists the CHOSEN profile's engine store — another
      // engine's ids mean nothing to this one.
      setStored(await client.listSdkSessions({ dir: cwd.trim(), limit: 20, profile }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingStored(false)
    }
  }

  return (
    <div className='flex flex-col gap-3 p-3'>
      {hosts.length > 1 ? (
        <label className='flex flex-col gap-1 text-body-sm'>
          <span className='text-fg-3'>Gateway</span>
          <Select value={hostId} onValueChange={(v) => setHostId(v as string)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  <SelectItemText>{h.name}</SelectItemText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}

      {profilesError ? (
        <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
          cannot reach this gateway: {profilesError}
        </div>
      ) : profiles === undefined ? (
        <div className='flex items-center gap-2 text-body-sm text-fg-3'>
          <Spinner className='size-3' /> loading profiles…
        </div>
      ) : profiles.length > 1 ? (
        <label className='flex flex-col gap-1 text-body-sm'>
          <span className='text-fg-3'>Profile</span>
          <Select value={profile} onValueChange={(v) => setProfile(v as string)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  <SelectItemText>
                    {p.name} · {p.engine ?? 'claude'}
                    {p.available === false ? ' — unavailable' : ''}
                  </SelectItemText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedProfile?.available === false ? (
            <span className='text-label text-warning'>
              {selectedProfile.unavailableReason ?? 'credentials look unavailable'} — creating will
              likely fail
            </span>
          ) : null}
        </label>
      ) : null}

      <label className='flex flex-col gap-1 text-body-sm'>
        <span className='text-fg-3'>
          Working directory{host?.local ? '' : ` (on ${host?.name})`}
        </span>
        <Input
          value={cwd}
          onChange={(e) => {
            setCwdTouched(true)
            setCwd(e.target.value)
          }}
          placeholder='/path/to/project'
          className='font-mono'
        />
      </label>

      <label className='flex flex-col gap-1 text-body-sm'>
        <span className='text-fg-3'>First prompt (optional)</span>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder='Sent as soon as the session starts'
        />
      </label>

      {error ? (
        <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>{error}</div>
      ) : null}
      <div className='mt-1 flex justify-end gap-2'>
        <Button variant='ghost' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button size='sm' onClick={() => void submit()} disabled={busy || !host || !cwdValid || profiles === undefined}>
          {busy ? <Spinner className='size-3' /> : null} Create session
        </Button>
      </div>

      {/* Resuming needs an engine whose sessions are on disk and browsable. */}
      {profiles === undefined || !capabilities.listSessions ? null : (
        <div className='mt-1 flex flex-col gap-1 border-t border-border pt-3'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-body-sm text-fg-3'>Resume a previous session</span>
            <Button
              variant='ghost'
              size='xs'
              onClick={() => void loadStored()}
              disabled={loadingStored || !cwdValid}>
              {loadingStored ? <Spinner className='size-3' /> : <History className='size-3' />}
              {stored ? 'Reload' : 'Browse'}
            </Button>
          </div>
          {/* Stored sessions are indexed by directory, so the field decides
              which ones exist — say so rather than offering a dead button. */}
          {!cwdValid ? (
            <span className='text-label text-fg-4'>
              Set a working directory — stored sessions are listed per project.
            </span>
          ) : stored === undefined ? null : stored.length === 0 ? (
            <span className='text-label text-fg-4'>No stored sessions for this directory.</span>
          ) : (
            <ul className='flex flex-col'>
              {stored.map((s) => (
                <li
                  key={s.sessionId}
                  className='flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-hover'>
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-body-sm text-fg-1'>{s.customTitle ?? s.summary}</div>
                    <div className='flex gap-2 font-mono text-label text-fg-4'>
                      {s.gitBranch ? <span className='truncate'>{s.gitBranch}</span> : null}
                      <span className='shrink-0'>{formatRelativeTime(s.lastModified)}</span>
                    </div>
                  </div>
                  <Button
                    variant='outline'
                    size='xs'
                    onClick={() => void submit(s)}
                    disabled={busy}>
                    Resume
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
