/**
 * Turns the server's session notifications into APNs pushes. Session webhooks are
 * the primitive and this is one consumer of them: it hooks
 * `notifications.onNotification` in-process, but nothing in the server knows that,
 * and push credentials live here and nowhere in `packages/server`.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionInfo, SessionNotification } from '@workerdeck/protocol'
import { type ApnsClient, type ApnsConfig, createApnsClient, loadApnsKey, type ApnsRequest } from './client.ts'
import { createDeviceRegistry, createDeviceRoute, type DeviceRegistry } from './devices.ts'

/** Under APNs' 4 KB payload cap, with room for the alert dictionary to grow. */
const MAX_PAYLOAD_BYTES = 3800
const BODY_LIMIT = 300

export type ApnsForwarder = {
  /** Hand to `createWorkerServer({ notifications: { onNotification } })`. */
  onNotification: (notification: SessionNotification) => void
  /** Mount ahead of the static host; true when it consumed the request. */
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** How many devices are registered, for the startup banner. */
  deviceCount: () => number
  close: () => void
}

/** Category identifiers are wire contract with the app: it registers the
 * Approve/Deny actions under this exact string, and a mismatch means a
 * notification that arrives with no buttons on it. */
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

/** A collapse id is capped at 64 bytes and a session id has no such bound, so
 * hash rather than truncate — two sessions sharing a prefix must not collapse
 * into each other. */
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

/**
 * Build the push for one notification.
 *
 * The payload carries routing and nothing else — `sessionId` to deep-link,
 * `requestId` because a lock-screen Approve has nothing to POST to without it,
 * and `hostId` so a client with two gateways knows which one this came from.
 * Everything else the app fetches over REST the moment it opens; a transcript
 * has no business in a 4 KB envelope.
 */
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
      // Groups a session's notifications together in Notification Center.
      'thread-id': notification.sessionId,
    },
    type: notification.type,
    sessionId: notification.sessionId,
    seq: notification.seq,
    ...(hostId === undefined ? {} : { hostId }),
    ...(notification.request === undefined ? {} : { requestId: notification.request.id }),
  })

  let payload = build(body)
  // The one field that can be arbitrarily long; everything else is bounded by construction.
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES && body.length > 16) {
    body = oneLine(body, Math.floor(body.length / 2))
    payload = build(body)
  }

  return {
    payload,
    // 10 for the two a person is actually waiting on; 5 lets the system batch the rest.
    priority: permission || notification.type === 'session_error' ? 10 : 5,
    // Apple stops trying at the moment the server would have resolved the request: an expired
    // approval on a lock screen is worse than useless.
    expiration:
      permission && notification.request?.expiresAt !== undefined
        ? Math.floor(notification.request.expiresAt / 1000)
        : Math.floor(Date.now() / 1000) + 3600,
    // Permission requests are never collapsed: each is a distinct question with its own
    // `requestId`, and replacing one with the next drops a decision the operator still owes.
    ...(notification.type === 'turn_completed' ? { collapseId: `t:${collapseKey(notification.sessionId)}` } : {}),
  }
}

export const createApnsForwarder = async (options: {
  config: ApnsConfig
  /** Where the device registry is persisted; null keeps it in memory. */
  stateDir: string | null
  /** Guards `/apns/devices` — the instance's own `authenticate`. */
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

  /** Per-session delivery chain, so a session's pushes arrive in the order the
   * events happened — which matters precisely because `turn_completed` collapses
   * and an out-of-order pair would leave the older text on screen. */
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
      // Drop the chain once it drains: a long-lived gateway must not keep one promise per session.
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
