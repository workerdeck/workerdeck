import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readJsonOr, writeJsonAtomic } from '@workerdeck/server'
import type { ApnsEnvironment } from './client.ts'
import { isAuthenticated, isJsonRequest, readBody, respondJson, type RequestAuthenticator } from '../lib/http.ts'

export type JsonRegistryOptions = {
  dir: string | null
  onError?: (error: unknown, context: { op: string; path: string }) => void
}

export type JsonRecordFile = { load: () => Promise<unknown[]>; save: (records: unknown[]) => Promise<void> }

export type PushRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

// 64 hex chars today; the upper bound is loose because Apple reserved the right to grow the token.
export const TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/

const MAX_BODY_BYTES = 4096

export function isEnvironment(value: unknown): value is ApnsEnvironment {
  return value === 'development' || value === 'production'
}

// Missing, unreadable and corrupt all load as empty: push is a side channel and must never refuse a boot.
export function jsonRecordFile(options: JsonRegistryOptions, filename: string, field: string): JsonRecordFile {
  const path = options.dir === null ? null : join(options.dir, filename)
  return {
    load: async () => {
      if (path === null) {
        return []
      }
      const records = ((await readJsonOr(path, null)) as Record<string, unknown> | null)?.[field]
      return Array.isArray(records) ? records : []
    },
    save: async (records) => {
      if (path === null) {
        return
      }
      try {
        await writeJsonAtomic(path, { [field]: records }, { indent: 2, trailingNewline: true })
      } catch (error) {
        options.onError?.(error, { op: 'write', path })
      }
    },
  }
}

// The shared preamble of every `/apns/*` route: claimed with or without a registry, authenticated before anything is
// parsed (a token is an address this gateway can buzz), JSON only, bounded.
export function jsonPushRoute<R>(
  route: string,
  registry: R | null,
  authenticate: RequestAuthenticator,
  handle: (registry: R, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<void>,
): PushRouteHandler {
  return async (req, res) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      return false
    }
    if (pathname !== route) {
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
    if (!(await isAuthenticated(authenticate, req))) {
      respondJson(res, 401, { error: 'unauthorized' })
      return true
    }
    if (!isJsonRequest(req)) {
      respondJson(res, 415, { error: 'expected content-type application/json' })
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
    await handle(registry, req, res, body)
    return true
  }
}
