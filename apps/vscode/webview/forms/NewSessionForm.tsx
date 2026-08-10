import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import type { ProfileInfo } from '@workerdeck/protocol'
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
} from '@workerdeck/ui'
import type { WireHost } from '../../src/bridge-protocol.ts'
import type { Bridge } from '../bridge.ts'

/**
 * The new-session flow: gateway → profile (fetched live through the bridged
 * client, availability-aware) → cwd → optional first prompt. Creates the
 * session ITSELF over REST — the bridge injects the gateway's credentials host
 * side — and hands the id up via onCreated; errors stay inline.
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

  const submit = async () => {
    if (!client || !host) return
    setBusy(true)
    setError(undefined)
    try {
      const info = await client.createSession({
        cwd: cwd.trim(),
        profile,
        prompt: prompt.trim() || undefined,
      })
      onCreated(host.id, info.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const cwdValid = cwd.trim().startsWith('/')
  const selectedProfile = profiles?.find((p) => p.name === profile)

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
    </div>
  )
}
