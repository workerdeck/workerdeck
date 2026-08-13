import { randomBytes } from 'node:crypto'
import { createContext } from '@silkweave/core'
import { AUTH_REQUEST_KEY, mcpTransport } from '@silkweave/mcp/server'
import express, { type RequestHandler } from 'express'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import { createAgentActions, createWikiActions } from './actions.ts'
import type { User } from '../shared.ts'

/**
 * The **agent's** view of the wiki: the shared actions from `wiki/actions.ts`
 * plus the two agent-only ones, served as a real MCP server over streamable HTTP.
 *
 * It would have been cheaper to hand `createEngineSession` a plain `ToolSet` —
 * the option takes one, and the agent could not tell the difference. This goes
 * over the wire on purpose: it is the seam an embedder actually has (their tools
 * are usually already an MCP server, or want to be reachable by other clients
 * too), and putting a real transport in the reference implementation is what
 * makes it a reference rather than a shortcut.
 *
 * **Identity does not come from the model.** Every tool acts as one user, and
 * which user is decided by the bearer token on the HTTP request — minted per
 * agent session by {@link WikiMcp.issueToken} and known only to the gateway
 * process. A tool never takes a `userId` argument, because an argument is
 * something the model can choose and this is not the model's choice to make.
 */

type AuthInfo = { token: string; userId: string }

export type WikiMcp = {
  /** Mountable handler for `<path>` — hand it to the host's router. */
  handler: RequestHandler
  /**
   * Mint a bearer token that makes MCP calls act as `userId`. One per agent
   * session, revoked when the session's runner is disposed.
   */
  issueToken(userId: string): { token: string; revoke: () => void }
}

/**
 * Build the MCP endpoint. Not a server of its own: `mcpTransport` hands back
 * plain handlers, which the host mounts on its own port — one origin for the
 * SPA, the gateway, the tRPC API and this, which is what lets the browser's
 * cookie authenticate a WebSocket upgrade at all.
 */
export function createWikiMcp(db: WikiDb, state: AppState, users: readonly User[]): WikiMcp {
  const tokens = new Map<string, string>()

  const transport = mcpTransport(
    {
      name: 'wiki',
      description:
        'The signed-in user’s wiki — list, read, write and rename documents — plus who they are, ' +
        'what they have open, and how to navigate them to a document.',
      version: '1.0.0',
      // The action linter warns about description length on startup; the
      // descriptions here are written for the model, not for it.
      lint: false,
    },
    createContext({ adapter: 'http' }),
    [...createWikiActions(db, state), ...createAgentActions(db, state, users)],
  )

  const authenticate: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const userId = tokens.get(token)
    if (!userId) {
      // The tokens are internal to this process and never leave it, so a request
      // without one is a bug or a probe, not a user-facing state.
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Silkweave forks whatever is on this key into the per-request context, and
    // `registerTools` inherits it — which is how an action learns who it is
    // acting as without an AsyncLocalStorage and without a tool argument. The
    // tRPC adapter lands its own resolution on the same key, which is what makes
    // one `run()` correct for both callers.
    ;(req as unknown as Record<string, AuthInfo>)[AUTH_REQUEST_KEY] = { token, userId }
    next()
  }

  const router = express.Router()
  router.post('/', express.json({ limit: '4mb' }), authenticate, transport.post)
  // Silkweave's transport is stateless — one request/response per call, with no
  // standing server→client stream — so there is no `GET` to serve. It has to say
  // so in the spec's words: a client opens the SSE stream on GET, and MCP
  // requires **405** from a server that does not offer one. Left to Express's
  // default 404 the client reads "wrong endpoint" and the whole connect fails.
  // `transport.methodNotAllowed` is silkweave's own responder for that (5.1.0);
  // it ships the rule rather than leaving every host to rediscover it.
  router.all('/', transport.methodNotAllowed)

  return {
    handler: router,
    issueToken(userId) {
      const token = randomBytes(24).toString('base64url')
      tokens.set(token, userId)
      return { token, revoke: () => tokens.delete(token) }
    },
  }
}
