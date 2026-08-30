import { formatBytes } from '../../lib/format.ts'

/**
 * The box a tool result's image is drawn in. Pure and its own module because
 * `items.tsx` draws these boxes and `height.ts` predicts their pixel height
 * without a DOM — two spellings would be two different heights.
 *
 * The box is fixed, sized in whole lines, reserved before the bytes arrive: an
 * image's intrinsic dimensions are unknowable until fetched, and a
 * mount-corrected row would bring back the growing scrollbar the height
 * calculator exists to kill. Letterboxing is the accepted cost.
 */

/** 12 lines ≈ 240px at an 18px line: legible screenshot, and four of them still fit a screen. */
export const IMAGE_BOX_LINES = 12

/**
 * What the box says before the fetch lands. `bytes` is the decoded size the
 * gateway stamped on the reference — the client cannot compute it.
 */
export function imagePlaceholder(image: { bytes: number }): string {
  return `image · ${formatBytes(image.bytes)}`
}

/**
 * Fetch-failure text (stale address after dormant wake, old gateway, dropped
 * connection). Occupies the same box so the row's height survives the failure.
 */
export const IMAGE_UNAVAILABLE = 'image unavailable'
