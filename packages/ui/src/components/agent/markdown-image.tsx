import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'
import { parseFileLink } from '../../lib/file-link.ts'
import { useFileLinks } from '../terminal/file-link.tsx'
import { IMAGE_BOX_LINES, IMAGE_UNAVAILABLE, baseName } from '../terminal/image-box.ts'
import { ViewableImage } from './image-viewer.tsx'
import { useHostImageSrc } from './tool-result-image.tsx'

// Streamdown's sanitize drops `file:` sources and its harden step blocks or re-roots relative ones, so
// a host path is carried through both as an address on a reserved, never-resolving host.
const LOCAL_PREFIX = 'https://local-image.invalid/'

const WEB_SOURCE = /^(?:https?:|data:image\/|blob:)/i

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

function shieldLocalImages() {
  return (tree: HastNode) => {
    walk(tree)
  }
}

function walk(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'img' && node.properties) {
    const src = node.properties.src
    if (typeof src === 'string' && src.trim() && !WEB_SOURCE.test(src.trim())) {
      node.properties.src = LOCAL_PREFIX + encodeURIComponent(src.trim())
    }
  }
  for (const child of node.children ?? []) {
    walk(child)
  }
}

export const MARKDOWN_REHYPE_PLUGINS: NonNullable<StreamdownProps['rehypePlugins']> = [
  shieldLocalImages,
  ...Object.values(defaultRehypePlugins),
]

export function localImagePath(src: string | undefined): string | undefined {
  if (!src?.startsWith(LOCAL_PREFIX)) {
    return undefined
  }
  try {
    return decodeURIComponent(src.slice(LOCAL_PREFIX.length))
  } catch {
    return undefined
  }
}

export function MarkdownImage({ src, alt, terminal }: { src?: unknown; alt?: unknown; terminal?: boolean }) {
  const links = useFileLinks()
  const raw = typeof src === 'string' ? src : undefined
  const local = localImagePath(raw)
  const path = local === undefined ? undefined : parseFileLink(local, links?.cwd)?.path
  const host = useHostImageSrc(path)
  const resolved = local === undefined ? raw : host.src
  const label = typeof alt === 'string' && alt ? alt : undefined
  const name = path ? baseName(path) : (label ?? 'image')
  const failed = local !== undefined && (path === undefined || host.failed)

  if (terminal) {
    return (
      <span
        className="term-image"
        data-state={resolved ? 'loaded' : failed ? 'failed' : 'pending'}
        style={{ height: `calc(var(--term-line) * ${IMAGE_BOX_LINES})` }}
      >
        {resolved ? (
          <ViewableImage image={{ src: resolved, name }}>
            <img src={resolved} alt={label ?? name} />
          </ViewableImage>
        ) : (
          <span data-tone="faint">{failed ? `${IMAGE_UNAVAILABLE} · ${local ?? name}` : name}</span>
        )}
      </span>
    )
  }

  if (!resolved) {
    return (
      <span className="my-1 inline-block rounded-md border border-border bg-surface-hover px-2 py-1 text-label text-fg-4">
        {failed ? `${IMAGE_UNAVAILABLE} · ${local ?? name}` : name}
      </span>
    )
  }
  return (
    <ViewableImage image={{ src: resolved, name }} className="my-1 block max-w-full">
      <img src={resolved} alt={label ?? name} className="max-h-96 w-auto max-w-full rounded-md border border-border" />
    </ViewableImage>
  )
}
