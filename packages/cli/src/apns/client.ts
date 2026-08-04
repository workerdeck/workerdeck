import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ClientHttp2Session, connect } from 'node:http2'

/**
 * A minimal APNs provider client: an HTTP/2 POST carrying an ES256 JWT.
 *
 * Hand-rolled rather than a dependency, because that is the whole of the
 * protocol and the published CLI's zero-runtime-dep posture is worth more than
 * the eighty lines. Note `fetch`/undici will not do: it does not speak HTTP/2,
 * and APNs accepts nothing else — hence `node:http2` directly.
 *
 * Token authentication, not certificates: one `.p8` serves every app in the team
 * and both environments, and it does not expire. Certificates are per-app,
 * per-environment, and expire annually.
 */

export type ApnsEnvironment = 'development' | 'production'

export type ApnsConfig = {
  /** Path to the `.p8`. A path, never the contents — a secret pasted into a
   * config file is a secret in every backup of that file. */
  keyFile: string
  /** The 10-character Key ID shown beside the key in the developer portal. */
  keyId: string
  /** The 10-character Team ID from the top right of the portal. */
  teamId: string
  /** The APNs topic, which is the app's bundle id (`bi.atomic.workerdeck.ios`). */
  topic: string
  /** Environment for a device that registered without naming one. Devices that
   * do name one are always routed by their own answer — see the note on
   * `ApnsEnvironment` below. */
  production?: boolean
}

/**
 * The environment is per *device token*, not per deployment, and that is the
 * single most expensive thing to get wrong here: a build run from Xcode gets a
 * sandbox token, a TestFlight build gets a production one, and the two
 * namespaces do not overlap. Same key, same phone, different token — cross them
 * and Apple answers `BadDeviceToken`. So the app declares which environment it
 * registered in and the forwarder routes each token to its own host.
 */
const HOSTS: Record<ApnsEnvironment, string> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/**
 * Apple rejects a provider token older than an hour, and rate-limits refreshing
 * one (`TooManyProviderTokenUpdates`) if you re-sign much more often than every
 * twenty minutes. Forty sits in the middle of that window with room for clock
 * skew at both ends — and re-signing per push, the obvious-looking thing, is
 * exactly what the rate limit exists to punish.
 */
const TOKEN_TTL_MS = 40 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

export type ApnsRequest = {
  deviceToken: string
  environment: ApnsEnvironment
  payload: unknown
  /** 10 for something a person is waiting on, 5 for everything else. */
  priority?: 5 | 10
  /** Unix seconds after which Apple stops trying. 0 means "one attempt". */
  expiration?: number
  /** Later pushes with the same id replace an undelivered earlier one. Max 64
   * bytes, so never pass a raw identifier of unbounded length. */
  collapseId?: string
}

export type ApnsResult =
  | { ok: true; apnsId?: string }
  | {
      ok: false
      status: number
      reason: string
      /** The token is dead: drop it from the registry rather than retrying it
       * forever. The app re-registers on its next launch anyway. */
      unregistered: boolean
    }

export type ApnsClient = {
  send(request: ApnsRequest): Promise<ApnsResult>
  close(): void
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

/**
 * Load and sanity-check the auth key. Done once at startup rather than at the
 * first push, so a mistyped path is a launch error with a clear message instead
 * of a notification that silently never arrives.
 */
export async function loadApnsKey(keyFile: string): Promise<KeyObject> {
  let pem: string
  try {
    pem = await readFile(keyFile, 'utf8')
  } catch (error) {
    throw new Error(
      `apns: cannot read the auth key at ${keyFile}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    throw new Error(
      `apns: ${keyFile} is not a private key (${
        error instanceof Error ? error.message : String(error)
      })`,
    )
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `apns: ${keyFile} is a ${key.asymmetricKeyType ?? 'unknown'} key, not EC — an APNs auth ` +
        'key is the .p8 downloaded from Keys in the developer portal, not a certificate',
    )
  }
  return key
}

/**
 * A cached provider JWT. The signature is over `{alg:ES256,kid}` + `{iss,iat}`,
 * and JWS wants the raw `r||s` pair — `sign()` produces a DER SEQUENCE unless
 * told otherwise, which Apple rejects with a bare 403 and no explanation.
 */
export function createProviderToken(key: KeyObject, keyId: string, teamId: string): {
  get(now?: number): string
  invalidate(): void
} {
  let cached: { token: string; issuedAt: number } | null = null
  return {
    get(now = Date.now()) {
      if (cached !== null && now - cached.issuedAt < TOKEN_TTL_MS) return cached.token
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

/**
 * One long-lived HTTP/2 session per environment, reconnected on demand. APNs
 * sends GOAWAY routinely (it rebalances connections), so a dead session is a
 * normal event and not an error worth surfacing — the next push simply dials
 * again.
 */
function createSessionPool(hosts: Record<ApnsEnvironment, string>): {
  get(environment: ApnsEnvironment): ClientHttp2Session
  /** Why the last connection died, for reporting a stream that never got sent. */
  lastFailure(environment: ApnsEnvironment): string | undefined
  close(): void
} {
  const sessions = new Map<ApnsEnvironment, ClientHttp2Session>()
  const failures = new Map<ApnsEnvironment, string>()
  const drop = (environment: ApnsEnvironment, session: ClientHttp2Session): void => {
    if (sessions.get(environment) === session) sessions.delete(environment)
  }
  return {
    get(environment) {
      const existing = sessions.get(environment)
      if (existing !== undefined && !existing.closed && !existing.destroyed) return existing
      const session = connect(hosts[environment])
      sessions.set(environment, session)
      failures.delete(environment)
      // Without an error listener a GOAWAY-then-error would take the whole
      // process down; the forwarder is a side channel and must never do that.
      // The reason is *kept* rather than dropped on the floor: when the
      // connection dies the in-flight stream reports only "the pending stream
      // has been canceled", which says nothing about whether this was a DNS
      // failure, a TLS problem or Apple hanging up on us.
      session.on('error', (error) => {
        failures.set(environment, `${(error as NodeJS.ErrnoException).code ?? 'error'}: ${error.message}`)
        drop(environment, session)
      })
      // APNs sends GOAWAY routinely to rebalance connections, but it also sends
      // one to hang up on a client it is throttling — notably one that keeps
      // pushing to invalid tokens. The debug data carries the reason when there
      // is one.
      session.on('goaway', (code, _lastStreamId, data) => {
        const detail = data !== undefined && data.length > 0 ? `: ${data.toString('utf8').slice(0, 200)}` : ''
        failures.set(environment, `GOAWAY ${code}${detail}`)
        drop(environment, session)
      })
      session.on('close', () => drop(environment, session))
      // Nothing to say for a while is normal — an idle gateway pushes nothing.
      // Let the socket go rather than pinning a connection open all night.
      session.setTimeout(5 * 60_000, () => session.close())
      return session
    },
    lastFailure: (environment) => failures.get(environment),
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    },
  }
}

export function createApnsClient(
  config: ApnsConfig,
  key: KeyObject,
  /** Test seam: point the two environments at a local HTTP/2 server. Nothing in
   * production should pass this — the real endpoints are not configurable, and
   * an operator who could redirect them could exfiltrate every push. */
  options: { hosts?: Record<ApnsEnvironment, string> } = {},
): ApnsClient {
  const providerToken = createProviderToken(key, config.keyId, config.teamId)
  const pool = createSessionPool(options.hosts ?? HOSTS)

  const post = (request: ApnsRequest, jwt: string): Promise<ApnsResult> =>
    new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(request.payload))
      let stream: ReturnType<ClientHttp2Session['request']>
      try {
        stream = pool.get(request.environment).request({
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
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message : String(error),
          unregistered: false,
        })
        return
      }

      let status = 0
      let apnsId: string | undefined
      const chunks: Buffer[] = []
      let settled = false
      const settle = (result: ApnsResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.close()
        settle({ ok: false, status: 0, reason: 'Timeout', unregistered: false })
      })
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0)
        const id = headers['apns-id']
        apnsId = typeof id === 'string' ? id : undefined
      })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', (error) => {
        // A stream that never left the queue reports only that it was canceled.
        // The connection knows why, so prefer its account of it.
        const cause = pool.lastFailure(request.environment)
        settle({
          ok: false,
          status,
          reason: cause !== undefined ? `${cause} (stream: ${error.message})` : error.message,
          unregistered: false,
        })
      })
      stream.on('end', () => {
        if (status === 200) {
          settle({ ok: true, apnsId })
          return
        }
        let reason = `HTTP ${status}`
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }
          if (typeof parsed.reason === 'string') reason = parsed.reason
        } catch {
          // A non-JSON body from APNs is exotic; the status still classifies it.
        }
        settle({
          ok: false,
          status,
          reason,
          // 410 Unregistered is Apple telling us the app was deleted.
          // BadDeviceToken means the token does not belong to this topic *or*
          // this environment; either way it will never work, and the app writes
          // a fresh one on its next launch.
          unregistered: reason === 'Unregistered' || reason === 'BadDeviceToken',
        })
      })
      stream.end(body)
    })

  return {
    async send(request) {
      const first = await post(request, providerToken.get())
      // The one error worth an automatic retry: our cached JWT aged out against
      // Apple's clock rather than ours. Re-sign once and try again; anything
      // else is the caller's problem.
      if (!first.ok && first.reason === 'ExpiredProviderToken') {
        providerToken.invalidate()
        return post(request, providerToken.get())
      }
      return first
    },
    close: pool.close,
  }
}
