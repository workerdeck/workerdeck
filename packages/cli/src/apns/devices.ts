import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { SessionNotificationType } from '@workerdeck/protocol'
import type { ApnsEnvironment } from './client.ts'
import { readBody, respondJson } from '../lib/http.ts'

export const NOTIFY_EVENTS: readonly SessionNotificationType[] = [
  'permission_requested',
  'turn_completed',
  'session_error',
  'session_closed',
]

// A session closing is bookkeeping, not news — it fires whenever a tab goes away — so it is out of
// the default. The other three are what someone is actually waiting on. A device that says nothing
// gets this; `[]` is how a device says "no alerts at all" without giving up its token.
export const DEFAULT_NOTIFY: readonly SessionNotificationType[] = ['permission_requested', 'turn_completed', 'session_error']

export type DeviceRecord = {
  token: string
  environment: ApnsEnvironment
  // The client's own id for this gateway, echoed back in every payload so an app with two gateways knows which woke it; never interpreted here.
  hostId?: string
  bundleId?: string
  platform?: string
  // The Live Activity push-to-start token: device-level like the alert token, and the only way a
  // gateway can raise a card on a phone whose app is not running. Absent means this device cannot
  // be started at — an older app, or Live Activities switched off in Settings.
  liveActivityStartToken?: string
  // Which notification types this device wants. Absent means `DEFAULT_NOTIFY`; an explicit empty
  // array means none. Per-device rather than per-gateway because a phone and an iPad watching the
  // same sessions do not want the same interruptions.
  notify?: SessionNotificationType[]
  updatedAt: number
}

export type DeviceRegistry = {
  list(): DeviceRecord[]
  register(record: Omit<DeviceRecord, 'updatedAt'>): Promise<void>
  remove(token: string): Promise<void>
  clearStartToken(token: string): Promise<void>
}

const FILENAME = 'apns-devices.json'
// 64 hex chars today; the upper bound is loose because Apple reserved the right to grow the token.
const TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/
const MAX_BODY_BYTES = 4096

function isEnvironment(value: unknown): value is ApnsEnvironment {
  return value === 'development' || value === 'production'
}

function isNotifyList(value: unknown): value is SessionNotificationType[] {
  return Array.isArray(value) && value.every((entry) => NOTIFY_EVENTS.includes(entry as SessionNotificationType))
}

function sameNotify(a: SessionNotificationType[] | undefined, b: SessionNotificationType[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

export function wantsNotification(device: Pick<DeviceRecord, 'notify'>, type: SessionNotificationType): boolean {
  return (device.notify ?? DEFAULT_NOTIFY).includes(type)
}

export async function createDeviceRegistry(options: {
  dir: string | null
  onError?: (error: unknown, context: { op: string; path: string }) => void
}): Promise<DeviceRegistry> {
  const path = options.dir === null ? null : join(options.dir, FILENAME)
  const devices = new Map<string, DeviceRecord>()

  if (path !== null) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { devices?: DeviceRecord[] }
      for (const record of parsed.devices ?? []) {
        if (typeof record?.token === 'string' && isEnvironment(record.environment)) {
          devices.set(record.token, record)
        }
      }
    } catch {
      // Missing, unreadable and corrupt all mean "start empty": push is a side channel and must never refuse a boot.
    }
  }

  const persist = async (): Promise<void> => {
    if (path === null) {
      return
    }
    try {
      await mkdir(options.dir!, { recursive: true, mode: 0o700 })
      await writeFile(path, `${JSON.stringify({ devices: [...devices.values()] }, null, 2)}\n`, {
        mode: 0o600,
      })
      // writeFile's mode applies only on creation, so an existing file would keep its looser bits.
      await chmod(path, 0o600)
    } catch (error) {
      options.onError?.(error, { op: 'write', path })
    }
  }

  return {
    list: () => [...devices.values()],
    async register(record) {
      const existing = devices.get(record.token)
      devices.set(record.token, { ...record, updatedAt: Date.now() })
      if (
        existing !== undefined &&
        existing.environment === record.environment &&
        existing.hostId === record.hostId &&
        existing.liveActivityStartToken === record.liveActivityStartToken &&
        sameNotify(existing.notify, record.notify)
      ) {
        return
      }
      await persist()
    },
    async clearStartToken(token) {
      const existing = devices.get(token)
      if (existing === undefined || existing.liveActivityStartToken === undefined) {
        return
      }
      delete existing.liveActivityStartToken
      await persist()
    },
    async remove(token) {
      if (!devices.delete(token)) {
        return
      }
      await persist()
    },
  }
}

export function createDeviceRoute(
  registry: DeviceRegistry | null,
  authenticate: (req: IncomingMessage) => unknown,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      return false
    }
    if (pathname !== '/apns/devices') {
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
    // A device token is an address this gateway can buzz, so an unauthenticated register lets anyone reachable aim it.
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
      respondJson(res, 400, { error: 'token must be a hex APNs device token' })
      return true
    }

    if (req.method === 'DELETE') {
      await registry.remove(token)
      res.writeHead(204).end()
      return true
    }

    if (!isEnvironment(body.environment)) {
      respondJson(res, 400, { error: "environment must be 'development' or 'production'" })
      return true
    }
    const optionalString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined

    // Omitted leaves whatever is on record — an older app that never sends the field must not erase
    // it — while an explicit null is how the app says Live Activities were switched off.
    const startTokenGiven = Object.hasOwn(body, 'liveActivityStartToken')
    const startToken = body.liveActivityStartToken
    if (startTokenGiven && startToken !== null && (typeof startToken !== 'string' || !TOKEN_PATTERN.test(startToken))) {
      respondJson(res, 400, { error: 'liveActivityStartToken must be a hex token or null' })
      return true
    }
    // Same three-state rule as the start token: omitted leaves the record alone, so an older app
    // that never sends the field keeps whatever it last chose rather than being reset to defaults.
    const notifyGiven = Object.hasOwn(body, 'notify')
    if (notifyGiven && !isNotifyList(body.notify)) {
      respondJson(res, 400, { error: `notify must be an array of ${NOTIFY_EVENTS.join(', ')}` })
      return true
    }
    const previous = registry.list().find((record) => record.token === token)
    const liveActivityStartToken = startTokenGiven ? ((startToken as string | null) ?? undefined) : previous?.liveActivityStartToken
    const notify = notifyGiven ? (body.notify as SessionNotificationType[]) : previous?.notify

    await registry.register({
      token,
      environment: body.environment,
      hostId: optionalString(body.hostId),
      bundleId: optionalString(body.bundleId),
      platform: optionalString(body.platform),
      ...(liveActivityStartToken === undefined ? {} : { liveActivityStartToken }),
      ...(notify === undefined ? {} : { notify }),
    })
    respondJson(res, 200, { registered: true, environment: body.environment })
    return true
  }
}
