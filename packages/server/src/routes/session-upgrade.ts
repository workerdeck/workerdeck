import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocketServer } from 'ws'
import type { ServerContext } from '../context.ts'
import { refuseUpgrade } from '../lib/http.ts'
import { parseSessionRoute } from '../lib/parse-route.ts'
import { sessionInfoOf } from './session-lookup.ts'
import { attachClient } from './ws.ts'

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
  const known = await sessionInfoOf(ctx, route.id)
  if (known && !auth.canSee(authCtx, known)) {
    refuseUpgrade(socket, '404 Not Found')
    return
  }
  const runner = await parking.ensureLive(route.id).catch(() => undefined)
  if (!runner || !auth.canSee(authCtx, runner.info())) {
    refuseUpgrade(socket, '404 Not Found')
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachClient(ctx, ws, runner, req, { operator: auth.isOperator(authCtx) })
  })
}
