import { join } from 'node:path'
import type { ProfileInfo } from '@workerdeck/protocol'
import { readJsonOrSync, writeJsonAtomicSync } from '../lib/atomic-file.ts'

export type ProfileStore = {
  list(): ProfileInfo[] | Promise<ProfileInfo[]>
  save(profile: ProfileInfo): void | Promise<void>
  delete(name: string): void | Promise<void>
}

export function createMemoryProfileStore(seed: ProfileInfo[] = []): ProfileStore {
  const profiles = new Map(seed.map((p) => [p.name, p]))
  return {
    list: () => [...profiles.values()],
    save: (profile) => void profiles.set(profile.name, profile),
    delete: (name) => void profiles.delete(name),
  }
}

export function createFileProfileStore(path = join(process.cwd(), '.workerdeck', 'profiles.json')): ProfileStore {
  const read = (): Map<string, ProfileInfo> => {
    const parsed = readJsonOrSync(path, [])
    if (!Array.isArray(parsed)) {
      return new Map()
    }
    const profiles = parsed as ProfileInfo[]
    return new Map(profiles.filter((p) => p && typeof p.name === 'string').map((p) => [p.name, p]))
  }
  const write = (profiles: Map<string, ProfileInfo>): void => writeJsonAtomicSync(path, [...profiles.values()], { indent: 2 })
  return {
    list: () => [...read().values()],
    save: (profile) => {
      const profiles = read()
      profiles.set(profile.name, profile)
      write(profiles)
    },
    delete: (name) => {
      const profiles = read()
      if (profiles.delete(name)) {
        write(profiles)
      }
    },
  }
}
