import { fileURLToPath } from 'node:url'
import { createAppRoutes } from './app/routes.ts'
import { createAppState } from './app/state.ts'
import { openWikiDb } from './wiki/db.ts'
import { createEmbeddedGateway, PROFILE_NAME } from './gateway.ts'
import { createCookieAuth } from './auth/cookie.ts'
import { resolveSecret } from './auth/secret.ts'
import { USERS } from './auth/users.ts'
import { createWikiApi } from './wiki/trpc.ts'
import { createWikiMcp } from './wiki/mcp.ts'
import type { AgentConfigResponse } from './shared.ts'

const port = Number(process.env.PORT ?? 8788)
const host = process.env.HOST ?? '127.0.0.1'
const dbFile = process.env.EMBEDDED_DB ?? fileURLToPath(new URL('../.embedded/wiki.db', import.meta.url))
const webRoot = fileURLToPath(new URL('../dist', import.meta.url))

const stateDir = fileURLToPath(new URL('../.embedded', import.meta.url))

const db = openWikiDb(dbFile)
const auth = createCookieAuth(resolveSecret(`${stateDir}/cookie-secret`))
const state = createAppState()
const wikiMcp = createWikiMcp(db, state, USERS)
const wikiApi = createWikiApi(db, state, auth)
await wikiApi.start()

// Resolved after listen; `createEngineRunner` only reads it at session create.
let mcpUrl = ''

let agentConfig: AgentConfigResponse = { baseUrl: '/v1', profile: PROFILE_NAME, available: false }

const app = createAppRoutes({
  auth,
  state,
  mcp: wikiMcp.handler,
  webRoot,
  agentConfig: () => agentConfig,
})

const gateway = await createEmbeddedGateway({
  auth,
  wikiMcp,
  sessionDir: `${stateDir}/sessions`,
  get mcpUrl() {
    return mcpUrl
  },
  // `/trpc` is checked first: silkweave's node handler slices its own prefix off unconditionally.
  fallback: (req, res) => {
    if (req.url === '/trpc' || req.url?.startsWith('/trpc/') || req.url?.startsWith('/trpc?')) {
      wikiApi.handler(req, res)
      return
    }
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
console.log(`  wiki api  http://${host}:${bound}/trpc  (the SPA, on your cookie)`)
console.log(`  wiki mcp  ${mcpUrl}  (agent sessions only, on a per-session token)`)
console.log(`  database  ${dbFile}`)
console.log(`  model     ${process.env.EMBEDDED_MODEL ?? 'gpt-5.6-luna'}${gateway.available ? '' : `  ⚠ ${gateway.unavailableReason}`}`)
console.log(`  users     ${USERS.map((u) => u.id).join(', ')}\n`)
