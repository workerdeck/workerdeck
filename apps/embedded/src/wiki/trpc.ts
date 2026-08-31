import type { IncomingMessage, ServerResponse } from 'node:http'
import { silkweave } from '@silkweave/core'
import { type InferTrpcRouter, type TrpcNodeAdapter, trpcNode } from '@silkweave/trpc'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import { type CookieAuth, sameOrigin } from '../auth/cookie.ts'
import { createWikiActions } from './actions.ts'

function buildServer(api: TrpcNodeAdapter, db: WikiDb, state: AppState) {
  return silkweave({
    name: 'wiki-api',
    description: "The signed-in user's wiki documents.",
    version: '1.0.0',
    // Same reason as the MCP mount: written for a model, not for the linter.
    lint: false,
  })
    .adapter(api.adapter)
    .actions(createWikiActions(db, state))
}

export type WikiRouter = InferTrpcRouter<ReturnType<typeof buildServer>>

export type WikiApi = {
  // The handler slices `/trpc` off unconditionally, so route only matching URLs into it.
  handler: (req: IncomingMessage, res: ServerResponse) => void
  // The handler answers 503 until this resolves.
  start: () => Promise<void>
}

export function createWikiApi(db: WikiDb, state: AppState, auth: CookieAuth): WikiApi {
  const api = trpcNode({
    endpoint: '/trpc',
    // Declining (`null`) rather than throwing falls through to the bearer path and answers a plain 401.
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
