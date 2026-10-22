import type WebSocket from 'ws'
import { GENERATION_HEADER, type ConversationsResponse, type ServerFrame } from '@workerdeck/protocol'

// Protocol 2 refuses an unstamped mutation: every frame names the conversation it meant, read off the `attached` hello.
// Call it right after constructing the socket, so the hello cannot arrive before the listener.
export function conversationOf(ws: WebSocket, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no attached frame within ${timeoutMs / 1000}s`)), timeoutMs)
    ws.once('close', (code) => reject(new Error(`socket closed (${code}) before attached`)))
    const listen = (data: unknown): void => {
      const frame = JSON.parse(String(data)) as ServerFrame
      if (frame.type === 'attached') {
        ws.off('message', listen)
        clearTimeout(timer)
        resolve(frame.session.conversation ?? 1)
      }
    }
    ws.on('message', listen)
  })
}

// The REST twin: a mutating `/sessions/:id/...` call carries the session's current conversation in a header.
export async function generationHeaders(
  base: string,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const id = /^\/sessions\/([^/?]+)\//.exec(path)?.[1] ?? /^\/sessions\/([^/?]+)$/.exec(path)?.[1]
  if (!id || method === 'GET' || method === 'HEAD') {
    return {}
  }
  const res = await fetch(`${base}/sessions/${id}/conversations`, { headers })
  const body = res.ok ? ((await res.json()) as ConversationsResponse) : undefined
  return body?.conversation === undefined ? {} : { [GENERATION_HEADER]: String(body.conversation) }
}
