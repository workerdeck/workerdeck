import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ClientHttp2Session, connect, constants, type SecureClientSessionOptions } from 'node:http2'

export type ApnsEnvironment = 'development' | 'production'

export type ApnsConfig = {
  // A path, never the contents: a secret pasted into a config file is a secret in every backup of it.
  keyFile: string
  keyId: string
  teamId: string
  topic: string
  // Only the fallback for a device that registered without naming one; a device that named one is always routed by its answer.
  production?: boolean
}

const HOSTS: Record<ApnsEnvironment, string> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

const TOKEN_TTL_MS = 40 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const DIAL_ATTEMPT_TIMEOUT_MS = 2_000

export type ApnsRequest = {
  deviceToken: string
  environment: ApnsEnvironment
  payload: unknown
  priority?: 5 | 10
  // Unix seconds after which Apple stops trying; 0 is not "no expiry" but "attempt once, never store".
  expiration?: number
  // Apple caps this at 64 bytes, so never pass an identifier of unbounded length.
  collapseId?: string
}

export type ApnsResult =
  | { ok: true; apnsId?: string }
  | {
      ok: false
      status: number
      reason: string
      unregistered: boolean
    }

export type ApnsClient = {
  send(request: ApnsRequest): Promise<ApnsResult>
  close(): void
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export async function loadApnsKey(keyFile: string): Promise<KeyObject> {
  let pem: string
  try {
    pem = await readFile(keyFile, 'utf8')
  } catch (error) {
    throw new Error(`apns: cannot read the auth key at ${keyFile}: ` + `${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    throw new Error(`apns: ${keyFile} is not a private key (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `apns: ${keyFile} is a ${key.asymmetricKeyType ?? 'unknown'} key, not EC — an APNs auth ` +
        'key is the .p8 downloaded from Keys in the developer portal, not a certificate',
    )
  }
  return key
}

export function createProviderToken(key: KeyObject, keyId: string, teamId: string): { get(now?: number): string; invalidate(): void } {
  let cached: { token: string; issuedAt: number } | null = null
  return {
    get(now = Date.now()) {
      if (cached !== null && now - cached.issuedAt < TOKEN_TTL_MS) {
        return cached.token
      }
      const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
      const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
      const signingInput = `${header}.${claims}`
      const signature = sign('sha256', Buffer.from(signingInput), {
        key,
        dsaEncoding: 'ieee-p1363',
      })
      const token = `${signingInput}.${base64url(signature)}`
      cached = { token, issuedAt: now }
      return token
    },
    invalidate() {
      cached = null
    },
  }
}

function createSessionPool(hosts: Record<ApnsEnvironment, string>): {
  get(environment: ApnsEnvironment): ClientHttp2Session
  lastFailure(environment: ApnsEnvironment): string | undefined
  // Only ever called on a *connecting* session: destroying a connected one cancels its siblings mid-flight.
  discard(environment: ApnsEnvironment, session: ClientHttp2Session): void
  close(): void
} {
  const sessions = new Map<ApnsEnvironment, ClientHttp2Session>()
  const failures = new Map<ApnsEnvironment, string>()
  const drop = (environment: ApnsEnvironment, session: ClientHttp2Session): void => {
    if (sessions.get(environment) === session) {
      sessions.delete(environment)
    }
  }
  return {
    get(environment) {
      const existing = sessions.get(environment)
      if (existing !== undefined && !existing.closed && !existing.destroyed) {
        return existing
      }
      const session = connect(hosts[environment], {
        // The cast is @types/node not surfacing the net/tls options http2 forwards.
        autoSelectFamilyAttemptTimeout: DIAL_ATTEMPT_TIMEOUT_MS,
      } as SecureClientSessionOptions)
      sessions.set(environment, session)
      failures.delete(environment)
      // Without this listener a GOAWAY-then-error takes the whole process down, and push is a side channel.
      session.on('error', (error) => {
        failures.set(environment, `${(error as NodeJS.ErrnoException).code ?? 'error'}: ${error.message}`)
        drop(environment, session)
      })
      session.on('goaway', (code, _lastStreamId, data) => {
        const detail = data !== undefined && data.length > 0 ? `: ${data.toString('utf8').slice(0, 200)}` : ''
        failures.set(environment, `GOAWAY ${code}${detail}`)
        drop(environment, session)
      })
      session.on('close', () => drop(environment, session))
      session.setTimeout(5 * 60_000, () => session.close())
      return session
    },
    lastFailure: (environment) => failures.get(environment),
    discard(environment, session) {
      drop(environment, session)
      if (!session.destroyed) {
        session.destroy()
      }
    },
    close() {
      for (const session of sessions.values()) {
        session.close()
      }
      sessions.clear()
    },
  }
}

function describeStreamError(error: Error): string {
  const cause = (error as Error & { cause?: unknown }).cause
  if (!(cause instanceof AggregateError)) {
    return error.message
  }
  const parts = cause.errors.map((inner) => (inner instanceof Error ? inner.message : String(inner))).filter((message) => message !== '')
  if (parts.length === 0) {
    return error.message
  }
  return `${error.message.replace(' (caused by: )', '')} (caused by: ${parts.join('; ')})`
}

type Retry = 'never' | 'now' | 'redial'

type Attempt = { result: ApnsResult; retry: Retry }

export function createApnsClient(
  config: ApnsConfig,
  key: KeyObject,
  // Test seam only. The real endpoints are deliberately not configurable: redirecting them would exfiltrate every push.
  options: { hosts?: Record<ApnsEnvironment, string>; retryDelayMs?: number } = {},
): ApnsClient {
  const providerToken = createProviderToken(key, config.keyId, config.teamId)
  const pool = createSessionPool(options.hosts ?? HOSTS)
  const retryDelayMs = options.retryDelayMs ?? 1000

  const post = (request: ApnsRequest, jwt: string): Promise<Attempt> =>
    new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(request.payload))
      const session = pool.get(request.environment)
      let stream: ReturnType<ClientHttp2Session['request']>
      try {
        stream = session.request({
          ':method': 'POST',
          ':path': `/3/device/${request.deviceToken}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': config.topic,
          'apns-push-type': 'alert',
          'apns-priority': String(request.priority ?? 10),
          'apns-expiration': String(request.expiration ?? 0),
          'content-length': String(body.byteLength),
          ...(request.collapseId === undefined ? {} : { 'apns-collapse-id': request.collapseId }),
        })
      } catch (error) {
        resolve({
          result: {
            ok: false,
            status: 0,
            reason: error instanceof Error ? error.message : String(error),
            unregistered: false,
          },
          retry: 'now',
        })
        return
      }

      let status = 0
      let apnsId: string | undefined
      const chunks: Buffer[] = []
      let settled = false
      const settle = (result: ApnsResult, retry: Retry = 'never'): void => {
        if (settled) {
          return
        }
        settled = true
        resolve({ result, retry })
      }

      const transportRetry = (): Retry => {
        if (stream.pending) {
          return 'redial'
        }
        if (stream.rstCode === constants.NGHTTP2_REFUSED_STREAM) {
          return 'now'
        }
        return 'never'
      }
      const dropDoomedDial = (): void => {
        if (stream.pending && session.connecting) {
          pool.discard(request.environment, session)
        }
      }

      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        const retry = transportRetry()
        dropDoomedDial()
        stream.close()
        settle({ ok: false, status: 0, reason: 'Timeout', unregistered: false }, retry)
      })
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0)
        const id = headers['apns-id']
        apnsId = typeof id === 'string' ? id : undefined
      })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', (error) => {
        const retry = transportRetry()
        dropDoomedDial()
        const cause = pool.lastFailure(request.environment)
        const message = describeStreamError(error)
        settle(
          {
            ok: false,
            status,
            reason: cause !== undefined ? `${cause} (stream: ${message})` : message,
            unregistered: false,
          },
          retry,
        )
      })
      stream.on('end', () => {
        if (status === 200) {
          settle({ ok: true, apnsId })
          return
        }
        let reason = `HTTP ${status}`
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }
          if (typeof parsed.reason === 'string') {
            reason = parsed.reason
          }
        } catch {}
        settle({
          ok: false,
          status,
          reason,
          unregistered: reason === 'Unregistered' || reason === 'BadDeviceToken',
        })
      })
      // 'end' never fires on a destroyed readable, so without this last-resort settle the send hangs forever.
      stream.on('close', () => {
        const retry = transportRetry()
        settle(
          {
            ok: false,
            status,
            reason: pool.lastFailure(request.environment) ?? `connection closed (RST code ${stream.rstCode})`,
            unregistered: false,
          },
          retry,
        )
      })
      stream.end(body)
    })

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    async send(request) {
      let attempt = await post(request, providerToken.get())
      if (!attempt.result.ok && attempt.retry !== 'never') {
        if (attempt.retry === 'redial') {
          await wait(retryDelayMs)
        }
        attempt = await post(request, providerToken.get())
      }
      const first = attempt.result
      // The one *response* worth a retry: the cached JWT aged out against Apple's clock, so no duplicate is possible.
      if (!first.ok && first.reason === 'ExpiredProviderToken') {
        providerToken.invalidate()
        return (await post(request, providerToken.get())).result
      }
      return first
    },
    close: pool.close,
  }
}
