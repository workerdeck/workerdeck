import { randomBytes } from 'node:crypto'
import { createContext } from '@silkweave/core'
import { AUTH_REQUEST_KEY, mcpTransport } from '@silkweave/mcp/server'
import express, { type RequestHandler } from 'express'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import { createAgentActions, createWikiActions } from './actions.ts'
import type { User } from '../shared.ts'

/**
 * The **agent's** view of the wiki: the shared actions from `wiki/actions.ts` plus
 * the two agent-only ones, served as a real MCP server over streamable HTTP. A plain
 * `ToolSet` would have been cheaper; the wire is on purpose, because that is the seam
 * an embedder actually has.
 *
 * **Identity does not come from the model.** Which user a tool acts as is decided by
 * the bearer token on the HTTP request ({@link WikiMcp.issueToken}); no tool takes a
 * `userId` argument, because an argument is something the model can choose.
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
 * Build the MCP endpoint. Not a server of its own: `mcpTransport` hands back plain
 * handlers the host mounts on its own port, keeping everything on one origin.
 */
export const createWikiMcp = (db: WikiDb, state: AppState, users: readonly User[]): WikiMcp => {
  const tokens = new Map<string, string>()

  const transport = mcpTransport(
    {
      name: 'wiki',
      description:
        'The signed-in user’s wiki — list, read, write and rename documents — plus who they are, ' +
        'what they have open, and how to navigate them to a document.',
      version: '1.0.0',
      // Descriptions here are written for the model, not for the length linter.
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
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Silkweave forks this key into the per-request context. The tRPC adapter lands its
    // own resolution on the same key, which is what makes one `run()` correct for both.
    ;(req as unknown as Record<string, AuthInfo>)[AUTH_REQUEST_KEY] = { token, userId }
    next()
  }

  const router = express.Router()
  router.post('/', express.json({ limit: '4mb' }), authenticate, transport.post)
  // The transport is stateless, so there is no SSE stream to serve on GET — but MCP
  // requires **405**, not Express's default 404, or the client reads "wrong endpoint"
  // and the whole connect fails.
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
