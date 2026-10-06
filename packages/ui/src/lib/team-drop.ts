import type { SessionRow } from '@workerdeck/protocol'

export type DropZone = 'before' | 'join' | 'after'

// What a drop asks of the host: `lead: null` leaves the team. Joining renumbers the team densely from 0, so
// `siblings` lists the other members whose `order` changes; teams are small and most of them never moved.
export type TeamMove = { row: SessionRow; lead: SessionRow | null; order?: number; siblings?: { row: SessionRow; order: number }[] }

export function dropZone(offsetY: number, height: number): DropZone {
  if (height <= 0) {
    return 'join'
  }
  const at = offsetY / height
  return at < 0.25 ? 'before' : at > 0.75 ? 'after' : 'join'
}

// Mirrors the gateway's `leadRefusal`, so a drag can say no before it asks; the 409 stays the authority.
export function teamDropRefusal(dragged: SessionRow, lead: SessionRow): string | undefined {
  const mover = dragged.info.agent
  const target = lead.info.agent
  if (dragged.hostId !== lead.hostId) {
    return 'a team stays on one gateway'
  }
  if (!target) {
    return 'only an agent can lead a team'
  }
  if (mover?.id === target.id || dragged.info.id === lead.info.id) {
    return 'an agent cannot lead its own team'
  }
  if (target.lead !== undefined) {
    return `${target.name} is a member of a team; teams are one level deep`
  }
  if (mover?.leads) {
    return `${mover.name} leads a team; teams are one level deep`
  }
  return undefined
}

// The move a drop over a member asks for: join (or reorder within) that member's team, at the member's place.
export function memberDrop(dragged: SessionRow, lead: SessionRow, member: SessionRow, zone: DropZone): TeamMove | string {
  const refusal = teamDropRefusal(dragged, lead)
  if (refusal) {
    return refusal
  }
  const others = (lead.members ?? []).filter((row) => row.info.id !== dragged.info.id || row.hostId !== dragged.hostId)
  const at = others.findIndex((row) => row.info.id === member.info.id && row.hostId === member.hostId)
  const index = at < 0 ? others.length : zone === 'before' ? at : at + 1
  return placeMember(dragged, lead, others, index)
}

export function joinDrop(dragged: SessionRow, lead: SessionRow): TeamMove | string {
  const refusal = teamDropRefusal(dragged, lead)
  if (refusal) {
    return refusal
  }
  const others = (lead.members ?? []).filter((row) => row.info.id !== dragged.info.id || row.hostId !== dragged.hostId)
  return placeMember(dragged, lead, others, others.length)
}

function placeMember(dragged: SessionRow, lead: SessionRow, others: readonly SessionRow[], index: number): TeamMove {
  const siblings = others
    .map((row, i) => ({ row, order: i < index ? i : i + 1 }))
    .filter(({ row, order }) => row.info.agent?.order !== order)
  return { row: dragged, lead, order: index, ...(siblings.length ? { siblings } : {}) }
}
