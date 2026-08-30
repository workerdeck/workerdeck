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
 * `trpcNode()` hands back a `node:http` handler rather than binding a port, so the
 * gateway keeps the port and the login cookie authenticates the REST calls, this API
 * *and* the agent's WebSocket attach. The client's types come from
 * {@link WikiRouter}, with no codegen — see `web/lib/trpc.ts`.
 */

const buildServer = (api: TrpcNodeAdapter, db: WikiDb, state: AppState) =>
  silkweave({
    name: 'wiki-api',
    description: "The signed-in user's wiki documents.",
    version: '1.0.0',
    // Same reason as the MCP mount: written for a model, not for the linter.
    lint: false,
  })
    .adapter(api.adapter)
    .actions(createWikiActions(db, state))

/** The router type the SPA's tRPC client is typed against, derived from the actions
 * themselves — no codegen step and no shared DTO file to forget to update. */
export type WikiRouter = InferTrpcRouter<ReturnType<typeof buildServer>>

export type WikiApi = {
  /** Mount on `/trpc`. The handler slices that prefix off unconditionally, so
   * route only matching URLs into it. */
  handler: (req: IncomingMessage, res: ServerResponse) => void
  /** Builds the router. The handler answers 503 until this resolves. */
  start: () => Promise<void>
}

export const createWikiApi = (db: WikiDb, state: AppState, auth: CookieAuth): WikiApi => {
  const api = trpcNode({
    endpoint: '/trpc',
    /**
     * The other half of sharing an action set: agent identity arrives as a bearer
     * token, the browser's as this cookie, both landing an `AuthInfo` on the same
     * context key so `run()` cannot tell which caller it serves.
     *
     * **The cookie makes this CSRF-able.** Declining (`null`) rather than throwing is
     * deliberate: it falls through to the unconfigured bearer path and answers a plain
     * 401, which explains nothing to whoever sent a forged request.
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
