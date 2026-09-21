import {
  PEER_MESSAGE_MAX_CHARS,
  PEER_RECENT_DEFAULT,
  PEER_RECENT_MAX,
  peerSummary,
  recentLines,
  type PeerDirectory,
  type PeerPeek,
  type PeerSendOptions,
  type PeerSendResult,
  type PeerMention,
  type PeerSessionSummary,
  type Runner,
} from '@workerdeck/core'
import {
  PEER_MENTION_MAX,
  peerMentionKey,
  peerMentionSlug,
  scanPeerMentions,
  type MessageOrigin,
  type SessionEvent,
  type SessionInfo,
} from '@workerdeck/protocol'
import { scopeMatches } from '../lib/scope.ts'
import type { LateBoundRefs } from '../options.ts'
import type { ProjectInfoService } from './project-info.ts'
import type { SessionRegistry } from './registry.ts'

export type PeerServiceOptions = {
  enabled?: boolean
  maxMessageChars?: number
  perMinute?: number
  maxHops?: number
}

export type PeerServiceDeps = {
  refs: LateBoundRefs
  projects: ProjectInfoService
  options?: PeerServiceOptions
}

const DEFAULT_PER_MINUTE = 10
const DEFAULT_MAX_HOPS = 12
const WINDOW_MS = 60_000

function visible(from: SessionInfo, to: SessionInfo): boolean {
  return to.id !== from.id && scopeMatches(from.scope, to.scope)
}

export type PeerService = PeerDirectory & {
  watch(runner: Runner): () => void
  // The `#Name` tokens in a message a person typed, resolved to the peers that session can see.
  mentions(from: string, text: string): Promise<PeerMention[]>
}

// Session-to-session messaging inside one gateway. Visibility is the session-scope rule the HTTP routes enforce,
// applied with the *sender's* scope as the principal: a scoped session sees the sessions a scoped client would.
export function createPeerService(deps: PeerServiceDeps): PeerService {
  const perMinute = deps.options?.perMinute ?? DEFAULT_PER_MINUTE
  const maxChars = deps.options?.maxMessageChars ?? PEER_MESSAGE_MAX_CHARS
  const maxHops = deps.options?.maxHops ?? DEFAULT_MAX_HOPS
  const sent = new Map<string, number[]>()
  // The chain of sessions that led to the last peer message each session received, cleared when a human speaks to
  // it: two agents answering each other without a person in the loop is the loop this bounds.
  const inbound = new Map<string, string[]>()

  const registry = (): SessionRegistry => {
    const found = deps.refs.registry
    if (!found) {
      throw new Error('peer messaging is not ready')
    }
    return found
  }

  const allSessions = async (): Promise<SessionInfo[]> => {
    const live = registry().list()
    const dormant = (await deps.refs.parking?.listInfo()) ?? []
    return [...live, ...dormant].map((info) => deps.projects.withProject(info))
  }

  const infoOf = async (id: string): Promise<SessionInfo | undefined> => {
    const live = registry().get(id)?.info()
    if (live) {
      return deps.projects.withProject(live)
    }
    const record = await deps.refs.parking?.get(id)
    return record ? deps.projects.withProject(record.info) : undefined
  }

  const sender = async (from: string): Promise<SessionInfo> => {
    const info = await infoOf(from)
    if (!info) {
      throw new Error(`unknown sender session: ${from}`)
    }
    return info
  }

  const underRateLimit = (from: string, to: string): boolean => {
    const key = `${from}->${to}`
    const now = Date.now()
    const recent = (sent.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
    if (recent.length >= perMinute) {
      sent.set(key, recent)
      return false
    }
    recent.push(now)
    sent.set(key, recent)
    return true
  }

  const list = async (from: string): Promise<PeerSessionSummary[]> => {
    const me = await sender(from)
    return (await allSessions())
      .filter((info) => visible(me, info))
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .map(peerSummary)
  }

  const peek = async (from: string, sessionId: string, options?: { recent?: number }): Promise<PeerPeek | undefined> => {
    const me = await sender(from)
    const info = await infoOf(sessionId)
    if (!info || !visible(me, info)) {
      return undefined
    }
    const limit = Math.min(Math.max(options?.recent ?? PEER_RECENT_DEFAULT, 0), PEER_RECENT_MAX)
    const runner = registry().get(sessionId)
    const events: SessionEvent[] = []
    if (runner && limit > 0) {
      runner.subscribe((event) => events.push(event), 0, { truncateResults: true, imageRefs: true })()
    }
    return {
      ...peerSummary(info),
      live: runner !== undefined,
      checklist: info.checklist,
      pendingApprovals: runner ? runner.pendingApprovals.map((request) => request.title ?? request.toolName) : [],
      recent: recentLines(events, limit),
    }
  }

  const send = async (from: string, sessionId: string, text: string, options?: PeerSendOptions): Promise<PeerSendResult> => {
    const me = await sender(from)
    if (sessionId === from) {
      return { delivered: false, reason: 'that is this session' }
    }
    if (text.length > maxChars) {
      return {
        delivered: false,
        reason: `message is ${text.length} characters; the limit is ${maxChars}. Write it to a file and send the path.`,
      }
    }
    const target = await infoOf(sessionId)
    if (!target || !visible(me, target)) {
      return { delivered: false, reason: `no such session: ${sessionId}` }
    }
    if (target.status === 'closed' || target.status === 'failed') {
      return { delivered: false, reason: `session ${sessionId} is ${target.status}` }
    }
    const hops = [...(options?.hops ?? inbound.get(from) ?? []), from]
    if (hops.length > maxHops) {
      return {
        delivered: false,
        reason: `${hops.length} messages have passed between sessions without a person speaking; stop and ask your user before continuing.`,
      }
    }
    if (!underRateLimit(from, sessionId)) {
      return { delivered: false, reason: `rate limit: at most ${perMinute} messages a minute to one session. Batch what you have to say.` }
    }
    const runner = (await deps.refs.parking?.ensureLive(sessionId)) ?? registry().get(sessionId)
    if (!runner) {
      return { delivered: false, reason: `session ${sessionId} could not be woken` }
    }
    const before = runner.info().status
    const origin: MessageOrigin = { kind: 'peer', sessionId: from, name: me.title, engine: me.engine, hops }
    try {
      runner.sendMessage(text, undefined, { origin })
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
    }
    inbound.set(sessionId, hops)
    return { delivered: true, sessionId, name: target.title, queued: before === 'running' || before === 'awaiting_approval' }
  }

  // A session id is a handle a person may paste, so a full id and an unambiguous prefix resolve too.
  const mentions = async (from: string, text: string): Promise<PeerMention[]> => {
    const tokens = scanPeerMentions(text)
    if (tokens.length === 0) {
      return []
    }
    const rows = await list(from)
    const byKey = new Map<string, PeerSessionSummary[]>()
    const add = (key: string, row: PeerSessionSummary) => {
      const held = byKey.get(key)
      if (held) {
        held.push(row)
      } else {
        byKey.set(key, [row])
      }
    }
    for (const row of rows) {
      add(peerMentionKey(peerMentionSlug(row.title, row.id)), row)
      add(peerMentionKey(row.id), row)
    }
    const resolved: PeerMention[] = []
    const seen = new Set<string>()
    for (const token of tokens) {
      const key = peerMentionKey(token.body)
      const exact = byKey.get(key)
      // `list` is newest-first, so a shared title resolves to the session that moved last and the
      // envelope names the others rather than choosing silently.
      const matches = exact ?? (key.length >= 4 ? rows.filter((row) => row.id.startsWith(key)) : [])
      const target = matches[0]
      if (!target || (matches.length > 1 && !exact)) {
        continue
      }
      if (seen.has(target.id)) {
        continue
      }
      seen.add(target.id)
      const others = matches.slice(1, 4).map((row) => row.id)
      resolved.push({
        typed: token.body,
        id: target.id,
        name: target.title,
        engine: target.engine,
        status: target.status,
        cwd: target.cwd,
        ...(others.length ? { ambiguousWith: others } : {}),
      })
      if (resolved.length >= PEER_MENTION_MAX) {
        break
      }
    }
    return resolved
  }

  const watch = (runner: Runner): (() => void) =>
    runner.subscribe((event) => {
      if (event.type === 'user_message' && !event.origin && !event.synthetic && event.parentToolUseId == null && !event.replay) {
        inbound.delete(runner.id)
      }
    }, runner.info().lastSeq)

  return { list, peek, send, mentions, watch }
}
