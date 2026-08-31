import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProfileInfo } from '@workerdeck/protocol'

export type ProfileStore = {
  list(): ProfileInfo[] | Promise<ProfileInfo[]>
  save(profile: ProfileInfo): void | Promise<void>
  delete(name: string): void | Promise<void>
}

export const createMemoryProfileStore = (seed: ProfileInfo[] = []): ProfileStore => {
  const profiles = new Map(seed.map((p) => [p.name, p]))
  return {
    list: () => [...profiles.values()],
    save: (profile) => void profiles.set(profile.name, profile),
    delete: (name) => void profiles.delete(name),
  }
}

export const createFileProfileStore = (path = join(process.cwd(), '.workerdeck', 'profiles.json')): ProfileStore => {
  const read = (): Map<string, ProfileInfo> => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!Array.isArray(parsed)) {
        return new Map()
      }
      const profiles = parsed as ProfileInfo[]
      return new Map(profiles.filter((p) => p && typeof p.name === 'string').map((p) => [p.name, p]))
    } catch {
      return new Map()
    }
  }
  const write = (profiles: Map<string, ProfileInfo>): void => {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify([...profiles.values()], null, 2))
    renameSync(temp, path)
  }
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
