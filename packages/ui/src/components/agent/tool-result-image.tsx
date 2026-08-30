/**
 * How a row gets the picture the replay refused to send: an opted-in socket
 * delivers a base64 `image` part as an `image_ref` and the bytes are fetched
 * over REST by whoever is looking at the row.
 *
 * The default resolves `undefined`, correct for every surface that never asked:
 * `result.images` is only ever set by a replay a renderer opted into, so a row
 * with no loader also has no reference to load. Only `SessionPanel` supplies a
 * real one — it owns the session's one attach and therefore the only
 * `(seq, toolUseId)` addresses that mean anything.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'

/** One image part, as the row addresses it: the reducer's entry plus the id of
 * the call it came back from. `sourceSeq` is the entry's **own** — the
 * result-level one is cleared by text hydration, and a reader who pressed "show
 * everything" must still be able to load the screenshot afterwards. */
export type ToolResultImageRef = {
  toolUseId: string
  sourceSeq: number
  partIndex: number
  mediaType: string
  bytes: number
}

/** Resolves an object URL for the picture, or `undefined` when the gateway will
 * not serve it — a stale address after a dormant wake, a gateway with no such
 * route, a dropped connection. The row draws a box either way. */
export type ToolResultImageLoader = (ref: ToolResultImageRef) => Promise<string | undefined>

const noop: ToolResultImageLoader = async () => undefined

const ImageContext = createContext<ToolResultImageLoader>(noop)

export function ToolResultImageProvider({ value, children }: { value: ToolResultImageLoader | undefined; children: ReactNode }) {
  return <ImageContext.Provider value={value ?? noop}>{children}</ImageContext.Provider>
}

export const useToolResultImageLoader = (): ToolResultImageLoader => {
  return useContext(ImageContext)
}

/**
 * Long enough that a fast scrub through an image-heavy session fetches nothing
 * it flew past. No IntersectionObserver beside it on purpose: the transcript is
 * virtualized, so a mounted row is already within an overscan of the viewport.
 */
const MOUNT_SETTLE_MS = 150

export type ToolResultImageState = { src?: string; failed: boolean }

/**
 * One box's load, for either theme. Fires once the row has been mounted for
 * {@link MOUNT_SETTLE_MS} and then **runs to completion** — an aborted fetch
 * re-pays the whole image on the return visit.
 *
 * The effect keys on the address's *primitives*, never on the ref object: the
 * reducer replaces items on every streamed delta, so an object-identity dep
 * would re-run this on every token of the turn after it.
 */
export const useToolResultImageSrc = (ref: ToolResultImageRef): ToolResultImageState => {
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

/** ~64 MB of decoded pictures held at once. At the corpus's 335 KB median that
 * is ~190 images, which no viewport holds; the budget exists so a session
 * scrolled end to end does not pin every screenshot it passed. */
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024

type Entry = { pending: Promise<string | undefined>; url?: string; bytes: number }

/**
 * `useHostImage`'s shape generalized to the replay route, and **bounded**.
 *
 * The promise-per-key cache is what makes this callable from a transcript row:
 * rows re-render on every streamed delta, and an uncached resolver would
 * re-fetch each time. **Eviction must revoke** — object URLs pin their blob
 * until revoked, so freeing only the `Map` entry frees nothing. Re-fetching on
 * a return scroll is the design.
 */
export const useToolResultImages = (client: WorkerDeckClient, sessionId: string | undefined): ToolResultImageLoader => {
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
      // The whole address: a dormant wake restarts the seqs, and a cached
      // address that outlived its log must miss rather than serve another
      // call's pixels.
      const key = `${sessionId}:${ref.sourceSeq}:${ref.toolUseId}:${ref.partIndex}`
      const hit = cache.current.get(key)
      if (hit) {
        // Re-inserting is the "recently used" half of the LRU: `Map` iterates in
        // insertion order, so eviction reads oldest-first for free.
        cache.current.delete(key)
        cache.current.set(key, hit)
        return hit.pending
      }
      // Fetched rather than pointed at: a bare `<img src>` carries a credential
      // in only one of the four clients (the dashboard's same-origin host).
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
            // Evicted while in flight — an unrevoked URL is the leak the budget
            // exists to stop.
            URL.revokeObjectURL(url)
          }
          return url
        })
        .catch(() => undefined)
      // The declared size is what the budget counts until the bytes land.
      cache.current.set(key, { pending, bytes: ref.bytes })
      return pending
    },
    [client, sessionId],
  )
}

/** Drop oldest-first until the held bytes fit the budget, revoking as it goes.
 * `keep` is the entry just resolved — evicting the picture a row is about to
 * draw would be a fetch spent on nothing. */
const evict = (cache: Map<string, Entry>, keep: string): void => {
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
