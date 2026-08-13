import { fileURLToPath } from 'node:url'
import { createAppRoutes } from './app-routes.ts'
import { createAppState } from './app-state.ts'
import { openWikiDb } from './db.ts'
import { createEmbeddedGateway, PROFILE_NAME } from './gateway.ts'
import { createCookieAuth, USERS } from './users.ts'
import { createWikiMcp } from './wiki-mcp.ts'
import type { AgentConfigResponse } from './shared.ts'

/**
 * The whole embedded instance, in one process and on one port:
 *
 *   :PORT ─┬─ /v1/*  the WorkerDeck gateway (REST + the session WebSocket)
 *          └─ everything else, via the gateway's `fallback`:
 *             ├─ /api/*  the wiki's own API
 *             ├─ /mcp    the wiki as an MCP server, for the agent only
 *             └─ /*      the built SPA
 *
 * One port is load-bearing. The tab drives sessions over a WebSocket, a browser
 * cannot put an Authorization header on an upgrade, and a cookie only rides
 * same-origin requests — so single-origin is what makes the sidebar work at all.
 */

const port = Number(process.env.PORT ?? 8788)
const host = process.env.HOST ?? '127.0.0.1'
const dbFile = process.env.EMBEDDED_DB ?? fileURLToPath(new URL('../.embedded/wiki.db', import.meta.url))
const webRoot = fileURLToPath(new URL('../dist', import.meta.url))

const db = openWikiDb(dbFile)
const auth = createCookieAuth(process.env.EMBEDDED_SECRET)
const state = createAppState()
const wikiMcp = createWikiMcp(db, state, USERS)

// Resolved after listen, when the real port is known — but `createEngineRunner`
// only reads it when a session is created, which is necessarily later.
let mcpUrl = ''

let agentConfig: AgentConfigResponse = { baseUrl: '/v1', profile: PROFILE_NAME, available: false }

const app = createAppRoutes({
  db,
  auth,
  state,
  mcp: wikiMcp.handler,
  webRoot,
  agentConfig: () => agentConfig,
})

const gateway = await createEmbeddedGateway({
  auth,
  wikiMcp,
  get mcpUrl() {
    return mcpUrl
  },
  // Express apps are `(req, res)` handlers, so the gateway's fallback can be
  // one directly — no proxy hop, no second port, no WS upgrade to forward.
  fallback: (req, res) => {
    app(req, res)
  },
})

agentConfig = {
  baseUrl: '/v1',
  profile: PROFILE_NAME,
  available: gateway.available,
  unavailableReason: gateway.unavailableReason,
}

const { port: bound } = await gateway.server.listen(port, host).catch((error: unknown) => {
  // This repo runs several gateways at once, so a busy port is the likeliest
  // first-run failure — and an EADDRINUSE stack trace does not tell you that
  // something else is already answering there.
  if ((error as { code?: string }).code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${port} is already in use — something else is listening on ${host}:${port}.\n` +
        `  Find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        `  Or pick another:  PORT=${port + 1} pnpm dev\n`,
    )
    process.exit(1)
  }
  throw error
})
mcpUrl = `http://${host}:${bound}/mcp`

const shutdown = async (): Promise<void> => {
  await gateway.server.close().catch(() => {})
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

console.log(`\n  Embedded WorkerDeck example`)
console.log(`  ──────────────────────────────────────────────`)
console.log(`  app       http://${host}:${bound}`)
console.log(`  gateway   http://${host}:${bound}/v1`)
console.log(`  wiki mcp  ${mcpUrl}  (agent sessions only)`)
console.log(`  database  ${dbFile}`)
console.log(`  model     ${process.env.EMBEDDED_MODEL ?? 'gpt-5.6-luna'}${gateway.available ? '' : `  ⚠ ${gateway.unavailableReason}`}`)
console.log(`  users     ${USERS.map((u) => u.id).join(', ')}\n`)
