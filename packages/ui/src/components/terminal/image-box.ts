import type { TranscriptItem } from '@workerdeck/react'
import { formatBytes } from '../../lib/format.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

export const IMAGE_BOX_LINES = 12

const HOST_IMAGE_TOOLS = new Set(['CodexImageGeneration', 'CodexImageView'])

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export function imagePlaceholder(image: { bytes: number }): string {
  return `image · ${formatBytes(image.bytes)}`
}

export const IMAGE_UNAVAILABLE = 'image unavailable'

export function hostImagePathOf(item: ToolCallItem): string | undefined {
  if (!HOST_IMAGE_TOOLS.has(item.name)) {
    return undefined
  }
  const input = item.input as { savedPath?: unknown; path?: unknown } | null
  const path = input?.savedPath ?? input?.path
  return typeof path === 'string' ? path : undefined
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function resultImageName(toolName: string, image: { partIndex: number; mediaType: string }): string {
  const extension = MEDIA_EXTENSIONS[image.mediaType] ?? image.mediaType.split('/').pop() ?? 'img'
  return `${toolName.toLowerCase()}-${image.partIndex + 1}.${extension}`
}
