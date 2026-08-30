import { existsSync } from 'node:fs'
import express, { type Express, type RequestHandler } from 'express'
import type { AppState, UiState } from './state.ts'
import type { CookieAuth } from '../auth/cookie.ts'
import { USERS, userById } from '../auth/users.ts'
import type { AgentConfigResponse, LoginRequest, User } from '../shared.ts'

export type AppRoutesDeps = {
  auth: CookieAuth
  /** What the user is looking at, and the channel that moves them. */
  state: AppState
  /** `POST /mcp`, from `createWikiMcp`. */
  mcp: RequestHandler
  /** Built SPA directory, when one exists. Absent in dev — Vite serves it. */
  webRoot?: string
  agentConfig: () => AgentConfigResponse
}

/**
 * Everything outside the gateway's `/v1` that is *not* an action: login, the
 * app-state channel, the MCP endpoint, and the built SPA. The wiki's own data API
 * is `/trpc`, mounted in `main.ts` from the same actions the agent gets.
 *
 * Handed to `createWorkerServer` as its `fallback`, which is what puts all of it on
 * one origin — the reason the browser can authenticate a WebSocket attach at all.
 */
export const createAppRoutes = (deps: AppRoutesDeps): Express => {
  const app = express()
  app.disable('x-powered-by')

  // Mounted before the JSON body parser: the MCP router applies its own, and a
  // second parse of an already-consumed stream hangs.
  app.use('/mcp', deps.mcp)

  app.use(express.json({ limit: '1mb' }))

  /** Resolves the cookie, or 401s. The /api routes below are behind it. */
  const requireUser: RequestHandler = (req, res, next) => {
    const user = deps.auth.resolve(req)
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    res.locals.user = user
    next()
  }
  const currentUser = (res: { locals: Record<string, unknown> }): User => res.locals.user as User

  // --- session ---------------------------------------------------------------

  app.get('/api/users', (_req, res) => {
    res.json({ users: USERS })
  })

  app.get('/api/me', (req, res) => {
    res.json({ user: deps.auth.resolve(req) ?? null })
  })

  app.post('/api/login', (req, res) => {
    const { userId } = req.body as LoginRequest
    const user = userById(userId)
    if (!user) {
      res.status(400).json({ error: 'unknown user' })
      return
    }
    res.setHeader('set-cookie', deps.auth.issue(user.id))
    res.json({ user })
  })

  app.post('/api/logout', (_req, res) => {
    res.setHeader('set-cookie', deps.auth.clear())
    res.json({ user: null })
  })

  // --- agent -----------------------------------------------------------------

  app.get('/api/agent', requireUser, (_req, res) => {
    res.json(deps.agentConfig())
  })

  /** The tab telling the server what is on screen, so `whoami` can answer. */
  app.put('/api/ui-state', requireUser, (req, res) => {
    const { openDocId } = req.body as UiState
    deps.state.set(currentUser(res).id, {
      openDocId: typeof openDocId === 'string' && openDocId ? openDocId : undefined,
    })
    res.status(204).end()
  })

  /**
   * Intents from `open_doc`, streamed to this user's tabs. SSE rather than a second
   * WebSocket: the session socket carries *session* events and is not ours to put
   * app messages on — the protocol is the product boundary.
   */
  app.get('/api/ui-events', requireUser, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer this into uselessness otherwise.
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')

    const unsubscribe = deps.state.subscribe(currentUser(res).id, (intent) => {
      res.write(`data: ${JSON.stringify(intent)}\n\n`)
    })
    // Proxies and laptops drop a stream that says nothing, and the reconnect is
    // silent enough that the symptom is only "navigation stopped working".
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })

  // --- the SPA ---------------------------------------------------------------

  if (deps.webRoot && existsSync(deps.webRoot)) {
    const root = deps.webRoot
    app.use(express.static(root, { index: false }))
    // History fallback, and only for navigations: an unmatched /api or /mcp path must
    // 404 rather than answer with the app shell.
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/mcp')) {
        next()
        return
      }
      res.sendFile('index.html', { root })
    })
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  return app
}
