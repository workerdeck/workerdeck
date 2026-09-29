import { useEffect, useState } from 'react'
import type { ListProfilesResponse, ProfileInfo } from '@workerdeck/protocol'
import { client } from '../lib/client.ts'
import { clientFor, onHostsChange, primaryHost } from '../lib/hosts.ts'
import { readPref, writePref } from '../lib/storage.ts'
import { createPolledStore } from '../lib/store.ts'

const EMPTY: ListProfilesResponse = { profiles: [] }
const store = createPolledStore<ListProfilesResponse>(EMPTY, { load: loadProfiles })

async function loadProfiles(): Promise<void> {
  // No gateway yet, because the probe is still out or none is configured: answer empty rather than throw.
  const listed = await client()
    ?.listProfiles()
    .catch(() => EMPTY)
  store.set(listed ?? EMPTY)
}

export function useProfileList(): ListProfilesResponse & { refresh: () => Promise<void> } {
  // A deep link subscribes before the gateway probe answers, and that first load finds no client.
  useEffect(() => onHostsChange(() => void store.refresh()), [])
  return { ...store.use(), refresh: store.refresh }
}

export function useProfiles(): ProfileInfo[] {
  return useProfileList().profiles
}

const CHOICE_KEY = 'workerdeck.last-profile'

// Another gateway's profiles are read once per mount: only a form aimed at that gateway asks, and it lives for one dialog.
function useHostProfiles(hostId: string | undefined): ProfileInfo[] | undefined {
  const remote = hostId !== undefined && hostId !== primaryHost()?.id ? hostId : undefined
  const [profiles, setProfiles] = useState<ProfileInfo[]>()
  useEffect(() => {
    if (remote === undefined) {
      return
    }
    let live = true
    void clientFor(remote)
      ?.listProfiles()
      .then((listed) => live && setProfiles(listed.profiles))
      .catch(() => live && setProfiles([]))
    return () => {
      live = false
    }
  }, [remote])
  return remote === undefined ? undefined : (profiles ?? [])
}

export function useProfileChoice(hostId?: string) {
  const primary = useProfiles()
  const profiles = useHostProfiles(hostId) ?? primary
  const [choice, setChoice] = useState(() => readPref(CHOICE_KEY) ?? '')
  const profile = profiles.some((p) => p.name === choice) ? choice : (profiles[0]?.name ?? '')
  const selected = profiles.find((p) => p.name === profile)
  const select = (name: string) => {
    setChoice(name)
    writePref(CHOICE_KEY, name)
  }
  return { profiles, profile, selected, select }
}
