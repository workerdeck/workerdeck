import type { ApnsEnvironment } from './client.ts'
import {
  isEnvironment,
  jsonPushRoute,
  jsonRecordFile,
  TOKEN_PATTERN,
  type JsonRegistryOptions,
  type PushRouteHandler,
} from './json-registry.ts'
import { respondJson, type RequestAuthenticator } from '../lib/http.ts'

// `starting` is a card the gateway has asked APNs to raise but whose update token has not come
// back yet. It is the state that forbids a second start for the same pair - that is how a phone
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

function keyOf(deviceToken: string, sessionId: string): string {
  return `${deviceToken}:${sessionId}`
}

type Persisted = Pick<ActivityRecord, 'deviceToken' | 'sessionId' | 'hostId' | 'environment' | 'updateToken' | 'phase' | 'startedAt'>

function persistable(record: ActivityRecord): Persisted {
  const { deviceToken, sessionId, hostId, environment, updateToken, phase, startedAt } = record
  return { deviceToken, sessionId, hostId, environment, updateToken, phase, startedAt }
}

export async function createActivityRegistry(options: JsonRegistryOptions): Promise<ActivityRegistry> {
  const file = jsonRecordFile(options, FILENAME, 'activities')
  const records = new Map<string, ActivityRecord>()
  // A lost record costs an orphaned card that `stale-date` and the app's reconcile both close.
  for (const record of (await file.load()) as ActivityRecord[]) {
    if (typeof record?.deviceToken === 'string' && typeof record.sessionId === 'string' && isEnvironment(record.environment)) {
      records.set(keyOf(record.deviceToken, record.sessionId), record)
    }
  }
  const persist = (): Promise<void> => file.save([...records.values()].map(persistable))

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

export function createActivityRoute(registry: ActivityRegistry | null, authenticate: RequestAuthenticator): PushRouteHandler {
  return jsonPushRoute('/apns/activities', registry, authenticate, async (activities, req, res, body) => {
    const token = body.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      respondJson(res, 400, { error: 'token must be a hex Live Activity update token' })
      return
    }

    if (req.method === 'DELETE') {
      await activities.removeByUpdateToken(token)
      res.writeHead(204).end()
      return
    }

    const sessionId = body.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      respondJson(res, 400, { error: 'sessionId is required' })
      return
    }
    if (!isEnvironment(body.environment)) {
      respondJson(res, 400, { error: "environment must be 'development' or 'production'" })
      return
    }
    const deviceToken = typeof body.deviceToken === 'string' && TOKEN_PATTERN.test(body.deviceToken) ? body.deviceToken : undefined

    const record = await activities.attach({ sessionId, deviceToken, environment: body.environment }, token)
    if (record === undefined) {
      // A card this gateway never raised. The app forgets the token rather than retrying, which is
      // what stops a phone with two gateways from POSTing at whichever one answers first.
      respondJson(res, 404, { error: 'no activity awaiting a token for this session' })
      return
    }
    respondJson(res, 200, { attached: true, sessionId })
  })
}
