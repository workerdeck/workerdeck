import type { IncomingMessage, ServerResponse } from 'node:http'
import { attachmentKind } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import { fail, json, readRawBody, sendUntrusted } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
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
      fail(400, 'content-type header is required')
    }
    const accepted = (session.capabilities ?? ENGINE_CAPABILITIES[engineOf(session)]).attachments
    const kind = attachmentKind(mediaType)
    if (kind && !accepted.includes(kind === 'document' ? 'pdf' : kind)) {
      fail(415, `the ${engineOf(session)} engine does not accept ${kind} attachments`)
    }
    let body: Buffer
    try {
      body = await readRawBody(req, attachmentStore.maxFileBytes)
    } catch {
      fail(413, 'attachment is larger than the limit')
    }
    const result = attachmentStore.put(sessionId, url.searchParams.get('name') ?? 'attachment', mediaType, body)
    if (!result.ok) {
      const status = result.error.code === 'unsupported_type' ? 415 : result.error.code === 'empty' ? 400 : 413
      fail(status, result.error.message)
    }
    json(res, 201, { attachment: result.attachment })
    return
  }
  if (req.method === 'GET' && attachmentId !== undefined) {
    const found = attachmentStore.get(sessionId, attachmentId)
    if (!found) {
      fail(404, 'attachment not found')
    }
    sendUntrusted(res, found.name, found.mediaType, Buffer.from(found.data, 'base64'))
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
