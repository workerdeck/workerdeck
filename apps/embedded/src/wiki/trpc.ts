import type { IncomingMessage, ServerResponse } from 'node:http'
import { silkweave } from '@silkweave/core'
import { type InferTrpcRouter, type TrpcNodeAdapter, trpcNode } from '@silkweave/trpc'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import { type CookieAuth, sameOrigin } from '../auth/cookie.ts'
import { createWikiActions } from './actions.ts'

/**
 * The **SPA's** view of the wiki: the same actions the agent gets (minus the
 * agent-only two), served as end-to-end-typed tRPC on this app's own origin.
 *
 * `trpcNode()` hands back a `node:http` handler rather than binding a port,
 * which is what makes this possible at all: the gateway owns the port, the app
 * mounts into it, and one origin means the login cookie authenticates the REST
 * calls, this API, *and* the agent's WebSocket attach. A tRPC server on :8081
 * would have needed a second credential the browser cannot supply on an upgrade.
 *
 * The client gets its types from {@link WikiRouter} with no code generation —
 * see `web/lib/trpc.ts`.
 */

function buildServer(api: TrpcNodeAdapter, db: WikiDb, state: AppState) {
  return silkweave({
    name: 'wiki-api',
    description: "The signed-in user's wiki documents.",
    version: '1.0.0',
    // Same reason as the MCP mount: these descriptions are written for a model,
    // not for the linter.
    lint: false,
  })
    .adapter(api.adapter)
    .actions(createWikiActions(db, state))
}

/** The router type the SPA's tRPC client is typed against — derived from the
 * actions themselves, so adding one is visible in the client with no codegen
 * step and no shared DTO file to forget to update. */
export type WikiRouter = InferTrpcRouter<ReturnType<typeof buildServer>>

export type WikiApi = {
  /** Mount on `/trpc`. The handler slices that prefix off unconditionally, so
   * route only matching URLs into it. */
  handler: (req: IncomingMessage, res: ServerResponse) => void
  /** Builds the router. The handler answers 503 until this resolves. */
  start: () => Promise<void>
}

export function createWikiApi(db: WikiDb, state: AppState, auth: CookieAuth): WikiApi {
  const api = trpcNode({
    endpoint: '/trpc',
    /**
     * Resolve the caller from the app's own session cookie.
     *
     * This is the other half of sharing an action set. The agent reaches these
     * actions with a per-session bearer token; the browser reaches them with a
     * cookie, because a cookie is what also authenticates the WebSocket upgrade.
     * Both land an `AuthInfo` on the context's `auth` key, so an action's
     * `run()` cannot tell — and must not care — which caller it is serving.
     *
     * **The cookie makes this CSRF-able, and the guard is ours to write.** A
     * cookie rides any request the browser is induced to send, including one a
     * third party's page caused. Declining (returning `null`) rather than
     * throwing is deliberate: it falls through to the bearer path — unconfigured
     * here — and answers a plain 401, which is the right answer to a forged
     * request and explains nothing to whoever sent it.
     */
    authenticate: (req: IncomingMessage) => {
      if (!sameOrigin(req)) {
        return null
      }
      const user = auth.resolve(req)
      return user ? { token: 'cookie', userId: user.id } : null
    },
  })
  const server = buildServer(api, db, state)
  return {
    handler: api.handler,
    start: async () => {
      await server.start()
    },
  }
}
