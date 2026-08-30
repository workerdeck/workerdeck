import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ApnsEnvironment } from './client.ts'

/**
 * The device-token registry, and the route that fills it.
 *
 * This has to live *somewhere*, and the point of the webhooks-first decision is
 * that it is not `packages/server`: the OSS gateway stays credential-free and
 * knows nothing about APNs. So the turnkey CLI mounts its own route through the
 * server's `fallback` hook — the same seam that serves the dashboard — and
 * registration lands on the gateway's own origin, behind the auth key that
 * already guards everything else.
 *
 * Storage is a JSON file under the state dir with the same 0600 posture as
 * `auth-key`. Device tokens are not secrets in the way an auth key is, but they
 * are a list of which phones belong to the operator, and there is no reason for
 * every user on the machine to read it.
 */

export type DeviceRecord = {
  /** Hex APNs device token. */
  token: string
  environment: ApnsEnvironment
  /**
   * Opaque to us: the client's own id for this gateway, echoed back in every
   * payload. It is what lets an app configured with two gateways tell which one
   * woke it — we store the string and never interpret it.
   */
  hostId?: string
  bundleId?: string
  platform?: string
  updatedAt: number
}

export type DeviceRegistry = {
  list(): DeviceRecord[]
  register(record: Omit<DeviceRecord, 'updatedAt'>): Promise<void>
  remove(token: string): Promise<void>
}

const FILENAME = 'apns-devices.json'
/** Apple's tokens are 64 hex chars today. The upper bound is generous because
 * Apple has reserved the right to grow them; the lower one just rejects junk. */
const TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/
const MAX_BODY_BYTES = 4096

const isEnvironment = (value: unknown): value is ApnsEnvironment => value === 'development' || value === 'production'

/**
 * `dir` null keeps the registry in memory: a restart then forgets every token,
 * which is survivable because the app re-registers on launch, but it does mean
 * an instance with no state dir goes quiet until each phone is next opened.
 */
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
      // Missing, unreadable, or corrupt all land here: start empty rather than
      // refusing to boot over a side channel. Every client re-registers anyway.
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
      // writeFile's mode only applies on creation, so an existing file with
      // looser bits would keep them.
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
      // A repeat registration with nothing new to say is the common case — the
      // app re-registers on every launch — and rewriting the file for it is
      // pointless I/O.
      if (existing !== undefined && existing.environment === record.environment && existing.hostId === record.hostId) {
        return
      }
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

const respond = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })

/**
 * `POST /apns/devices` to register a token, `DELETE /apns/devices` to drop one.
 * Returns true when it consumed the request.
 *
 * Deliberately outside `/v1`: this is the forwarder's own surface, not part of
 * the protocol `packages/protocol` defines, and a client that finds a 404 here
 * has simply reached a gateway running without push configured.
 *
 * DELETE exists so removing a gateway from the app can stop its pushes. Without
 * it a forgotten server keeps buzzing a phone that no longer has any way to act
 * on what it says.
 */
export function createDeviceRoute(
  registry: DeviceRegistry,
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

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end()
      return true
    }
    // The same operator secret that guards everything else. A device token is
    // an address this gateway can buzz, so handing one out unauthenticated
    // would let anyone who can reach the port aim it.
    if (authenticate(req) === null) {
      respond(res, 401, { error: 'unauthorized' })
      return true
    }

    const raw = await readBody(req)
    if (raw === null) {
      respond(res, 413, { error: 'body too large' })
      res.once('finish', () => req.destroy())
      return true
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      respond(res, 400, { error: 'invalid JSON body' })
      return true
    }

    const token = body.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      respond(res, 400, { error: 'token must be a hex APNs device token' })
      return true
    }

    if (req.method === 'DELETE') {
      await registry.remove(token)
      res.writeHead(204).end()
      return true
    }

    if (!isEnvironment(body.environment)) {
      respond(res, 400, { error: "environment must be 'development' or 'production'" })
      return true
    }
    const optionalString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined

    await registry.register({
      token,
      environment: body.environment,
      hostId: optionalString(body.hostId),
      bundleId: optionalString(body.bundleId),
      platform: optionalString(body.platform),
    })
    // The environment is echoed so a client can see what it was recorded as —
    // the one fact that is expensive to get wrong and invisible otherwise.
    respond(res, 200, { registered: true, environment: body.environment })
    return true
  }
}
