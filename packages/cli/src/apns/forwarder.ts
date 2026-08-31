import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionInfo, SessionNotification } from '@workerdeck/protocol'
import { type ApnsClient, type ApnsConfig, createApnsClient, loadApnsKey, type ApnsRequest } from './client.ts'
import { createDeviceRegistry, createDeviceRoute, type DeviceRegistry } from './devices.ts'

// Under APNs' 4 KB payload cap, with room for the alert dictionary to grow.
const MAX_PAYLOAD_BYTES = 3800
const BODY_LIMIT = 300

export type ApnsForwarder = {
  onNotification: (notification: SessionNotification) => void
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  deviceCount: () => number
  close: () => void
}

// Wire contract with the iOS app, which registers its Approve/Deny actions under these exact strings; a mismatch means a notification with no buttons.
const CATEGORY = {
  permission: 'PERMISSION_REQUEST',
  event: 'SESSION_EVENT',
} as const

const label = (session: SessionInfo): string => {
  const title = session.title?.trim()
  if (title !== undefined && title !== '') {
    return title
  }
  const leaf = session.cwd.split('/').filter(Boolean).at(-1)
  return leaf !== undefined && leaf !== '' ? leaf : session.id
}

const oneLine = (text: string | undefined, limit = BODY_LIMIT): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

// Hashed rather than truncated to 64 bytes: two session ids sharing a prefix must not collapse into each other.
const collapseKey = (sessionId: string): string => createHash('sha256').update(sessionId).digest('base64url').slice(0, 32)

const titleFor = (notification: SessionNotification, name: string): string => {
  switch (notification.type) {
    case 'permission_requested': {
      return `Approval needed — ${name}`
    }
    case 'turn_completed': {
      return notification.result?.isError === true ? `Turn failed — ${name}` : name
    }
    case 'session_error': {
      return `Session error — ${name}`
    }
    case 'session_closed': {
      return `Session ended — ${name}`
    }
    default: {
      return name
    }
  }
}

const bodyFor = (notification: SessionNotification): string => {
  const preview = oneLine(notification.preview)
  if (preview !== '') {
    return preview
  }
  switch (notification.type) {
    case 'permission_requested': {
      return 'The agent is waiting for your approval.'
    }
    case 'turn_completed': {
      return 'The turn finished.'
    }
    case 'session_closed': {
      return `Closed by the ${notification.reason ?? 'server'}.`
    }
    default: {
      return 'Something needs your attention.'
    }
  }
}

// The payload carries routing only — never transcript text — and `requestId` is what a lock-screen Approve has to POST to.
export const buildPush = (
  notification: SessionNotification,
  hostId: string | undefined,
): Omit<ApnsRequest, 'deviceToken' | 'environment'> => {
  const permission = notification.type === 'permission_requested'
  const name = label(notification.session)
  let body = bodyFor(notification)

  const build = (text: string): Record<string, unknown> => ({
    aps: {
      alert: { title: titleFor(notification, name), body: text },
      sound: 'default',
      category: permission ? CATEGORY.permission : CATEGORY.event,
      'thread-id': notification.sessionId,
    },
    type: notification.type,
    sessionId: notification.sessionId,
    seq: notification.seq,
    ...(hostId === undefined ? {} : { hostId }),
    ...(notification.request === undefined ? {} : { requestId: notification.request.id }),
  })

  let payload = build(body)
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES && body.length > 16) {
    body = oneLine(body, Math.floor(body.length / 2))
    payload = build(body)
  }

  return {
    payload,
    priority: permission || notification.type === 'session_error' ? 10 : 5,
    // Expire an approval push exactly when the server would have timed the request out; a dead approval on a lock screen is worse than none.
    expiration:
      permission && notification.request?.expiresAt !== undefined
        ? Math.floor(notification.request.expiresAt / 1000)
        : Math.floor(Date.now() / 1000) + 3600,
    ...(notification.type === 'turn_completed' ? { collapseId: `t:${collapseKey(notification.sessionId)}` } : {}),
  }
}

export const createApnsForwarder = async (options: {
  config: ApnsConfig
  stateDir: string | null
  authenticate: (req: IncomingMessage) => unknown
  warn?: (message: string) => void
}): Promise<ApnsForwarder> => {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[workerdeck] apns: ${message}\n`))
  const key = await loadApnsKey(options.config.keyFile)
  const client: ApnsClient = createApnsClient(options.config, key)
  const registry: DeviceRegistry = await createDeviceRegistry({
    dir: options.stateDir,
    onError: (error, context) =>
      warn(`device registry ${context.op} failed for ${context.path}: ` + `${error instanceof Error ? error.message : String(error)}`),
  })
  const handleRequest = createDeviceRoute(registry, options.authenticate)
  const fallbackEnvironment = options.config.production === false ? 'development' : 'production'

  // Per-session delivery chain: `turn_completed` collapses, so an out-of-order pair leaves the older text on the lock screen.
  const chains = new Map<string, Promise<void>>()

  const deliver = async (notification: SessionNotification): Promise<void> => {
    const devices = registry.list()
    if (devices.length === 0) {
      return
    }
    await Promise.all(
      devices.map(async (device) => {
        const push = buildPush(notification, device.hostId)
        const result = await client.send({
          ...push,
          deviceToken: device.token,
          environment: device.environment ?? fallbackEnvironment,
        })
        if (result.ok) {
          return
        }
        if (result.unregistered) {
          await registry.remove(device.token)
          return
        }
        warn(`push to ${device.token.slice(0, 8)}… failed: ${result.reason} (${result.status})`)
      }),
    )
  }

  return {
    onNotification(notification) {
      const previous = chains.get(notification.sessionId) ?? Promise.resolve()
      const next = previous.then(() =>
        deliver(notification).catch((error: unknown) => {
          warn(error instanceof Error ? error.message : String(error))
        }),
      )
      chains.set(notification.sessionId, next)
      void next.then(() => {
        if (chains.get(notification.sessionId) === next) {
          chains.delete(notification.sessionId)
        }
      })
    },
    handleRequest,
    deviceCount: () => registry.list().length,
    close: client.close,
  }
}
