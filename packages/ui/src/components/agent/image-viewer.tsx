import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Download, Maximize, Minus, Plus, X } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'

export type ViewedImage = { src: string; name: string }

export type OpenImage = (image: ViewedImage) => void

type Zoom = number | 'fit'

type Size = { width: number; height: number }

type Anchor = { x: number; y: number; viewX: number; viewY: number }

type Focus = { clientX: number; clientY: number }

const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]

const STAGE_PADDING = 16

const DRAG_SLOP = 4

const WHEEL_ZOOM_RATE = 0.01

const WHEEL_DELTA_CAP = 25

const ViewerContext = createContext<OpenImage | undefined>(undefined)

export function useOpenImage(): OpenImage | undefined {
  return useContext(ViewerContext)
}

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [image, setImage] = useState<ViewedImage>()
  const close = useCallback(() => setImage(undefined), [])
  return (
    <ViewerContext.Provider value={setImage}>
      {children}
      {image ? <ImageViewer key={image.src} image={image} onClose={close} /> : null}
    </ViewerContext.Provider>
  )
}

export function ViewableImage({ image, className, children }: { image: ViewedImage; className?: string; children: ReactNode }) {
  const open = useOpenImage()
  if (!open) {
    return <>{children}</>
  }
  return (
    <button
      type="button"
      aria-label={`View ${image.name}`}
      title={image.name}
      data-slot="viewable-image"
      className={cn('cursor-zoom-in', className)}
      onClick={(event) => {
        event.stopPropagation()
        open(image)
      }}
    >
      {children}
    </button>
  )
}

export function ImageViewer({ image, onClose, className }: { image: ViewedImage; onClose: () => void; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Size>()
  const [stage, setStage] = useState<Size>()
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [failed, setFailed] = useState(false)
  const anchor = useRef<Anchor | undefined>(undefined)
  const wheelScale = useRef<number | undefined>(undefined)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined)
  const dragged = useRef(false)

  const fitScale =
    natural && stage
      ? Math.min(1, (stage.width - STAGE_PADDING * 2) / natural.width, (stage.height - STAGE_PADDING * 2) / natural.height)
      : 1
  const scale = zoom === 'fit' ? Math.max(fitScale, 0.01) : zoom
  const scrollable =
    natural !== undefined && stage !== undefined && (natural.width * scale > stage.width || natural.height * scale > stage.height)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const element = stageRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setStage({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const element = stageRef.current
    const point = anchor.current
    if (!element || !point) {
      return
    }
    anchor.current = undefined
    wheelScale.current = undefined
    element.scrollLeft = point.x * element.scrollWidth - point.viewX
    element.scrollTop = point.y * element.scrollHeight - point.viewY
  }, [scale])

  const zoomTo = useCallback((next: Zoom, focus?: Focus) => {
    const element = stageRef.current
    if (element && element.scrollWidth > 0 && element.scrollHeight > 0) {
      const rect = element.getBoundingClientRect()
      const viewX = focus ? focus.clientX - rect.left : element.clientWidth / 2
      const viewY = focus ? focus.clientY - rect.top : element.clientHeight / 2
      anchor.current = {
        x: (element.scrollLeft + viewX) / element.scrollWidth,
        y: (element.scrollTop + viewY) / element.scrollHeight,
        viewX,
        viewY,
      }
    }
    setZoom(next)
  }, [])

  const step = (direction: 1 | -1) => {
    const next =
      direction > 0 ? ZOOM_STEPS.find((value) => value > scale + 0.001) : ZOOM_STEPS.filter((value) => value < scale - 0.001).at(-1)
    zoomTo(next ?? (direction > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]))
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      step(1)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      step(-1)
    } else if (event.key === '0') {
      event.preventDefault()
      zoomTo('fit')
    } else if (event.key === '1') {
      event.preventDefault()
      zoomTo(1)
    }
  }

  const scaleRef = useRef(scale)
  scaleRef.current = scale

  useEffect(() => {
    const element = stageRef.current
    if (!element) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      event.preventDefault()
      const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, event.deltaY))
      const base = wheelScale.current ?? scaleRef.current
      const next = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, Math.max(ZOOM_STEPS[0]!, base * Math.exp(-delta * WHEEL_ZOOM_RATE)))
      wheelScale.current = next
      zoomTo(next, event)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = stageRef.current
    if (!scrollable || !element || event.button !== 0) {
      return
    }
    dragged.current = false
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    element.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = stageRef.current
    const start = drag.current
    if (!element || !start) {
      return
    }
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > DRAG_SLOP) {
      dragged.current = true
    }
    element.scrollLeft = start.left - (event.clientX - start.x)
    element.scrollTop = start.top - (event.clientY - start.y)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = undefined
    stageRef.current?.releasePointerCapture?.(event.pointerId)
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      tabIndex={-1}
      data-slot="image-viewer"
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      className={cn('absolute inset-0 z-50 flex flex-col bg-bg outline-none', className)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate font-mono text-body-sm text-fg-1" title={image.name}>
            {image.name}
          </div>
          {natural ? (
            <div className="text-label text-fg-4">
              {natural.width} × {natural.height}
            </div>
          ) : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out (-)" onClick={() => step(-1)} disabled={failed}>
          <Minus />
        </Button>
        <span className="w-12 text-center font-mono text-label text-fg-3 tabular-nums">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => step(1)} disabled={failed}>
          <Plus />
        </Button>
        <Button
          variant={zoom === 'fit' ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="Fit to view"
          aria-pressed={zoom === 'fit'}
          title="Fit to view (0)"
          onClick={() => zoomTo('fit')}
          disabled={failed}
        >
          <Maximize />
        </Button>
        <Button
          variant={zoom === 1 ? 'secondary' : 'ghost'}
          size="sm"
          aria-label="Actual size"
          aria-pressed={zoom === 1}
          title="Actual size (1)"
          onClick={() => zoomTo(1)}
          disabled={failed}
          className="font-mono"
        >
          1:1
        </Button>
        <a
          href={image.src}
          download={image.name}
          aria-label="Download"
          title="Download"
          className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <Download className="size-4" />
        </a>
        <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div
        ref={stageRef}
        data-slot="image-viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(event) => {
          if (dragged.current) {
            dragged.current = false
            return
          }
          if (event.target === event.currentTarget || event.target === event.currentTarget.firstElementChild) {
            onClose()
          }
        }}
        className={cn('min-h-0 flex-1 overflow-auto bg-surface-hover/40', scrollable && 'cursor-grab active:cursor-grabbing')}
      >
        <div className="flex min-h-full w-max min-w-full items-center justify-center" style={{ padding: STAGE_PADDING }}>
          {failed ? (
            <span className="text-body-sm text-fg-4">Image could not be displayed</span>
          ) : (
            <img
              src={image.src}
              alt={image.name}
              draggable={false}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              onDoubleClick={() => zoomTo(zoom === 'fit' ? 1 : 'fit')}
              className="block max-w-none select-none"
              style={
                natural
                  ? { width: natural.width * scale, height: natural.height * scale, imageRendering: scale > 2 ? 'pixelated' : undefined }
                  : { maxWidth: '100%', maxHeight: '100%', visibility: 'hidden' }
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
