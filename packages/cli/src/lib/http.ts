import type { IncomingMessage, ServerResponse } from 'node:http'

// Read a request body, bounded. Resolves `null` if the body exceeds `maxBytes` or the socket
// errors - the caller answers 413 either way; it never resolves twice, and it never buffers
// past the cap, which is the whole point of not using a body parser here.
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

// A JSON answer that is never cached - these routes all carry auth state.
export function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))
}

export type RequestAuthenticator = (req: IncomingMessage) => unknown

// Awaited on purpose: a config file's `authenticate` may be async, and a pending promise is not `null`.
export async function isAuthenticated(authenticate: RequestAuthenticator, req: IncomingMessage): Promise<boolean> {
  const principal = await authenticate(req)
  return principal !== null && principal !== undefined && principal !== false
}

// A cross-site page can send `text/plain` without a preflight; it cannot send `application/json`.
export function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json'
}
