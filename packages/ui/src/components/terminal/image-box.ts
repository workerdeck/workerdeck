import { formatBytes } from '../../lib/format.ts'

/**
 * The box a tool result's image is drawn in, and the words drawn in it before
 * the bytes arrive.
 *
 * Its own module, and pure, for `result-preview.ts`'s reason with a constant
 * standing where a string stood: `items.tsx` draws these boxes and `height.ts`
 * predicts their pixel height for the virtualizer's `estimateSize` without a
 * DOM. Two spellings of the box would be two different heights, and the row
 * would grow or shrink the moment it mounted.
 *
 * **A fixed box, sized in whole lines, reserved from plan time.** An image's
 * intrinsic dimensions are not knowable before its bytes are, and the
 * alternative — an `exact: false` row corrected on mount — would demote *most*
 * rows of an image-bearing session to estimates and bring back the growing
 * scrollbar the calculator exists to kill. A box that does not depend on what is
 * inside it is exact by definition, at the cost of some letterboxing.
 */

/**
 * Whole lines per image. 12 ≈ 240px at an 18px line — big enough that a
 * screenshot is legible as *what it is* (which is the whole reason images became
 * visible at all), small enough that a call returning four of them does not
 * become a screenful.
 */
export const IMAGE_BOX_LINES = 12

/**
 * What the box says before the fetch lands.
 *
 * `bytes` is the decoded size the gateway stamped on the reference — the client
 * holds no bytes at all until it asks for them, so this is a number it cannot
 * compute, the same reason `total_chars` rides beside a truncated head.
 * `formatBytes` rather than a spelling of its own: the panel says "336.0 KB"
 * everywhere else, and a second byte formatter is a second thing to keep in
 * step.
 */
export function imagePlaceholder(image: { bytes: number }): string {
  return `image · ${formatBytes(image.bytes)}`
}

/**
 * What it says when the fetch failed — a stale address after a dormant wake
 * (the route 404s rather than serving another call's pixels), a gateway too old
 * to know the route, a dropped connection.
 *
 * It occupies the same box, because the alternative is the row changing height
 * on a network failure. Silence is not an option here the way it is for
 * `HostImage`: that card names the host path in its result text, so a reader can
 * still find the picture; a replayed image part has no path to name.
 */
export const IMAGE_UNAVAILABLE = 'image unavailable'
