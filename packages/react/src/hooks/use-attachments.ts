import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { EngineCapabilities, ProfileEngine } from '@workerdeck/protocol'

export type StagedAttachment = {
  key: string
  name: string
  mediaType: string
  bytes: number
  previewUrl?: string
  status: 'uploading' | 'ready' | 'failed'
  id?: string
  error?: string
}

export type AttachmentKind = 'image' | 'pdf' | 'text'

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

const MAX_IMAGE_EDGE = 1568

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

export type UseAttachmentsOptions = {
  capabilities: EngineCapabilities
  engine?: ProfileEngine
}

export type UseAttachmentsResult = {
  items: StagedAttachment[]
  readyIds: string[]
  uploading: boolean
  hasFailure: boolean
  accept: string
  disabled: boolean
  add: (files: Iterable<File>) => void
  retry: (key: string) => void
  remove: (key: string) => void
  clear: () => void
  error?: string
  dismissError: () => void
}

export function useAttachments(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  { capabilities, engine }: UseAttachmentsOptions,
): UseAttachmentsResult {
  const [items, setItems] = useState<StagedAttachment[]>([])
  const [error, setError] = useState<string | undefined>()
  const counter = useRef(0)
  const fileByKey = useRef(new Map<string, File>())
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
        // An unclassifiable type still goes: the gateway's vocabulary is the authoritative one.
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
  // All three kinds is no narrowing at all, and an empty accept leaves the picker open.
  return kinds.length === 3 ? '' : parts.join(',')
}

// Reached through globalThis, not named directly: smoke/ typechecks this source with no DOM lib.
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

async function prepare(file: File): Promise<{ body: Blob; mediaType: string }> {
  const mediaType = file.type || 'application/octet-stream'
  const { createImageBitmap, document } = imaging
  if (!createImageBitmap || !document || !mediaType.startsWith('image/')) {
    return { body: file, mediaType }
  }
  // A redraw of an animation would keep one frame of it.
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
    return { body: file, mediaType }
  }
}
