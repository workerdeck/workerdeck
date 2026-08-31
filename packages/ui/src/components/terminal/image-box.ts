import { formatBytes } from '../../lib/format.ts'

export const IMAGE_BOX_LINES = 12

export function imagePlaceholder(image: { bytes: number }): string {
  return `image · ${formatBytes(image.bytes)}`
}

export const IMAGE_UNAVAILABLE = 'image unavailable'
