import { describe, expect, it } from 'vitest'
import { WorkerDeckError, runTeamMove, teamMoveMessage, withdrawTeamInvitation, type WorkerDeckClient } from '../src/index.ts'

type Failures = Partial<Record<'update' | 'create' | 'invite' | 'withdraw', Error>>

function fakeClient(calls: string[], name: string, fail: Failures = {}, inviteState: 'invited' | 'accepted' = 'invited'): WorkerDeckClient {
  const record = (what: string, kind: keyof Failures, agent: object = { id: 'adopted' }) => {
    calls.push(`${name} ${what}`)
    const failure = fail[kind]
    return failure ? Promise.reject(failure) : Promise.resolve({ agent })
  }
  return {
    updateAgent: (id: string, patch: unknown) => record(`update ${id} ${JSON.stringify(patch)}`, 'update'),
    createAgent: (request: unknown) => record(`create ${JSON.stringify(request)}`, 'create'),
    inviteRemoteMember: (id: string, agent: string, owner?: string) =>
      record(`invite ${id} ${agent}${owner ? ` as ${owner}` : ''}`, 'invite', {
        id,
        remoteMembers: [{ agent, state: inviteState, at: 0, ...(inviteState === 'invited' ? { invite: 'inv-1' } : {}) }],
      }),
    withdrawInvitation: (id: string, agent: string, invite: string) => record(`withdraw ${id} ${agent} ${invite}`, 'withdraw'),
  } as unknown as WorkerDeckClient
}

function relay(gateway: string) {
  return { gateway, online: true, features: ['teams'] }
}

const relays: Record<string, ReturnType<typeof relay>> = { mac: relay('sw-mac'), desk: relay('sw-desk') }

function pair(calls: string[], desk: Failures = {}, mac: Failures = {}, inviteState?: 'invited' | 'accepted') {
  const clients: Record<string, WorkerDeckClient> = {
    mac: fakeClient(calls, 'mac', mac, inviteState),
    desk: fakeClient(calls, 'desk', desk),
  }
  return (id: string) => clients[id]
}

const refused = new WorkerDeckError('AC-Lead has not invited this agent', 409)
const offline = new TypeError('fetch failed')

describe('runTeamMove', () => {
  it('joins on one gateway with a single PATCH', async () => {
    const calls: string[] = []
    const mac = fakeClient(calls, 'mac')
    const outcome = await runTeamMove(
      { mover: { hostId: 'mac', sessionId: 's1', agentId: 'P' }, lead: { hostId: 'mac', agentId: 'A' }, order: 0 },
      () => mac,
    )
    expect(outcome).toEqual({ committed: 'yes' })
    expect(calls).toEqual(['mac update P {"lead":"A","order":0}'])
  })

  it('carries the confirmation of a cross-owner join on one gateway, for an agent and for an adoption', async () => {
    const calls: string[] = []
    const mac = fakeClient(calls, 'mac')
    await runTeamMove(
      { mover: { hostId: 'mac', sessionId: 's1', agentId: 'P' }, lead: { hostId: 'mac', agentId: 'A' }, crossOwner: true },
      () => mac,
    )
    await runTeamMove({ mover: { hostId: 'mac', sessionId: 's2' }, lead: { hostId: 'mac', agentId: 'A' }, crossOwner: true }, () => mac)
    expect(calls).toEqual(['mac update P {"lead":"A","crossOwner":true}', 'mac create {"adopt":"s2","lead":"A","crossOwner":true}'])
  })

  it('invites on the lead gateway with the mover owner before the mover joins with the qualified lead', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      {
        mover: { hostId: 'desk', sessionId: 's9', owner: 'ruli' },
        lead: { hostId: 'mac', agentId: 'A' },
        order: 1,
        siblings: [{ hostId: 'mac', agentId: 'J', order: 0 }],
      },
      pair(calls),
      (id) => relays[id],
    )
    expect(outcome).toEqual({ committed: 'yes', adopted: { hostId: 'desk', agentId: 'adopted' } })
    expect(calls).toEqual([
      'desk create {"adopt":"s9"}',
      'mac invite A sw-desk:adopted as ruli',
      'desk update adopted {"lead":"sw-mac:A","order":1}',
      'mac update J {"order":0}',
    ])
  })

  it('refuses a move across gateways without both relay identities, before changing anything', async () => {
    const calls: string[] = []
    await expect(
      runTeamMove({ mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } }, pair(calls)),
    ).rejects.toThrow('a team spans gateways only through a relay both gateways dial')
    expect(calls).toEqual([])
  })

  it('withdraws its own invitation by id when the join is refused, and reports the adoption it keeps', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, { update: refused }),
      (id) => relays[id],
    )
    expect(outcome).toEqual({
      committed: 'no',
      error: 'AC-Lead has not invited this agent',
      adopted: { hostId: 'desk', agentId: 'adopted' },
      invitation: { hostId: 'mac', leadAgentId: 'A', member: 'sw-desk:adopted', invite: 'inv-1', state: 'withdrawn' },
    })
    expect(calls.at(-1)).toBe('mac withdraw A sw-desk:adopted inv-1')
    expect(teamMoveMessage(outcome)).toBe('AC-Lead has not invited this agent. The session stays an agent. The invitation was withdrawn.')
  })

  it('leaves the invitation open when the join went unanswered, since it may still commit', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, { update: offline }),
      (id) => relays[id],
    )
    expect(outcome).toMatchObject({ committed: 'unknown', invitation: { invite: 'inv-1', state: 'open' } })
    expect(calls.some((call) => call.includes('withdraw'))).toBe(false)
    expect(teamMoveMessage(outcome)).toBe(
      'The gateway did not answer, so the join may still go through (fetch failed). The invitation stays open for up to 10 minutes.',
    )
  })

  it('treats a gateway error answer as unknown, not as a refusal', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, { update: new WorkerDeckError('internal error', 500) }),
      (id) => relays[id],
    )
    expect(outcome.committed).toBe('unknown')
  })

  it('keeps the invitation open when withdrawing it fails', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, { update: refused }, { withdraw: offline }),
      (id) => relays[id],
    )
    expect(outcome).toMatchObject({ committed: 'no', invitation: { state: 'open' } })
  })

  it('tracks no invitation when the member was already accepted, so nothing is withdrawn', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, { update: refused }, {}, 'accepted'),
      (id) => relays[id],
    )
    expect(outcome).toEqual({ committed: 'no', error: 'AC-Lead has not invited this agent' })
    expect(calls.some((call) => call.includes('withdraw'))).toBe(false)
  })

  it('reports a refused invitation with the adoption it keeps and never joins', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, {}, { invite: new WorkerDeckError('a team holds at most 8 members from other gateways', 409) }),
      (id) => relays[id],
    )
    expect(outcome).toEqual({
      committed: 'no',
      error: 'a team holds at most 8 members from other gateways',
      adopted: { hostId: 'desk', agentId: 'adopted' },
    })
    expect(calls).toEqual(['desk create {"adopt":"s9"}', 'mac invite A sw-desk:adopted'])
  })

  it('reports an invitation of unknown state when the invite got no answer, and offers no withdrawal without an id', async () => {
    const calls: string[] = []
    const outcome = await runTeamMove(
      { mover: { hostId: 'desk', sessionId: 's9', agentId: 'W' }, lead: { hostId: 'mac', agentId: 'A' } },
      pair(calls, {}, { invite: offline }),
      (id) => relays[id],
    )
    expect(outcome).toEqual({
      committed: 'no',
      error: 'fetch failed',
      invitation: { hostId: 'mac', leadAgentId: 'A', member: 'sw-desk:W', state: 'unknown' },
    })
    expect(calls).toEqual(['mac invite A sw-desk:W'])
    expect(teamMoveMessage(outcome)).toBe("Fetch failed. The lead's gateway may hold an invitation; it lapses within 10 minutes.")
    await expect(withdrawTeamInvitation(outcome.invitation!, pair(calls))).rejects.toThrow('that invitation has no id to withdraw by')
  })

  it('collects every sibling whose order failed instead of stopping at the first', async () => {
    const calls: string[] = []
    const clients: Record<string, WorkerDeckClient> = {
      mac: fakeClient(calls, 'mac'),
      desk: fakeClient(calls, 'desk', { update: refused }),
    }
    const outcome = await runTeamMove(
      {
        mover: { hostId: 'mac', sessionId: 's1', agentId: 'P' },
        lead: { hostId: 'mac', agentId: 'A' },
        siblings: [
          { hostId: 'desk', agentId: 'J', order: 0 },
          { hostId: 'desk', agentId: 'K', order: 2 },
          { hostId: 'mac', agentId: 'L', order: 3 },
        ],
      },
      (id) => clients[id],
    )
    expect(outcome).toEqual({
      committed: 'yes',
      unordered: [
        { hostId: 'desk', agentId: 'J' },
        { hostId: 'desk', agentId: 'K' },
      ],
    })
    expect(calls.at(-1)).toBe('mac update L {"order":3}')
    expect(teamMoveMessage(outcome)).toBe('The team order of 2 agents was not saved; drag again to reorder.')
  })

  it('says nothing about a move that simply went through', () => {
    expect(teamMoveMessage({ committed: 'yes', adopted: { hostId: 'mac', agentId: 'X' } })).toBeUndefined()
  })

  it('withdraws an open invitation on its own gateway', async () => {
    const calls: string[] = []
    await withdrawTeamInvitation({ hostId: 'mac', leadAgentId: 'A', member: 'sw-desk:W', invite: 'inv-1', state: 'open' }, pair(calls))
    expect(calls).toEqual(['mac withdraw A sw-desk:W inv-1'])
  })
})
