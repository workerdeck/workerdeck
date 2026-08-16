/**
 * `{basePath}/sessions/:id/attachments` — the files a client sends with a message.
 *
 * `POST ?name=<name>` takes the raw bytes as the body and the media type from
 * the `content-type` header; there is no multipart parsing here on purpose, so
 * a phone and a browser both upload with one plain request and this file stays
 * dependency-free. `GET /:attachmentId` hands the bytes back for thumbnails.
 *
 * The download always answers `content-disposition: attachment` and `nosniff`,
 * the same as `/files`: an upload is client-supplied content served from the
 * gateway's own origin, and it must never render as a document there. (An
 * `<img src>` is unaffected — disposition does not apply to subresources.)
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { attachmentKind } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import { json, readRawBody } from '../lib/http.ts'
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
    // The engine's capability record names the kinds its sendMessage can
    // deliver ('document' is the record's 'pdf'). Refusing here keeps the
    // contract at the door: an upload that succeeds is one the message can use.
    const accepted = (session.capabilities ?? ENGINE_CAPABILITIES[session.engine ?? 'claude'])
      .attachments
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
    const result = attachmentStore.put(
      sessionId,
      url.searchParams.get('name') ?? 'attachment',
      mediaType,
      body,
    )
    if (!result.ok) {
      const status =
        result.error.code === 'unsupported_type'
          ? 415
          : result.error.code === 'empty'
            ? 400
            : 413
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
    res.writeHead(200, {
      'content-type': found.mediaType,
      'content-length': bytes.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      'x-content-type-options': 'nosniff',
    })
    res.end(bytes)
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
