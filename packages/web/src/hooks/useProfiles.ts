import { useState } from 'react'
import type { ListProfilesResponse, ProfileInfo } from '@workerdeck/protocol'
import { client } from '../lib/client.ts'
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
  return { ...store.use(), refresh: store.refresh }
}

export function useProfiles(): ProfileInfo[] {
  return useProfileList().profiles
}

const CHOICE_KEY = 'workerdeck.last-profile'

export function useProfileChoice() {
  const profiles = useProfiles()
  const [choice, setChoice] = useState(() => readPref(CHOICE_KEY) ?? '')
  const profile = profiles.some((p) => p.name === choice) ? choice : (profiles[0]?.name ?? '')
  const selected = profiles.find((p) => p.name === profile)
  const select = (name: string) => {
    setChoice(name)
    writePref(CHOICE_KEY, name)
  }
  return { profiles, profile, selected, select }
}
