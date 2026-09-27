import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import type { JobQueue } from '@workerdeck/queue'
import { PROTOCOL_VERSION, type JobEvent, type QueueServerFrame } from '@workerdeck/protocol'
import { refuseUpgrade } from '../lib/http.ts'
import type { DiagnosticSink } from '../options.ts'
import type { AuthService } from '../services/auth.ts'

export type QueueSocketHub = {
  broadcast: (event: JobEvent) => void
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
  clear: () => void
}

export type QueueSocketDeps = {
  wss: WebSocketServer
  auth: AuthService
  queue: () => JobQueue | undefined
  diagnose: DiagnosticSink
}

export function createQueueSocketHub(deps: QueueSocketDeps): QueueSocketHub {
  const sockets = new Set<WebSocket>()

  const broadcast = (event: JobEvent): void => {
    if (sockets.size === 0) {
      return
    }
    for (const ws of sockets) {
      sendQueueFrame(ws, { type: 'job_event', event })
    }
    if (event.type !== 'job_progress') {
      void deps
        .queue()
        ?.stats()
        .then((stats) => {
          for (const ws of sockets) {
            sendQueueFrame(ws, { type: 'queue_stats', stats })
          }
        })
        .catch((error: unknown) => deps.diagnose(error, 'queue-stats'))
    }
  }

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const queue = deps.queue()
    if (!queue) {
      refuseUpgrade(socket, '404 Not Found')
      return
    }
    const auth = await deps.auth.authenticate(req)
    if (!auth.ok) {
      refuseUpgrade(socket, '401 Unauthorized')
      return
    }
    if (!deps.auth.isOperator(auth)) {
      refuseUpgrade(socket, '404 Not Found')
      return
    }
    deps.wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      void queue
        .stats()
        .then((stats) => sendQueueFrame(ws, { type: 'queue_attached', protocolVersion: PROTOCOL_VERSION, stats }))
        .catch((error: unknown) => deps.diagnose(error, 'queue-stats'))
    })
  }

  return { broadcast, upgrade, clear: () => sockets.clear() }
}

function sendQueueFrame(ws: WebSocket, frame: QueueServerFrame): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame))
  }
}
