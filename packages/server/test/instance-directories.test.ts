import { afterEach, describe, expect, it } from 'vitest'
import type { PeerDirectory, SessionRunnerConfig } from '@workerdeck/core'
import type { ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { listenOn } from './helpers.ts'
import { ParkableRunner } from './parkable-runner.ts'

const profile: ProfileInfo = { name: 'kimi', engine: 'provider', provider: { id: 'moonshotai', model: 'kimi-k3' } }

const servers: WorkerServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function gateway(prefix: string) {
  const configs: SessionRunnerConfig[] = []
  const server = createWorkerServer({
    allowUnauthenticated: true,
    profiles: [profile],
    createEngineRunner: ({ config }) => {
      configs.push(config)
      return new ParkableRunner(`${prefix}-${configs.length}`, config)
    },
  })
  servers.push(server)
  const { base } = await listenOn(server)
  const create = async (): Promise<SessionInfo> => {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'kimi' }),
    })
    return ((await res.json()) as { session: SessionInfo }).session
  }
  return { server, configs, create }
}

async function peerIds(directory: PeerDirectory | undefined, from: string): Promise<string[]> {
  return (await directory!.list(from)).map((row) => row.id).sort()
}

describe('per-instance directories', () => {
  it("keeps each server's runners on their own peer directory when two share a process", async () => {
    const a = await gateway('a')
    const a1 = await a.create()
    const a2 = await a.create()
    const b = await gateway('b')
    const b1 = await b.create()

    expect(await peerIds(a.configs[0]!.peers, a1.id)).toEqual(expect.arrayContaining([a2.id]))
    expect(await peerIds(a.configs[0]!.peers, a1.id)).not.toContain(b1.id)
    expect(await peerIds(b.configs[0]!.peers, b1.id)).not.toContain(a2.id)
  })

  it('falls back to the last installed directory once its own server has closed, as a hot reload needs', async () => {
    const a = await gateway('a')
    await a.create()
    const b = await gateway('b')
    const b1 = await b.create()
    const b2 = await b.create()
    await a.server.close()

    expect(await peerIds(a.configs[0]!.peers, b1.id)).toEqual(expect.arrayContaining([b2.id]))
  })
})
