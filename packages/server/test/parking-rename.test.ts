import { describe, expect, it } from 'vitest'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { MemorySessionStore, SessionParkManager, type StoredSessionRecord } from '../src/index.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import { ParkableRunner } from './parkable-runner.ts'

const config: SessionRunnerConfig = { cwd: '/tmp/project', profile: 'kimi', owner: 'ruli' }

function rig(rebuild: (record: StoredSessionRecord) => Promise<Runner> = async (record) => restored(record)) {
  const store = new MemorySessionStore()
  const registry = new SessionRegistry()
  const parking = new SessionParkManager({ registry, store, rebuild, attachedCount: () => 0, persistLive: true })
  return { store, registry, parking }
}

function restored(record: StoredSessionRecord): ParkableRunner {
  return new ParkableRunner(record.id, record.config, 'snapshot' in record ? record.snapshot : undefined)
}

async function liveRecord(): Promise<StoredSessionRecord> {
  const { store, registry, parking } = rig()
  const runner = new ParkableRunner('s1', config)
  registry.register(runner)
  parking.remember(runner.id, config)
  parking.touch(runner)
  await parking.listInfo()
  return (await store.get(runner.id))!
}

function owners(record: StoredSessionRecord | null) {
  return { info: record?.info.owner, config: record?.config.owner }
}

describe('owner rename against parking', () => {
  it("rewrites a live session's stored record, even with a write-through queued ahead of it", async () => {
    const { store, registry, parking } = rig()
    const runner = new ParkableRunner('s1', config)
    registry.register(runner)
    parking.remember(runner.id, config)
    parking.touch(runner)
    await parking.listInfo()
    expect(owners(await store.get('s1'))).toEqual({ info: 'ruli', config: 'ruli' })

    parking.touch(runner)
    expect(await parking.renameOwner('ruli', 'tobias')).toBe(1)

    expect(runner.info().owner).toBe('tobias')
    expect(owners(await store.get('s1'))).toEqual({ info: 'tobias', config: 'tobias' })
    parking.touch(runner)
    await parking.listInfo()
    expect(owners(await store.get('s1'))).toEqual({ info: 'tobias', config: 'tobias' })
  })

  it('holds a rename behind a wake whose runner factory is still building from the old record', async () => {
    const record = await liveRecord()
    let release!: () => void
    const factoryGate = new Promise<void>((resolve) => (release = resolve))
    let building = false
    const { store, registry, parking } = rig(async (stored) => {
      building = true
      await factoryGate
      return restored(stored)
    })
    await store.save(record)

    const wake = parking.ensureLive('s1')
    await expect.poll(() => building).toBe(true)
    let renameDone = false
    const rename = parking.renameOwner('ruli', 'tobias').then((count) => {
      renameDone = true
      return count
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(renameDone).toBe(false)

    release()
    const runner = await wake
    expect(await rename).toBe(1)
    expect(registry.get('s1')).toBe(runner)
    expect(runner?.info().owner).toBe('tobias')
    expect(owners(await store.get('s1'))).toEqual({ info: 'tobias', config: 'tobias' })

    parking.touch(runner!)
    await parking.listInfo()
    expect(owners(await store.get('s1'))).toEqual({ info: 'tobias', config: 'tobias' })
  })

  it('makes a wake asked for during a rename wait for it, then build from the new record', async () => {
    const record = await liveRecord()
    const built: string[] = []
    const { store, parking } = rig(async (stored) => {
      built.push(stored.config.owner ?? '')
      return restored(stored)
    })
    await store.save(record)

    const rename = parking.renameOwner('ruli', 'tobias')
    const runner = await parking.ensureLive('s1')
    expect(await rename).toBe(1)
    expect(built).toEqual(['tobias'])
    expect(runner?.info().owner).toBe('tobias')
  })
})
