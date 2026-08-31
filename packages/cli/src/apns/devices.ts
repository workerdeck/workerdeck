import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ApnsEnvironment } from './client.ts'

export type DeviceRecord = {
  token: string
  environment: ApnsEnvironment
  // The client's own id for this gateway, echoed back in every payload so an app with two gateways knows which woke it; never interpreted here.
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
// 64 hex chars today; the upper bound is loose because Apple reserved the right to grow the token.
const TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/
const MAX_BODY_BYTES = 4096

function isEnvironment(value: unknown): value is ApnsEnvironment {
  return value === 'development' || value === 'production'
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

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
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
}

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
    // A device token is an address this gateway can buzz, so an unauthenticated register lets anyone reachable aim it.
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
    respond(res, 200, { registered: true, environment: body.environment })
    return true
  }
}
