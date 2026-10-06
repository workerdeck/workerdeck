import { describe, expect, it } from 'vitest'
import type { AgentRef, SessionInfo, SessionRow } from '@workerdeck/protocol'
import { dropZone, joinDrop, memberDrop, teamDropRefusal } from '../src/lib/team-drop.ts'

function row(id: string, agent?: Partial<AgentRef>, over: Partial<SessionRow> = {}): SessionRow {
  const info = {
    id,
    status: 'idle',
    cwd: '/w',
    createdAt: 1,
    lastActivityAt: 1,
    numTurns: 0,
    pendingPermissionCount: 0,
    ...(agent ? { agent: { id: `a-${id}`, name: id, ...agent } } : {}),
  } as SessionInfo
  return { hostId: 'mac', hostName: 'Mac', local: true, adapter: 'claude', state: 'idle', unseen: 0, info, ...over }
}

describe('dropZone', () => {
  it('splits a card into an edge, a middle and an edge', () => {
    expect(dropZone(2, 40)).toBe('before')
    expect(dropZone(20, 40)).toBe('join')
    expect(dropZone(38, 40)).toBe('after')
    expect(dropZone(5, 0)).toBe('join')
  })
})

describe('teamDropRefusal', () => {
  it('mirrors the gateway rules, with its wording', () => {
    const atlas = row('atlas', { leads: true })
    expect(teamDropRefusal(row('pip', {}), atlas)).toBeUndefined()
    expect(teamDropRefusal(row('plain'), atlas)).toBeUndefined()
    expect(teamDropRefusal(atlas, atlas)).toBe('an agent cannot lead its own team')
    expect(teamDropRefusal(row('pip', {}), row('juno', { lead: 'a-atlas' }))).toBe('juno is a member of a team; teams are one level deep')
    expect(teamDropRefusal(atlas, row('orbit', {}))).toBe('atlas leads a team; teams are one level deep')
    expect(teamDropRefusal(row('pip', {}), row('plain'))).toBe('only an agent can lead a team')
  })

  it('allows a drop across gateways only when both dial a relay that routes teams, under one owner', () => {
    const far = row('far', {}, { hostId: 'desk', hostName: 'Desk' })
    const relay = (gateway: string, over = {}) => ({ gateway, owner: 'tobias', online: true, features: ['teams'], ...over })
    const both = { mac: relay('sw-mac'), desk: relay('sw-desk') }
    expect(teamDropRefusal(row('pip', {}), far)).toBe('a team spans gateways only through a relay both gateways dial')
    expect(teamDropRefusal(row('pip', {}), far, both)).toBeUndefined()
    expect(teamDropRefusal(row('pip', {}), far, { ...both, desk: relay('sw-desk', { online: false }) })).toBe(
      'Desk is not connected to its relay',
    )
    expect(teamDropRefusal(row('pip', {}), far, { ...both, mac: relay('sw-mac', { features: [] }) })).toBe(
      'the relay does not route teams yet',
    )
    expect(teamDropRefusal(row('pip', {}), far, { ...both, desk: relay('sw-desk', { owner: 'dan' }) })).toBe(
      'that gateway belongs to another operator',
    )
    expect(joinDrop(row('pip', {}), far, both)).toMatchObject({ lead: { hostId: 'desk' }, order: 0 })
  })
})

describe('joining and reordering', () => {
  const juno = row('juno', { lead: 'a-atlas' })
  const rook = row('rook', { lead: 'a-atlas' })
  const atlas = row('atlas', { leads: true }, { members: [juno, rook] })

  it('joins at the end of the team, numbering the others densely', () => {
    expect(joinDrop(row('pip', {}), atlas)).toEqual({
      row: expect.objectContaining({ hostId: 'mac' }),
      lead: atlas,
      order: 2,
      siblings: [
        { row: juno, order: 0 },
        { row: rook, order: 1 },
      ],
    })
  })

  it('places a drop beside the member it lands on, and only renumbers members whose order changes', () => {
    const ordered = row(
      'atlas',
      { leads: true },
      { members: [row('juno', { lead: 'a-atlas', order: 0 }), row('rook', { lead: 'a-atlas', order: 1 })] },
    )
    const [j, r] = ordered.members!
    expect(memberDrop(row('pip', {}), ordered, r!, 'before')).toMatchObject({ order: 1, siblings: [{ row: r, order: 2 }] })
    expect(memberDrop(row('pip', {}), ordered, r!, 'after')).not.toHaveProperty('siblings')
    expect(memberDrop(r!, ordered, j!, 'before')).toMatchObject({ row: r, order: 0, siblings: [{ row: j, order: 1 }] })
  })

  it('refuses a lead dropped among another team', () => {
    expect(memberDrop(row('orbit', { leads: true }), atlas, juno, 'after')).toBe('orbit leads a team; teams are one level deep')
  })
})
