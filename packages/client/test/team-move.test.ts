import { describe, expect, it } from 'vitest'
import { runTeamMove, type WorkerDeckClient } from '../src/index.ts'

function fakeClient(calls: string[], name: string): WorkerDeckClient {
  const record = (what: string) => {
    calls.push(`${name} ${what}`)
    return Promise.resolve({ agent: { id: 'adopted' } })
  }
  return {
    updateAgent: (id: string, patch: unknown) => record(`update ${id} ${JSON.stringify(patch)}`),
    createAgent: (request: unknown) => record(`create ${JSON.stringify(request)}`),
    inviteRemoteMember: (id: string, agent: string) => record(`invite ${id} ${agent}`),
  } as unknown as WorkerDeckClient
}

function relay(gateway: string) {
  return { gateway, online: true, features: ['teams'] }
}

describe('runTeamMove', () => {
  it('joins on one gateway with a single PATCH', async () => {
    const calls: string[] = []
    const mac = fakeClient(calls, 'mac')
    await runTeamMove({ mover: { hostId: 'mac', sessionId: 's1', agentId: 'P' }, lead: { hostId: 'mac', agentId: 'A' }, order: 0 }, () => mac)
    expect(calls).toEqual(['mac update P {"lead":"A","order":0}'])
  })

  it('invites on the lead gateway before the mover joins with the qualified lead', async () => {
    const calls: string[] = []
    const clients: Record<string, WorkerDeckClient> = { mac: fakeClient(calls, 'mac'), desk: fakeClient(calls, 'desk') }
    const relays: Record<string, ReturnType<typeof relay>> = { mac: relay('sw-mac'), desk: relay('sw-desk') }
    await runTeamMove(
      {
        mover: { hostId: 'desk', sessionId: 's9' },
        lead: { hostId: 'mac', agentId: 'A' },
        order: 1,
        siblings: [{ hostId: 'mac', agentId: 'J', order: 0 }],
      },
      (id) => clients[id],
      (id) => relays[id],
    )
    expect(calls).toEqual([
      'desk create {"adopt":"s9"}',
      'mac invite A sw-desk:adopted',
      'desk update adopted {"lead":"sw-mac:A","order":1}',
      'mac update J {"order":0}',
    ])
  })

  it('refuses a move across gateways without both relay identities', async () => {
    const calls: string[] = []
    const clients: Record<string, WorkerDeckClient> = { mac: fakeClient(calls, 'mac'), desk: fakeClient(calls, 'desk') }
    await expect(
      runTeamMove({ mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } }, (id) => clients[id]),
    ).rejects.toThrow('a team spans gateways only through a relay both gateways dial')
    expect(calls).toEqual([])
  })
})
