import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ClientHttp2Session, connect, constants } from 'node:http2'

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
  /** Why the last connection died, for reporting a stream that never got sent.
   * Only failures that *precede* the stream's own death are visible here: when
   * one event kills both, Node cancels the stream synchronously inside the
   * session teardown and emits the session 'error' a tick later, so the stream
   * settles first. The stream's own cause is mined in `describeStreamError`. */
  lastFailure(environment: ApnsEnvironment): string | undefined
  /** Put down a session that a failed send has proven is not making progress.
   * Only ever called on a *connecting* session, where every stream is still
   * pending — each canceled sibling classifies as never-sent and retries
   * itself. Destroying a connected session here would cancel siblings
   * mid-flight, which is exactly the loss this file exists to prevent. Note
   * `destroy()` without an error emits no 'error' event, so this can never
   * take the process down. */
  discard(environment: ApnsEnvironment, session: ClientHttp2Session): void
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
    discard(environment, session) {
      drop(environment, session)
      if (!session.destroyed) session.destroy()
    },
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    },
  }
}

/**
 * A stream that never left this machine is destroyed with
 * ERR_HTTP2_STREAM_CANCEL, which buries the real failure in `cause` — and when
 * every connect attempt fails (Happy Eyeballs walks both address families of
 * api.push.apple.com), that cause is an AggregateError whose own message is
 * EMPTY, so the text ends in "(caused by: )" and names nothing. Mine the
 * aggregate so the log says ECONNREFUSED/EHOSTUNREACH instead of nothing.
 */
const describeStreamError = (error: Error): string => {
  const cause = (error as Error & { cause?: unknown }).cause
  if (!(cause instanceof AggregateError)) return error.message
  const parts = cause.errors
    .map((inner) => (inner instanceof Error ? inner.message : String(inner)))
    .filter((message) => message !== '')
  if (parts.length === 0) return error.message
  return `${error.message.replace(' (caused by: )', '')} (caused by: ${parts.join('; ')})`
}

/**
 * Whether — and how — a failed attempt may be retried without risking a
 * duplicate notification on someone's lock screen:
 *  - 'never': the request may have reached Apple. A push is not idempotent
 *    (permission requests carry no collapse id on purpose), so give up.
 *  - 'now': Apple provably refused the stream before processing anything
 *    (REFUSED_STREAM — the routine GOAWAY-rebalance race, RFC 9113 §8.7), or
 *    the cached session was found closed before a stream even existed. The
 *    network is fine; retry immediately.
 *  - 'redial': the stream never got an id, so its HEADERS frame was never
 *    handed to the transport — the connect itself failed. Retry once on a
 *    fresh connection after a beat, because whatever broke the dial (an
 *    interface still coming up, say) may need a moment to pass.
 */
type Retry = 'never' | 'now' | 'redial'

type Attempt = { result: ApnsResult; retry: Retry }

export function createApnsClient(
  config: ApnsConfig,
  key: KeyObject,
  /** Test seam: point the two environments at a local HTTP/2 server, and
   * shorten the redial pause so a test does not sit out the real one. Nothing
   * in production should pass this — the real endpoints are not configurable,
   * and an operator who could redirect them could exfiltrate every push. */
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
        // request() refuses on a closed session before creating a stream, so
        // nothing reached the wire and an immediate retry redials safely.
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
        if (settled) return
        settled = true
        resolve({ result, retry })
      }

      /** Classify a transport-level death. `pending` is true only while the
       * stream has no id — its HEADERS frame was never handed to nghttp2, so a
       * retry cannot duplicate anything. REFUSED_STREAM is Apple's explicit
       * "received but not processed", defined by the RFC as safe to retry. */
      const transportRetry = (): Retry => {
        if (stream.pending) return 'redial'
        if (stream.rstCode === constants.NGHTTP2_REFUSED_STREAM) return 'now'
        return 'never'
      }
      /** A stream still pending when its attempt dies marks a connect that is
       * failing or hanging; without this, every later push (and the retry)
       * would queue behind the same doomed dial until the OS gave up on it. */
      const dropDoomedDial = (): void => {
        if (stream.pending && session.connecting) pool.discard(request.environment, session)
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
        // A stream that never left the queue reports only that it was
        // canceled. When the failure *preceded* this stream, the session's
        // account of it is on record; when one event killed both, the session
        // 'error' has not fired yet (Node cancels the stream synchronously
        // inside the teardown and emits the session's own event a tick later),
        // so the cause is mined out of the stream error itself.
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
      // Last resort: a stream torn down with neither an error nor a response
      // ('end' never fires on a destroyed readable) must still settle, or the
      // forwarder's per-session delivery chain would hang on it forever.
      stream.on('close', () => {
        const retry = transportRetry()
        settle(
          {
            ok: false,
            status,
            reason:
              pool.lastFailure(request.environment) ??
              `connection closed (RST code ${stream.rstCode})`,
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
      // A push the transport provably never delivered is retried exactly once:
      // redialling is cheap, and a lost approval request is the whole cost of
      // this file. 'never' failures are never retried — the request may have
      // reached Apple, and a duplicated notification is a real harm here
      // (permission requests carry no collapse id on purpose).
      if (!attempt.result.ok && attempt.retry !== 'never') {
        if (attempt.retry === 'redial') await wait(retryDelayMs)
        attempt = await post(request, providerToken.get())
      }
      const first = attempt.result
      // The one *response* worth an automatic retry: our cached JWT aged out
      // against Apple's clock rather than ours. Re-sign once and try again;
      // anything else is the caller's problem.
      if (!first.ok && first.reason === 'ExpiredProviderToken') {
        providerToken.invalidate()
        return (await post(request, providerToken.get())).result
      }
      return first
    },
    close: pool.close,
  }
}
