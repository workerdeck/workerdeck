import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'

/**
 * How a row gets the picture the replay refused to send.
 *
 * The sibling of `tool-result-fetch.tsx` and the same shape of seam, because it
 * answers the same shape of question: an opted-in socket delivers a base64
 * `image` part as an `image_ref` — media type, decoded size, and its index in
 * the stored block — and the bytes are fetched over REST by whoever is actually
 * looking at the row. Across a measured corpus that payload was 91% of every
 * tool result and nothing rendered a byte of it.
 *
 * A **context**, not a prop chain, for the variant's reason: the rows are drawn
 * by `terminalBlocks` and by `ToolCallCard`, several layers under whoever holds
 * the session. The default resolves `undefined`, which is exactly right for
 * every surface that never asked (the playground, a fixture, a hand-composed
 * row): `result.images` is only ever set by a replay a renderer opted into, so a
 * row with no loader also has no reference to load. Only `SessionPanel` supplies
 * a real one, because it owns the session's one attach and therefore the only
 * `(seq, toolUseId)` addresses that mean anything.
 */

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

export function ToolResultImageProvider({
  value,
  children,
}: {
  value: ToolResultImageLoader | undefined
  children: ReactNode
}) {
  return <ImageContext.Provider value={value ?? noop}>{children}</ImageContext.Provider>
}

export function useToolResultImageLoader(): ToolResultImageLoader {
  return useContext(ImageContext)
}

/**
 * Long enough that a fast scrub through an image-heavy session fetches nothing
 * it flew past, short enough to be invisible to a reader who stopped.
 *
 * There is no second visibility system here on purpose: the transcript is
 * virtualized, so a *mounted* row is by definition within an overscan of the
 * viewport — the virtualizer already is the IntersectionObserver, and a second
 * answer to a question that has one is how the two disagree.
 */
const MOUNT_SETTLE_MS = 150

export type ToolResultImageState = { src?: string; failed: boolean }

/**
 * One box's load, for either theme.
 *
 * Fires once the row has been mounted for {@link MOUNT_SETTLE_MS}, and then
 * **runs to completion** — an aborted fetch re-pays the whole image on the
 * return visit, and the gateway is HTTP/1.1, so the browser's per-origin
 * connection cap is the concurrency throttle for free.
 *
 * The effect keys on the address's *primitives*, never on the ref object: the
 * reducer replaces items on every streamed delta, so an object-identity dep
 * would re-run this on every token of the turn after it.
 */
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
          if (live) setState({ src, failed: src === undefined })
        })
        .catch(() => {
          if (live) setState({ failed: true })
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
 * `useHostImage`'s shape, generalized to the replay route — and **bounded**,
 * which `useHostImage` is not.
 *
 * The promise-per-key cache is what makes this callable from a transcript row at
 * all: rows re-render on every streamed delta, and an uncached resolver would
 * re-fetch each time. The LRU is the part that is new. Object URLs pin their
 * blob until revoked, so a fully-scrolled hundred-image session would otherwise
 * hold ~50 MB until the panel unmounted — and evicting means revoking, or the
 * eviction frees a `Map` entry and nothing else.
 *
 * Re-fetching on a return scroll is fine, and is the whole design: the bytes are
 * one authenticated request away, which is precisely what makes it cheap not to
 * have shipped them in the attach.
 */
export function useToolResultImages(
  client: WorkerDeckClient,
  sessionId: string | undefined,
): ToolResultImageLoader {
  const cache = useRef(new Map<string, Entry>())
  useEffect(
    () => () => {
      for (const entry of cache.current.values()) if (entry.url) URL.revokeObjectURL(entry.url)
      cache.current.clear()
    },
    [],
  )
  return useCallback(
    (ref: ToolResultImageRef) => {
      if (!sessionId) return Promise.resolve(undefined)
      // The whole address, because every part of it can change under a row that
      // is still on screen: a dormant wake restarts the seqs, and a cached
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
      // Fetched rather than pointed at: a bare `<img src>` at the gateway
      // carries a credential in exactly one of four clients (the dashboard's
      // same-origin host), and a broken icon in the other three.
      const pending = client
        .toolResultImage(sessionId, ref.sourceSeq, ref.toolUseId, ref.partIndex)
        .then((blob) => {
          if (blob.size === 0) return undefined
          const url = URL.createObjectURL(blob)
          const entry = cache.current.get(key)
          if (entry) {
            entry.url = url
            entry.bytes = blob.size
            evict(cache.current, key)
          } else {
            // Evicted (or unmounted) while in flight — nothing will ever draw
            // this, and an unrevoked URL is the leak the budget exists to stop.
            URL.revokeObjectURL(url)
          }
          return url
        })
        .catch(() => undefined)
      // The declared size is what the budget counts until the bytes land: a
      // hundred fetches in flight must not all read as free.
      cache.current.set(key, { pending, bytes: ref.bytes })
      return pending
    },
    [client, sessionId],
  )
}

/** Drop oldest-first until the held bytes fit the budget, revoking as it goes.
 * `keep` is the entry just resolved — evicting the picture a row is about to
 * draw would be a fetch spent on nothing. */
function evict(cache: Map<string, Entry>, keep: string): void {
  let held = 0
  for (const entry of cache.values()) held += entry.bytes
  for (const [key, entry] of cache) {
    if (held <= CACHE_BUDGET_BYTES) return
    if (key === keep) continue
    if (entry.url) URL.revokeObjectURL(entry.url)
    cache.delete(key)
    held -= entry.bytes
  }
}
