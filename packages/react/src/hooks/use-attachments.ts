import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { EngineCapabilities, ProfileEngine } from '@workerdeck/protocol'

/**
 * Files staged for the next message.
 *
 * The upload happens as soon as something is picked, not at send time — the
 * message names attachment *ids*, so the bytes must already be the server's
 * before a turn can reference them, and the wait is spent while the user is
 * still typing rather than after they hit send. It also keeps base64 out of the
 * event log entirely, which is the protocol's rule.
 */
export type StagedAttachment = {
  /** Local identity, stable across a retry — the React key while uploading. */
  key: string
  name: string
  mediaType: string
  bytes: number
  /** Object URL for an image thumbnail, revoked when the item goes away. */
  previewUrl?: string
  status: 'uploading' | 'ready' | 'failed'
  /** The server's id once uploaded — what `send` names. */
  id?: string
  /** Why the upload failed, verbatim from the gateway (413, 415, …). */
  error?: string
}

/** The kind vocabulary of {@link EngineCapabilities.attachments}. */
export type AttachmentKind = 'image' | 'pdf' | 'text'

/**
 * How a media type reaches a model, in the capability record's vocabulary.
 * `undefined` means this build can't classify it — the upload still goes,
 * because the gateway's vocabulary is the authoritative one.
 */
export function attachmentKind(mediaType: string): AttachmentKind | undefined {
  const type = mediaType.split(';')[0]!.trim().toLowerCase()
  if (type.startsWith('image/')) {
    return 'image'
  }
  if (type === 'application/pdf') {
    return 'pdf'
  }
  if (type.startsWith('text/')) {
    return 'text'
  }
  if (TEXTUAL_TYPES.has(type)) {
    return 'text'
  }
  return undefined
}

/** Textual types whose media type doesn't start with `text/` — mirrors core. */
const TEXTUAL_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
])

/** Longest edge an image is downscaled to before upload. Anthropic's own
 * recommendation, and the same number the iOS client uses — a phone photo is
 * several times this in each direction and costs tokens for nothing. */
const MAX_IMAGE_EDGE = 1568

export type UseAttachmentsOptions = {
  /** The session's capability record — its `attachments` list decides which
   * kinds are offered and which are refused locally. */
  capabilities: EngineCapabilities
  /** Named in a local refusal, so "the codex engine does not take pdf
   * attachments" says which engine meant it. */
  engine?: ProfileEngine
}

export type UseAttachmentsResult = {
  items: StagedAttachment[]
  /** Uploaded ids in staging order — what {@link UseClaudeSessionResult.send} names. */
  readyIds: string[]
  /** An id that hasn't landed can't be named, so send waits. */
  uploading: boolean
  /** A refused file must be dealt with before the message goes. */
  hasFailure: boolean
  /** Accept attribute for a file input, narrowed to what the engine takes. */
  accept: string
  /** True when the engine takes no attachments at all — hide the affordance
   * entirely rather than offer one with no meaning. */
  disabled: boolean
  add: (files: Iterable<File>) => void
  retry: (key: string) => void
  remove: (key: string) => void
  clear: () => void
  /** A local refusal (wrong kind), surfaced once rather than silently dropped. */
  error?: string
  dismissError: () => void
}

/**
 * Stage, upload and track files for the next message of a session.
 *
 * Refusals happen as early as they can be known: a kind the capability record
 * forswears never reaches the network (the gateway would 415 it), and everything
 * else is the gateway's call — its vocabulary is authoritative, so an unknown
 * media type is uploaded rather than guessed at.
 */
export function useAttachments(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  { capabilities, engine }: UseAttachmentsOptions,
): UseAttachmentsResult {
  const [items, setItems] = useState<StagedAttachment[]>([])
  const [error, setError] = useState<string | undefined>()
  const counter = useRef(0)
  /** The originals, kept so a failed upload can be retried without re-picking. */
  const fileByKey = useRef(new Map<string, File>())
  /** Mirrors the live preview URLs so unmount can revoke them all — an unmount
   * with blobs outstanding is a leak the GC does not clean up. */
  const previewUrls = useRef<string[]>([])
  previewUrls.current = items.flatMap((item) => (item.previewUrl ? [item.previewUrl] : []))
  const accepts = capabilities.attachments

  useEffect(
    () => () => {
      for (const url of previewUrls.current) {
        URL.revokeObjectURL(url)
      }
    },
    [],
  )

  const patch = useCallback((key: string, next: Partial<StagedAttachment>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)))
  }, [])

  const upload = useCallback(
    (key: string, file: File) => {
      if (!sessionId) {
        return
      }
      patch(key, { status: 'uploading', error: undefined })
      void (async () => {
        try {
          const data = await prepare(file)
          const uploaded = await client.uploadAttachment(sessionId, {
            name: file.name,
            mediaType: data.mediaType,
            data: data.body,
          })
          patch(key, { status: 'ready', id: uploaded.id, bytes: uploaded.bytes ?? file.size })
        } catch (e) {
          patch(key, { status: 'failed', error: e instanceof Error ? e.message : 'Upload failed' })
        }
      })()
    },
    [client, patch, sessionId],
  )

  const add = useCallback(
    (files: Iterable<File>) => {
      const staged: StagedAttachment[] = []
      const pending: Array<{ key: string; file: File }> = []
      for (const file of files) {
        const mediaType = file.type || 'application/octet-stream'
        const kind = attachmentKind(mediaType)
        // A kind this build can't classify still goes through: the gateway's
        // vocabulary is the authoritative one, and it answers with a real reason.
        if (kind && !accepts.includes(kind)) {
          setError(`The ${engine ?? 'claude'} engine does not take ${kind} attachments.`)
          continue
        }
        const key = `att-${++counter.current}`
        staged.push({
          key,
          name: file.name,
          mediaType,
          bytes: file.size,
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
          status: 'uploading',
        })
        pending.push({ key, file })
      }
      if (staged.length === 0) {
        return
      }
      setItems((current) => [...current, ...staged])
      fileByKey.current = new Map([...fileByKey.current, ...pending.map(({ key, file }) => [key, file] as const)])
      for (const { key, file } of pending) {
        upload(key, file)
      }
    },
    [accepts, engine, upload],
  )

  const forget = useCallback((keys: string[]) => {
    setItems((current) => {
      for (const item of current) {
        if (keys.includes(item.key) && item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl)
        }
      }
      return current.filter((item) => !keys.includes(item.key))
    })
    for (const key of keys) {
      fileByKey.current.delete(key)
    }
  }, [])

  const remove = useCallback((key: string) => forget([key]), [forget])

  const clear = useCallback(() => {
    setItems((current) => {
      for (const item of current) {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl)
        }
      }
      return []
    })
    fileByKey.current.clear()
  }, [])

  const retry = useCallback(
    (key: string) => {
      const file = fileByKey.current.get(key)
      if (file) {
        upload(key, file)
      }
    },
    [upload],
  )

  return useMemo(
    () => ({
      items,
      readyIds: items.flatMap((item) => (item.id ? [item.id] : [])),
      uploading: items.some((item) => item.status === 'uploading'),
      hasFailure: items.some((item) => item.status === 'failed'),
      accept: acceptAttribute(accepts),
      disabled: accepts.length === 0 || !sessionId,
      add,
      retry,
      remove,
      clear,
      error,
      dismissError: () => setError(undefined),
    }),
    [items, accepts, sessionId, add, retry, remove, clear, error],
  )
}

/** What a file input should offer. The full set keeps the open door (anything —
 * the gateway refuses the rest with a clear message); a narrower record narrows
 * the browsing too, so most refusals never happen. */
function acceptAttribute(kinds: readonly AttachmentKind[]): string {
  if (kinds.length === 0) {
    return ''
  }
  const parts: string[] = []
  if (kinds.includes('image')) {
    parts.push('image/*')
  }
  if (kinds.includes('pdf')) {
    parts.push('application/pdf')
  }
  if (kinds.includes('text')) {
    parts.push('text/*', '.md', '.json', '.yaml', '.yml', '.toml')
  }
  return kinds.length === 3 ? '' : parts.join(',')
}

/**
 * The two browser APIs the downscale needs, reached through `globalThis` and
 * typed structurally.
 *
 * This package compiles without the DOM lib — Node-only consumers (the smoke
 * tsconfig) pull its source in — so naming `document` or `createImageBitmap`
 * directly is a type error there. Feature-detecting them is what the code has to
 * do at runtime anyway: the downscale is an optimisation, and a host that can't
 * do it uploads the original.
 */
type ImageBitmapLike = { width: number; height: number; close(): void }
type CanvasLike = {
  width: number
  height: number
  getContext(contextId: '2d'): {
    drawImage(image: ImageBitmapLike, dx: number, dy: number, dw: number, dh: number): void
  } | null
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void
}
const imaging = globalThis as unknown as {
  createImageBitmap?: (source: Blob) => Promise<ImageBitmapLike>
  document?: { createElement(tagName: 'canvas'): CanvasLike }
}

/**
 * The bytes to upload, and the type they are.
 *
 * Oversized images are redrawn to {@link MAX_IMAGE_EDGE} first: a modern phone
 * photo is 4000px on its long edge, which costs tokens for detail no model
 * reads, and often exceeds the gateway's per-file cap outright. Everything else
 * — and anything the browser can't decode — is uploaded as-is, so a failure here
 * is never worse than not trying.
 */
async function prepare(file: File): Promise<{ body: Blob; mediaType: string }> {
  const mediaType = file.type || 'application/octet-stream'
  const { createImageBitmap, document } = imaging
  // GIFs are excluded because a redraw would keep one frame of an animation.
  if (!createImageBitmap || !document || !mediaType.startsWith('image/')) {
    return { body: file, mediaType }
  }
  if (mediaType === 'image/gif') {
    return { body: file, mediaType }
  }
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= MAX_IMAGE_EDGE) {
      bitmap.close()
      return { body: file, mediaType }
    }
    const scale = MAX_IMAGE_EDGE / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return { body: file, mediaType }
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob ? { body: blob, mediaType: 'image/jpeg' } : { body: file, mediaType }
  } catch {
    // A format the browser can't decode (HEIC on most desktops) — let the
    // gateway answer with its own 415 rather than inventing one here.
    return { body: file, mediaType }
  }
}
