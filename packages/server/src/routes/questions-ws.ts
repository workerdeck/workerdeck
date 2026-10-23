import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import { PROTOCOL_VERSION, type QuestionsServerFrame } from '@workerdeck/protocol'
import { refuseUpgrade } from '../lib/http.ts'
import type { AuthService } from '../services/auth.ts'
import type { QuestionService } from '../services/questions.ts'

export type QuestionSocketHub = {
  changed: (board: string) => void
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
  clear: () => void
}

export type QuestionSocketDeps = {
  wss: WebSocketServer
  auth: AuthService
  questions: () => QuestionService | undefined
}

export function createQuestionSocketHub(deps: QuestionSocketDeps): QuestionSocketHub {
  const sockets = new Set<WebSocket>()

  const changed = (boardId: string): void => {
    if (sockets.size === 0) {
      return
    }
    const board = deps.questions()?.boardInfo(boardId)
    if (!board) {
      return
    }
    for (const ws of sockets) {
      sendQuestionsFrame(ws, { type: 'questions_changed', board })
    }
  }

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (!deps.questions()) {
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
      const boards = deps.questions()?.boards() ?? []
      sendQuestionsFrame(ws, { type: 'questions_attached', protocolVersion: PROTOCOL_VERSION, boards })
    })
  }

  return { changed, upgrade, clear: () => sockets.clear() }
}

function sendQuestionsFrame(ws: WebSocket, frame: QuestionsServerFrame): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame))
  }
}
