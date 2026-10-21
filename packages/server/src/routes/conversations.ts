import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ConversationSummary,
  ConversationsResponse,
  NewConversationRequest,
  SessionEvent,
  SessionInfo,
  SettlePendingPromptRequest,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import type { CutGuard } from '../services/conversation-cuts.ts'
import type { ConversationEntry, SessionRecord } from '../services/session-records.ts'
import { sessionInfoOf } from './session-lookup.ts'

type CutBody = Partial<NewConversationRequest> & Partial<SettlePendingPromptRequest> & { inputRevision?: unknown }

// The info a history entry is authorized and shown as: its frozen projection, never the current record.
export function entryInfo(id: string, entry: ConversationEntry): SessionInfo {
  return {
    id,
    status: 'closed',
    cwd: entry.cwd,
    ...(entry.profile ? { profile: entry.profile } : {}),
    engine: entry.engine,
    createdAt: entry.startedAt,
    lastSeq: 0,
    conversation: entry.n,
    pendingPermissionCount: 0,
    ...(entry.auth.owner ? { owner: entry.auth.owner } : {}),
    ...(entry.auth.scope ? { scope: entry.auth.scope } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.transcript ? { transcript: entry.transcript } : {}),
  }
}

export function entrySummary(entry: ConversationEntry): ConversationSummary {
  return {
    n: entry.n,
    engine: entry.engine,
    ...(entry.profile ? { profile: entry.profile } : {}),
    cwd: entry.cwd,
    ...(entry.engineSessionId ? { engineSessionId: entry.engineSessionId } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.costUsd === undefined ? {} : { costUsd: entry.costUsd }),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    ...(entry.transcript ? { transcript: entry.transcript } : {}),
  }
}

// Bypasses `resolveSession`: who may read a past conversation is decided by its entry, not by the current record.
export async function handleConversations(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  conversation: string | undefined,
  auth: AuthContext,
): Promise<void> {
  const { cuts } = ctx
  const record = await ctx.records.get(id)
  const current = record?.closedAt === undefined ? await sessionInfoOf(ctx, id) : undefined
  const seesCurrent = current !== undefined && ctx.auth.canSee(auth, current)
  const visible = (record?.conversations ?? []).filter((entry) => ctx.auth.canSee(auth, entryInfo(id, entry)))
  if (req.method === 'GET') {
    if (conversation === undefined) {
      if (!seesCurrent && visible.length === 0) {
        fail(404, 'session not found')
      }
      const body: ConversationsResponse = {
        ...(seesCurrent ? { conversation: record?.conversation ?? 1 } : {}),
        ...(record?.closedAt === undefined ? {} : { closed: true as const }),
        history: visible.map(entrySummary),
        ...(seesCurrent && record?.pendingPrompt ? { pendingPrompt: record.pendingPrompt } : {}),
        ...(seesCurrent && record?.startFailed ? { startFailed: record.startFailed } : {}),
      }
      json(res, 200, body)
      return
    }
    const entry = visible.find((candidate) => String(candidate.n) === conversation)
    if (!entry) {
      fail(404, 'conversation not found')
    }
    const history = await historyEvents(ctx, id, entry)
    if (!history) {
      fail(502, 'this conversation could not be read from the engine store; try again')
    }
    const info = entryInfo(id, entry)
    json(res, 200, {
      info: ctx.projects.withProject(history.transcript ? { ...info, transcript: history.transcript } : info),
      events: history.events,
    })
    return
  }
  requireMethod(req, 'POST')
  if (!seesCurrent) {
    fail(404, 'session not found')
  }
  const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as CutBody
  if (typeof body.expectedGeneration !== 'number') {
    fail(400, 'expectedGeneration is required')
  }
  const expected = body.expectedGeneration
  const guard = conversationGuard(ctx, id, auth, expected)
  if (conversation === 'retry') {
    json(res, 200, await cuts.retryStart(id, guard))
    return
  }
  if (conversation === 'pending') {
    await cuts.settlePendingPrompt(id, body.send === true, guard)
    json(res, 200, { ok: true })
    return
  }
  if (conversation === 'discard') {
    if (typeof body.inputRevision !== 'string' || body.inputRevision === '') {
      fail(400, 'inputRevision is required')
    }
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      fail(400, 'prompt must be a string')
    }
    const discard = { revision: body.inputRevision }
    json(
      res,
      200,
      await cuts.cut(id, { expectedGeneration: expected, reason: 'user', discard, ...(body.prompt ? { prompt: body.prompt } : {}) }, guard),
    )
    return
  }
  if (conversation !== undefined) {
    fail(404, 'not found')
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') {
    fail(400, 'prompt must be a string')
  }
  if (body.target !== undefined && (typeof body.target !== 'object' || body.target === null)) {
    fail(400, 'target must be an object')
  }
  if (body.target?.scope !== undefined && !ctx.auth.isOperator(auth)) {
    fail(403, 'only an operator can change a session scope')
  }
  if (body.target?.profile !== undefined && auth.allowedProfiles && !auth.allowedProfiles.includes(body.target.profile)) {
    fail(403, `profile not allowed: ${body.target.profile}`)
  }
  json(
    res,
    200,
    await cuts.cut(
      id,
      {
        expectedGeneration: expected,
        reason: 'user',
        ...(body.prompt ? { prompt: body.prompt } : {}),
        ...(body.target ? { target: pickTarget(body.target) } : {}),
      },
      guard,
    ),
  )
}

// Re-run under the lifecycle lock: the body may arrive long after the caller's checks, across a cut or a scope change.
export function conversationGuard(ctx: ServerContext, id: string, auth: AuthContext, expected: number): CutGuard {
  return async (latest: SessionRecord | null): Promise<void> => {
    const now = latest?.closedAt === undefined ? await sessionInfoOf(ctx, id) : undefined
    if (!now || !ctx.auth.canSee(auth, now)) {
      fail(404, 'session not found')
    }
    const at = latest?.conversation ?? 1
    if (at !== expected) {
      fail(409, `the session moved on to conversation ${at}`)
    }
  }
}

// A stale-command check for the `/agents` doors: the conversation the caller acted on, named explicitly.
export function expectedGenerationOf(body: { expectedGeneration?: unknown }): number {
  if (typeof body.expectedGeneration !== 'number' || !Number.isInteger(body.expectedGeneration)) {
    fail(400, 'expectedGeneration is required')
  }
  return body.expectedGeneration
}

function pickTarget(target: NonNullable<NewConversationRequest['target']>): NonNullable<NewConversationRequest['target']> {
  const { profile, cwd, model, scope } = target
  return {
    ...(typeof profile === 'string' ? { profile } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(scope && typeof scope === 'object' ? { scope } : {}),
  }
}

export type HistoryView = { events: SessionEvent[]; transcript?: 'unavailable' }

// Undefined is a failed read, worth retrying; an empty transcript the engine no longer has says so as `unavailable`.
export async function historyEvents(ctx: ServerContext, id: string, entry: ConversationEntry): Promise<HistoryView | undefined> {
  if (entry.snapshot) {
    return { events: entry.snapshot.events }
  }
  if (entry.transcript === 'unavailable') {
    return { events: [], transcript: 'unavailable' }
  }
  const read = await ctx.history.read({
    sessionId: id,
    engine: entry.engine,
    ...(entry.engineSessionId ? { engineSessionId: entry.engineSessionId } : {}),
    ...(entry.profile ? { profile: entry.profile } : {}),
    ...(entry.engineHome ? { home: entry.engineHome } : {}),
    cwd: entry.cwd,
  })
  switch (read.kind) {
    case 'ok': {
      return { events: read.events.map((event, index) => ({ ...event, seq: index + 1, ts: entry.endedAt }) as SessionEvent) }
    }
    case 'missing': {
      return { events: [], transcript: 'unavailable' }
    }
    default: {
      return undefined
    }
  }
}
