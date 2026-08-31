import { randomBytes } from 'node:crypto'
import { createContext } from '@silkweave/core'
import { AUTH_REQUEST_KEY, mcpTransport } from '@silkweave/mcp/server'
import express, { type RequestHandler } from 'express'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import { createAgentActions, createWikiActions } from './actions.ts'
import type { User } from '../shared.ts'

type AuthInfo = { token: string; userId: string }

export type WikiMcp = {
  handler: RequestHandler
  // Which user a tool acts as is decided by this token, never by a tool argument the model could choose.
  issueToken(userId: string): { token: string; revoke: () => void }
}

export function createWikiMcp(db: WikiDb, state: AppState, users: readonly User[]): WikiMcp {
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
    // The tRPC adapter lands its own resolution on this same context key, which is what makes one `run()` serve both.
    ;(req as unknown as Record<string, AuthInfo>)[AUTH_REQUEST_KEY] = { token, userId }
    next()
  }

  const router = express.Router()
  router.post('/', express.json({ limit: '4mb' }), authenticate, transport.post)
  // MCP requires 405 on the GET, not Express's default 404, or the whole connect fails.
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
