import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ApnsEnvironment } from './client.ts'
import { readBody, respondJson } from '../lib/http.ts'

// `starting` is a card the gateway has asked APNs to raise but whose update token has not come
// back yet. It is the state that forbids a second start for the same pair — that is how a phone
// ends up with two cards for one session.
export type ActivityPhase = 'starting' | 'live' | 'ending'

export type ActivityRecord = {
  deviceToken: string
  sessionId: string
  hostId?: string
  environment: ApnsEnvironment
  updateToken?: string
  phase: ActivityPhase
  startedAt: number
  // Not persisted: both are optimisations whose loss across a restart costs one redundant push,
  // and a boot ends every card it finds anyway.
  lastPushAt?: number
  contentHash?: string
}

export type ActivityRegistry = {
  list(): ActivityRecord[]
  get(deviceToken: string, sessionId: string): ActivityRecord | undefined
  forSession(sessionId: string): ActivityRecord[]
  start(record: Omit<ActivityRecord, 'phase' | 'startedAt'> & { startedAt?: number }): Promise<ActivityRecord>
  // Route-side: the app reporting a token it was handed. Matching by `(deviceToken, sessionId)` when
  // the app knows its device token, else by the one tokenless record for the session.
  attach(
    match: { sessionId: string; deviceToken?: string; environment: ApnsEnvironment },
    updateToken: string,
  ): Promise<ActivityRecord | undefined>
  touch(
    deviceToken: string,
    sessionId: string,
    changes: Partial<Pick<ActivityRecord, 'phase' | 'lastPushAt' | 'contentHash'>>,
  ): Promise<void>
  remove(deviceToken: string, sessionId: string): Promise<void>
  removeByUpdateToken(updateToken: string): Promise<void>
}

const FILENAME = 'apns-activities.json'
const TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/
const MAX_BODY_BYTES = 4096

function isEnvironment(value: unknown): value is ApnsEnvironment {
  return value === 'development' || value === 'production'
}

function keyOf(deviceToken: string, sessionId: string): string {
  return `${deviceToken}:${sessionId}`
}

type Persisted = Pick<ActivityRecord, 'deviceToken' | 'sessionId' | 'hostId' | 'environment' | 'updateToken' | 'phase' | 'startedAt'>

function persistable(record: ActivityRecord): Persisted {
  const { deviceToken, sessionId, hostId, environment, updateToken, phase, startedAt } = record
  return { deviceToken, sessionId, hostId, environment, updateToken, phase, startedAt }
}

export async function createActivityRegistry(options: {
  dir: string | null
  onError?: (error: unknown, context: { op: string; path: string }) => void
}): Promise<ActivityRegistry> {
  const path = options.dir === null ? null : join(options.dir, FILENAME)
  const records = new Map<string, ActivityRecord>()

  if (path !== null) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { activities?: ActivityRecord[] }
      for (const record of parsed.activities ?? []) {
        if (typeof record?.deviceToken === 'string' && typeof record.sessionId === 'string' && isEnvironment(record.environment)) {
          records.set(keyOf(record.deviceToken, record.sessionId), record)
        }
      }
    } catch {
      // Same rule as the device registry: missing, unreadable and corrupt all mean "start empty".
      // A lost record costs an orphaned card that `stale-date` and the app's reconcile both close.
    }
  }

  const persist = async (): Promise<void> => {
    if (path === null) {
      return
    }
    try {
      await mkdir(options.dir!, { recursive: true, mode: 0o700 })
      await writeFile(path, `${JSON.stringify({ activities: [...records.values()].map(persistable) }, null, 2)}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
    } catch (error) {
      options.onError?.(error, { op: 'write', path })
    }
  }

  return {
    list: () => [...records.values()],
    get: (deviceToken, sessionId) => records.get(keyOf(deviceToken, sessionId)),
    forSession: (sessionId) => [...records.values()].filter((record) => record.sessionId === sessionId),
    async start(record) {
      const existing = records.get(keyOf(record.deviceToken, record.sessionId))
      if (existing !== undefined) {
        return existing
      }
      const created: ActivityRecord = { ...record, phase: 'starting', startedAt: record.startedAt ?? Date.now() }
      records.set(keyOf(created.deviceToken, created.sessionId), created)
      await persist()
      return created
    },
    async attach(match, updateToken) {
      const direct = match.deviceToken === undefined ? undefined : records.get(keyOf(match.deviceToken, match.sessionId))
      const candidates =
        direct !== undefined
          ? [direct]
          : [...records.values()].filter(
              (record) =>
                record.sessionId === match.sessionId && record.environment === match.environment && record.updateToken === undefined,
            )
      // Ambiguity is two devices waiting on one session, and guessing would paint the wrong phone.
      const target = candidates.length === 1 ? candidates[0] : undefined
      if (target === undefined || target.updateToken === updateToken) {
        return target
      }
      target.updateToken = updateToken
      target.phase = 'live'
      await persist()
      return target
    },
    async touch(deviceToken, sessionId, changes) {
      const record = records.get(keyOf(deviceToken, sessionId))
      if (record === undefined) {
        return
      }
      const structural = changes.phase !== undefined && changes.phase !== record.phase
      Object.assign(record, changes)
      if (structural) {
        await persist()
      }
    },
    async remove(deviceToken, sessionId) {
      if (!records.delete(keyOf(deviceToken, sessionId))) {
        return
      }
      await persist()
    },
    async removeByUpdateToken(updateToken) {
      let removed = false
      for (const [key, record] of records) {
        if (record.updateToken === updateToken) {
          records.delete(key)
          removed = true
        }
      }
      if (removed) {
        await persist()
      }
    },
  }
}

export function createActivityRoute(
  registry: ActivityRegistry | null,
  authenticate: (req: IncomingMessage) => unknown,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      return false
    }
    if (pathname !== '/apns/activities') {
      return false
    }

    if (registry === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('this gateway runs without push\n')
      return true
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end()
      return true
    }
    if (authenticate(req) === null) {
      respondJson(res, 401, { error: 'unauthorized' })
      return true
    }

    const raw = await readBody(req, MAX_BODY_BYTES)
    if (raw === null) {
      respondJson(res, 413, { error: 'body too large' })
      res.once('finish', () => req.destroy())
      return true
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      respondJson(res, 400, { error: 'invalid JSON body' })
      return true
    }

    const token = body.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      respondJson(res, 400, { error: 'token must be a hex Live Activity update token' })
      return true
    }

    if (req.method === 'DELETE') {
      await registry.removeByUpdateToken(token)
      res.writeHead(204).end()
      return true
    }

    const sessionId = body.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      respondJson(res, 400, { error: 'sessionId is required' })
      return true
    }
    if (!isEnvironment(body.environment)) {
      respondJson(res, 400, { error: "environment must be 'development' or 'production'" })
      return true
    }
    const deviceToken = typeof body.deviceToken === 'string' && TOKEN_PATTERN.test(body.deviceToken) ? body.deviceToken : undefined

    const record = await registry.attach({ sessionId, deviceToken, environment: body.environment }, token)
    if (record === undefined) {
      // A card this gateway never raised. The app forgets the token rather than retrying, which is
      // what stops a phone with two gateways from POSTing at whichever one answers first.
      respondJson(res, 404, { error: 'no activity awaiting a token for this session' })
      return true
    }
    respondJson(res, 200, { attached: true, sessionId })
    return true
  }
}
