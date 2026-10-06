import type { ContextReading, ProfileEngine, SessionStatus } from '@workerdeck/protocol'

export const RELAY_WIRE_VERSION = 1

export const RELAY_OPS = ['send', 'peek'] as const
export const RELAY_GRANTED_OPS = ['team', 'watch', 'message'] as const
export const RELAY_ALL_OPS = [...RELAY_OPS, ...RELAY_GRANTED_OPS] as const
export type RelayOp = (typeof RELAY_ALL_OPS)[number]

export const RELAY_FEATURES = ['teams'] as const
export type RelayFeature = (typeof RELAY_FEATURES)[number]

export const RELAY_OWNER_NAME = /^[a-z0-9-]{1,32}$/

export const SHARE_LEVELS = ['none', 'list', 'watch', 'message'] as const
export type ShareLevel = (typeof SHARE_LEVELS)[number]

export const RELAY_CLOSE = {
  badHello: 4400,
  unauthorized: 4401,
  revoked: 4403,
  versionMismatch: 4426,
  replaced: 4409,
  timeout: 4408,
} as const

export const RELAY_FRAME_MAX_BYTES = 4 * 1024 * 1024
export const RELAY_MESSAGE_MAX_CHARS = 16_000
export const RELAY_MAX_HOPS = 12
export const RELAY_GATEWAY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export type RelayAgentEntry = {
  id: string
  name: string
  lead?: string
  order?: number
  accepts?: string[]
  share?: ShareLevel
}

export type RelaySessionEntry = {
  id: string
  agent?: RelayAgentEntry
  engine?: ProfileEngine
  status: SessionStatus
  title?: string
  project?: { name: string; root: string }
  cwd: string
  profile?: string
  model?: string
  permissionMode?: string
  contextUsage?: ContextReading
  checklist?: { done: number; total: number }
  numTurns?: number
  createdAt: number
  lastActivityAt?: number
  pendingPermissionCount: number
  live: boolean
}

export type RelayPeerRow = RelaySessionEntry & { gateway: string; owner?: string; allow: RelayOp[] }

export type RelayOrigin = {
  gateway: string
  owner?: string
  sessionId: string
  name?: string
  engine?: ProfileEngine
  agent?: { id: string; name: string; lead?: string }
  hops: string[]
}

export const TEAM_FRAMES = ['team.join', 'team.leave', 'team.release', 'team.invite', 'team.request'] as const
export type TeamFrameKind = (typeof TEAM_FRAMES)[number]

export type RelayTeamOrigin = { gateway: string; owner: string; agent: string; name?: string }

export type TeamEdge = { from: string; to: string }

export type TeamResult = { ok: true; leadName?: string } | { ok: false; reason: string }

export type TeamStatusEdge = { from: string; to: string; known: boolean; name?: string; session?: string }

export type RelayPeek = RelaySessionEntry & {
  checklistItems?: Array<{ text: string; status: string }>
  pendingApprovals: string[]
  recent: string[]
}

export type RelaySendResult = { delivered: true; sessionId: string; name?: string; queued: boolean } | { delivered: false; reason: string }

export type RelayTarget = { gateway: string; id: string }

export type HelloFrame = {
  t: 'hello'
  gateway: string
  key: string
  version: number
  ceiling: { ops: RelayOp[] }
  features?: RelayFeature[]
}
export type WelcomeFrame = { t: 'welcome'; relayVersion: number; features?: RelayFeature[]; owner?: string }
export type SnapshotFrame = { t: 'registry.snapshot'; seq: number; entries: RelaySessionEntry[] }
export type DeltaFrame = { t: 'registry.delta'; seq: number; upsert: RelaySessionEntry[]; remove: string[] }
export type DigestFrame = { t: 'registry.digest'; seq: number; count: number; hash: string }
export type ResyncFrame = { t: 'registry.resync' }

export type ListRequest = { t: 'peer.list'; id: string; from: string }
export type PeekRequest = { t: 'peer.peek'; id: string; from: string; to: RelayTarget; recent?: number }
export type SendRequest = { t: 'peer.send'; id: string; from: string; to: RelayTarget; text: string; hops: string[] }

export type TeamRequest = { t: TeamFrameKind; id: string; from: string; to: string }
export type TeamStatusRequest = { t: 'team.status'; id: string; gateway: string; edges: TeamEdge[] }

export type InboundPeek = { t: 'peer.peek'; id: string; origin: RelayOrigin; to: string; recent?: number }
export type InboundSend = { t: 'peer.send'; id: string; origin: RelayOrigin; to: string; text: string }
export type InboundTeam = { t: TeamFrameKind; id: string; origin: RelayTeamOrigin; to: string }
export type InboundTeamStatus = { t: 'team.status'; id: string; origin: { gateway: string; owner: string }; edges: TeamEdge[] }

export type ResponseFrame = { t: 'res'; id: string; ok: true; result: unknown } | { t: 'res'; id: string; ok: false; error: string }

export type GatewayFrame =
  | HelloFrame
  | SnapshotFrame
  | DeltaFrame
  | DigestFrame
  | ListRequest
  | PeekRequest
  | SendRequest
  | TeamRequest
  | TeamStatusRequest
  | ResponseFrame

export type RelayFrame = WelcomeFrame | ResyncFrame | InboundPeek | InboundSend | InboundTeam | InboundTeamStatus | ResponseFrame

export function encodeFrame(frame: GatewayFrame | RelayFrame): string {
  return JSON.stringify(frame)
}

// Only the envelope is checked here; each side narrows the payload of the frames it accepts.
export function decodeFrame(raw: unknown): { t: string; [key: string]: unknown } | undefined {
  const text = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : undefined
  if (text === undefined) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { t?: unknown }).t !== 'string') {
      return undefined
    }
    return value as { t: string; [key: string]: unknown }
  } catch {
    return undefined
  }
}

export function isRelayOp(value: unknown): value is RelayOp {
  return (RELAY_ALL_OPS as readonly unknown[]).includes(value)
}

export function isRelayFeature(value: unknown): value is RelayFeature {
  return (RELAY_FEATURES as readonly unknown[]).includes(value)
}

export function isShareLevel(value: unknown): value is ShareLevel {
  return (SHARE_LEVELS as readonly unknown[]).includes(value)
}

export function isTeamFrameKind(value: unknown): value is TeamFrameKind {
  return (TEAM_FRAMES as readonly unknown[]).includes(value)
}

// A bare id names something on the gateway that sent it; only the relay qualifies ids, with the
// connection's own name, so no gateway can claim an agent that lives elsewhere.
export function qualifyId(gateway: string, id: string): string {
  return parseRelayPeerId(id) ? id : relayPeerId(gateway, id)
}

export function relayPeerId(gateway: string, sessionId: string): string {
  return `${gateway}:${sessionId}`
}

export function parseRelayPeerId(id: string): RelayTarget | undefined {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) {
    return undefined
  }
  const gateway = id.slice(0, at)
  return RELAY_GATEWAY_NAME.test(gateway) ? { gateway, id: id.slice(at + 1) } : undefined
}
