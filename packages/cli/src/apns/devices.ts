import type { SessionNotificationType } from '@workerdeck/protocol'
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

export const NOTIFY_EVENTS: readonly SessionNotificationType[] = [
  'permission_requested',
  'turn_completed',
  'session_error',
  'session_closed',
]

// A session closing is bookkeeping, not news - it fires whenever a tab goes away - so it is out of
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
  // be started at - an older app, or Live Activities switched off in Settings.
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
// Every registered device is sent every session's notifications, and the file is rewritten per registration.
export const MAX_DEVICES = 64

function isNotifyList(value: unknown): value is SessionNotificationType[] {
  return Array.isArray(value) && value.every((entry) => NOTIFY_EVENTS.includes(entry as SessionNotificationType))
}

function sameNotify(a: SessionNotificationType[] | undefined, b: SessionNotificationType[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined
}

export function wantsNotification(device: Pick<DeviceRecord, 'notify'>, type: SessionNotificationType): boolean {
  return (device.notify ?? DEFAULT_NOTIFY).includes(type)
}

export async function createDeviceRegistry(options: JsonRegistryOptions): Promise<DeviceRegistry> {
  const file = jsonRecordFile(options, FILENAME, 'devices')
  const devices = new Map<string, DeviceRecord>()
  for (const record of (await file.load()) as DeviceRecord[]) {
    if (typeof record?.token === 'string' && isEnvironment(record.environment)) {
      devices.set(record.token, record)
    }
  }
  const persist = (): Promise<void> => file.save([...devices.values()])

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

export function createDeviceRoute(registry: DeviceRegistry | null, authenticate: RequestAuthenticator): PushRouteHandler {
  return jsonPushRoute('/apns/devices', registry, authenticate, async (devices, req, res, body) => {
    const token = body.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      respondJson(res, 400, { error: 'token must be a hex APNs device token' })
      return
    }

    if (req.method === 'DELETE') {
      await devices.remove(token)
      res.writeHead(204).end()
      return
    }

    if (!isEnvironment(body.environment)) {
      respondJson(res, 400, { error: "environment must be 'development' or 'production'" })
      return
    }
    // Omitted leaves whatever is on record - an older app that never sends the field must not erase
    // it - while an explicit null is how the app says Live Activities were switched off.
    const startTokenGiven = Object.hasOwn(body, 'liveActivityStartToken')
    const startToken = body.liveActivityStartToken
    if (startTokenGiven && startToken !== null && (typeof startToken !== 'string' || !TOKEN_PATTERN.test(startToken))) {
      respondJson(res, 400, { error: 'liveActivityStartToken must be a hex token or null' })
      return
    }
    // Same three-state rule as the start token: omitted leaves the record alone, so an older app
    // that never sends the field keeps whatever it last chose rather than being reset to defaults.
    const notifyGiven = Object.hasOwn(body, 'notify')
    if (notifyGiven && !isNotifyList(body.notify)) {
      respondJson(res, 400, { error: `notify must be an array of ${NOTIFY_EVENTS.join(', ')}` })
      return
    }
    const previous = devices.list().find((record) => record.token === token)
    if (previous === undefined && devices.list().length >= MAX_DEVICES) {
      respondJson(res, 409, { error: `device limit reached (${MAX_DEVICES}); unregister one first` })
      return
    }
    const liveActivityStartToken = startTokenGiven ? ((startToken as string | null) ?? undefined) : previous?.liveActivityStartToken
    const notify = notifyGiven ? (body.notify as SessionNotificationType[]) : previous?.notify

    await devices.register({
      token,
      environment: body.environment,
      hostId: optionalString(body.hostId),
      bundleId: optionalString(body.bundleId),
      platform: optionalString(body.platform),
      ...(liveActivityStartToken === undefined ? {} : { liveActivityStartToken }),
      ...(notify === undefined ? {} : { notify }),
    })
    respondJson(res, 200, { registered: true, environment: body.environment })
  })
}
