import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocketServer } from 'ws'
import type { ServerContext } from '../context.ts'
import { refuseUpgrade } from '../lib/http.ts'
import { parseSessionRoute } from '../lib/parse-route.ts'
import { entryInfo, historyEvents } from './conversations.ts'
import { sessionInfoOf } from './session-lookup.ts'
import { attachArchive, attachClient } from './ws.ts'

// The scope check runs on what is already known before the wake, because waking rebuilds a runner and reconnects
// MCP, which is not for someone about to get a 404; and again on the live runner, which is the one being attached.
export async function upgradeSession(
  ctx: ServerContext,
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const { auth, parking } = ctx
  const route = parseSessionRoute(ctx.basePath, req.url ?? '/')
  if (route?.kind !== 'ws') {
    socket.destroy()
    return
  }
  const authCtx = await auth.authenticate(req)
  if (!authCtx.ok) {
    refuseUpgrade(socket, '401 Unauthorized')
    return
  }
  // A past conversation: authorized on its frozen projection, read-only, never a fall-through to the current runner.
  const conversation = new URL(req.url ?? '/', 'http://internal').searchParams.get('conversation')
  if (conversation !== null) {
    const entry = (await ctx.records.get(route.id))?.conversations.find((candidate) => String(candidate.n) === conversation)
    if (!entry || !auth.canSee(authCtx, entryInfo(route.id, entry))) {
      refuseUpgrade(socket, '404 Not Found')
      return
    }
    const history = await historyEvents(ctx, route.id, entry)
    const events = history?.events
    const info = {
      ...entryInfo(route.id, entry),
      epoch: entry.n,
      lastSeq: events?.at(-1)?.seq ?? 0,
      ...(history?.transcript ? { transcript: history.transcript } : {}),
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachArchive(ctx, ws, info, events, req))
    return
  }
  const known = await sessionInfoOf(ctx, route.id)
  if ((known && !auth.canSee(authCtx, known)) || ctx.agents.tombstone(route.id)) {
    refuseUpgrade(socket, '404 Not Found')
    return
  }
  const runner = await parking.ensureLive(route.id).catch(() => undefined)
  if (!runner && parking.fenced(route.id)) {
    refuseUpgrade(socket, '503 Service Unavailable')
    return
  }
  if (!runner || !auth.canSee(authCtx, runner.info())) {
    refuseUpgrade(socket, '404 Not Found')
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachClient(ctx, ws, runner, req, { operator: auth.isOperator(authCtx) })
  })
}
