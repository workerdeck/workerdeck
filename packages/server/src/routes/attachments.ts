import type { IncomingMessage, ServerResponse } from 'node:http'
import { attachmentKind } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import { json, readRawBody, untrustedDownloadHeaders } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export async function handleAttachments(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  session: SessionInfo,
  attachmentId?: string,
): Promise<void> {
  const { attachmentStore } = ctx
  if (req.method === 'POST' && attachmentId === undefined) {
    const url = new URL(req.url ?? '/', 'http://internal')
    const mediaType = req.headers['content-type']
    if (!mediaType) {
      json(res, 400, { error: 'content-type header is required' })
      return
    }
    const accepted = (session.capabilities ?? ENGINE_CAPABILITIES[session.engine ?? 'claude']).attachments
    const kind = attachmentKind(mediaType)
    if (kind && !accepted.includes(kind === 'document' ? 'pdf' : kind)) {
      json(res, 415, {
        error: `the ${session.engine ?? 'claude'} engine does not accept ${kind} attachments`,
      })
      return
    }
    let body: Buffer
    try {
      body = await readRawBody(req, attachmentStore.maxFileBytes)
    } catch {
      json(res, 413, { error: 'attachment is larger than the limit' })
      return
    }
    const result = attachmentStore.put(sessionId, url.searchParams.get('name') ?? 'attachment', mediaType, body)
    if (!result.ok) {
      const status = result.error.code === 'unsupported_type' ? 415 : result.error.code === 'empty' ? 400 : 413
      json(res, status, { error: result.error.message })
      return
    }
    json(res, 201, { attachment: result.attachment })
    return
  }
  if (req.method === 'GET' && attachmentId !== undefined) {
    const found = attachmentStore.get(sessionId, attachmentId)
    if (!found) {
      json(res, 404, { error: 'attachment not found' })
      return
    }
    const bytes = Buffer.from(found.data, 'base64')
    res.writeHead(200, untrustedDownloadHeaders(found.name, found.mediaType, bytes.length))
    res.end(bytes)
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
