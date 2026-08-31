import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'

export type ToolResultImageRef = {
  toolUseId: string
  sourceSeq: number
  partIndex: number
  mediaType: string
  bytes: number
}

export type ToolResultImageLoader = (ref: ToolResultImageRef) => Promise<string | undefined>

const noop: ToolResultImageLoader = async () => undefined

const ImageContext = createContext<ToolResultImageLoader>(noop)

export function ToolResultImageProvider({ value, children }: { value: ToolResultImageLoader | undefined; children: ReactNode }) {
  return <ImageContext.Provider value={value ?? noop}>{children}</ImageContext.Provider>
}

export function useToolResultImageLoader(): ToolResultImageLoader {
  return useContext(ImageContext)
}

const MOUNT_SETTLE_MS = 150

export type ToolResultImageState = { src?: string; failed: boolean }

export function useToolResultImageSrc(ref: ToolResultImageRef): ToolResultImageState {
  const load = useToolResultImageLoader()
  const [state, setState] = useState<ToolResultImageState>({ failed: false })
  const { toolUseId, sourceSeq, partIndex, mediaType, bytes } = ref
  useEffect(() => {
    let live = true
    setState({ failed: false })
    const timer = setTimeout(() => {
      load({ toolUseId, sourceSeq, partIndex, mediaType, bytes })
        .then((src) => {
          if (live) {
            setState({ src, failed: src === undefined })
          }
        })
        .catch(() => {
          if (live) {
            setState({ failed: true })
          }
        })
    }, MOUNT_SETTLE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [load, toolUseId, sourceSeq, partIndex, mediaType, bytes])
  return state
}

const CACHE_BUDGET_BYTES = 64 * 1024 * 1024

type Entry = { pending: Promise<string | undefined>; url?: string; bytes: number }

export function useToolResultImages(client: WorkerDeckClient, sessionId: string | undefined): ToolResultImageLoader {
  const cache = useRef(new Map<string, Entry>())
  useEffect(
    () => () => {
      for (const entry of cache.current.values()) {
        if (entry.url) {
          URL.revokeObjectURL(entry.url)
        }
      }
      cache.current.clear()
    },
    [],
  )
  return useCallback(
    (ref: ToolResultImageRef) => {
      if (!sessionId) {
        return Promise.resolve(undefined)
      }
      const key = `${sessionId}:${ref.sourceSeq}:${ref.toolUseId}:${ref.partIndex}`
      const hit = cache.current.get(key)
      if (hit) {
        cache.current.delete(key)
        cache.current.set(key, hit)
        return hit.pending
      }
      const pending = client
        .toolResultImage(sessionId, ref.sourceSeq, ref.toolUseId, ref.partIndex)
        .then((blob) => {
          if (blob.size === 0) {
            return undefined
          }
          const url = URL.createObjectURL(blob)
          const entry = cache.current.get(key)
          if (entry) {
            entry.url = url
            entry.bytes = blob.size
            evict(cache.current, key)
          } else {
            URL.revokeObjectURL(url)
          }
          return url
        })
        .catch(() => undefined)
      cache.current.set(key, { pending, bytes: ref.bytes })
      return pending
    },
    [client, sessionId],
  )
}

function evict(cache: Map<string, Entry>, keep: string): void {
  let held = 0
  for (const entry of cache.values()) {
    held += entry.bytes
  }
  for (const [key, entry] of cache) {
    if (held <= CACHE_BUDGET_BYTES) {
      return
    }
    if (key === keep) {
      continue
    }
    if (entry.url) {
      URL.revokeObjectURL(entry.url)
    }
    cache.delete(key)
    held -= entry.bytes
  }
}
