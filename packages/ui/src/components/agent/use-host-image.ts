import { useCallback, useEffect, useMemo } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { ProducedFileRef } from '@workerdeck/react'

type HostImageStore = { cache: Map<string, Promise<string | undefined>>; urls: Set<string>; live: boolean }

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

// A definitive "no image" stays cached; a failed request does not, so a later render can ask again.
export function useHostImage(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  producedFiles: Record<string, ProducedFileRef> | undefined,
): (path: string) => Promise<string | undefined> {
  const store = useMemo<HostImageStore>(() => ({ cache: new Map(), urls: new Set(), live: true }), [client, sessionId])
  useEffect(() => {
    store.live = true
    return () => {
      store.live = false
      for (const url of store.urls) {
        URL.revokeObjectURL(url)
      }
      store.urls.clear()
      store.cache.clear()
    }
  }, [store])
  return useCallback(
    (path: string) => {
      const produced = producedFiles?.[path]
      const key = produced ? `produced:${produced.fileId}` : `fs:${path}`
      const hit = store.cache.get(key)
      if (hit) {
        return hit
      }
      const request = produced && sessionId ? readProduced(client, sessionId, produced.fileId, store) : readHostImage(client, path)
      const pending = request.catch(() => {
        if (store.cache.get(key) === pending) {
          store.cache.delete(key)
        }
        return undefined
      })
      store.cache.set(key, pending)
      return pending
    },
    [client, sessionId, producedFiles, store],
  )
}

async function readProduced(
  client: WorkerDeckClient,
  sessionId: string,
  fileId: string,
  store: HostImageStore,
): Promise<string | undefined> {
  const blob = await client.readProducedFile(sessionId, fileId)
  if (blob.size === 0) {
    return undefined
  }
  const url = URL.createObjectURL(blob)
  if (!store.live) {
    URL.revokeObjectURL(url)
    throw new Error('host image store disposed')
  }
  store.urls.add(url)
  return url
}

async function readHostImage(client: WorkerDeckClient, path: string): Promise<string | undefined> {
  const file = await client.readHostFile(path)
  if (file.encoding !== 'base64') {
    return undefined
  }
  const mediaType = IMAGE_MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
  return mediaType ? `data:${mediaType};base64,${file.content}` : undefined
}
