import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { cn } from '@workerdeck/ui'
import { ArrowLeft, ArrowRight, CornerDownLeft, RotateCcw, Sparkles, X } from 'lucide-react'

import { inflate, measure, measureSelector, REGION_ATTR, useTrackedRect, type Rect } from './regions.ts'
import { useController, useJourneys, useTourState } from './react.tsx'
import type { Card, Journey, Placement, Region } from './types.ts'

const SPOT_PAD = 6
const CARD_WIDTH = 340
const CARD_GAP = 14
const HOTSPOT_ATTR = 'data-demo-hotspot'
const HOVER_LEAVE_MS = 250
const COMPOSER_SELECTOR = `[${REGION_ATTR}="agent-panel"] [data-slot="composer"]`

export function TourOverlay() {
  const state = useTourState()
  const active = state.journey !== undefined
  return (
    <>
      {active ? <Spotlight focus={state.focus} /> : <Hotspots />}
      {state.hint ? <HintChip prompt={state.hint.prompt} /> : null}
      {state.card ? <CoachCard key={`${state.epoch}:${state.checkpoint}:${state.card.title}`} card={state.card} /> : null}
      {active && state.finished ? <FinishedCard journey={state.journey!} /> : null}
    </>
  )
}

function Spotlight({ focus }: { focus: readonly Region[] }) {
  const key = focus.join('|')
  const read = useMemo(() => (key ? () => measure(key.split('|')) : undefined), [key])
  const rect = useTrackedRect(read)
  if (!rect) {
    return null
  }
  const hole = inflate(rect, SPOT_PAD)
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40">
      <div
        className="absolute rounded-lg ring-2 ring-hint transition-all duration-300 ease-out"
        style={{ ...box(hole), boxShadow: '0 0 0 9999px rgb(5 5 8 / 0.62), 0 0 24px 2px rgb(139 147 255 / 0.35)' }}
      />
    </div>
  )
}

function CoachCard({ card }: { card: Card }) {
  const controller = useController()
  const state = useTourState()
  const key = card.focus.join('|')
  const read = useMemo(() => (key ? () => measure(key.split('|')) : undefined), [key])
  const anchor = useTrackedRect(read)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      return
    }
    const observer = new ResizeObserver(() => setHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const ready = height !== undefined && (key === '' || anchor !== undefined)
  const position = ready ? place(anchor, card.placement, height) : { top: 0, left: 0 }
  const step = state.checkpoint + 1
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={card.title}
      className={cn(
        'fixed z-50 flex flex-col gap-3 rounded-xl border border-hint/40 bg-[#17171c]/95 p-4 text-[13px] text-[#d4d4d8] shadow-2xl backdrop-blur',
        ready ? 'animate-[wd-card-in_220ms_ease-out]' : 'invisible',
      )}
      style={{ ...position, width: CARD_WIDTH }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[11px] font-medium tracking-wide text-hint uppercase">
          {state.journey?.title}
          {state.total ? <span className="text-[#71717a]">{`  ${step} / ${state.total}`}</span> : null}
        </div>
        <button type="button" aria-label="Exit tour" className="text-[#71717a] hover:text-white" onClick={() => controller.exit()}>
          <X className="size-4" />
        </button>
      </div>
      <div className="text-[15px] leading-snug font-semibold text-white">{card.title}</div>
      <p className="m-0 leading-relaxed whitespace-pre-line text-[#a1a1aa]">{card.body}</p>
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          disabled={state.checkpoint === 0}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[#a1a1aa] hover:bg-white/5 hover:text-white disabled:opacity-0"
          onClick={() => controller.back()}
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
        {card.waiting ? (
          <span className="flex items-center gap-1.5 text-[12px] text-hint">
            <span className="size-1.5 animate-pulse rounded-full bg-hint" />
            {card.waiting}
          </span>
        ) : state.hint ? (
          <span className="flex items-center gap-1.5 text-[12px] text-hint">
            <Sparkles className="size-3.5" /> Click the prompt to send it
          </span>
        ) : (
          <button
            type="button"
            autoFocus
            className="flex items-center gap-1 rounded-md bg-hint px-3 py-1.5 font-medium text-[#0b0b12] hover:bg-hint-strong"
            onClick={() => controller.next()}
          >
            {card.next ?? 'Next'} <ArrowRight className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function HintChip({ prompt }: { prompt: string }) {
  const controller = useController()
  const read = useCallback(() => measureSelector(COMPOSER_SELECTOR), [])
  const rect = useTrackedRect(read)
  if (!rect) {
    return null
  }
  return (
    <div className="fixed z-50 flex items-center bg-(--vscode-editor-background) px-3" style={box(rect)}>
      <button
        type="button"
        className="group flex max-w-full items-center gap-2 rounded-full border border-hint/60 bg-hint/15 py-1 pr-2 pl-2.5 text-left text-[13px] text-hint-strong shadow-[0_0_0_4px_rgb(139_147_255_/_0.12)] transition hover:bg-hint/25 hover:text-white"
        onClick={() => controller.next()}
      >
        <Sparkles className="size-3.5 shrink-0 animate-pulse" />
        <span className="truncate">{prompt}</span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-hint px-2 py-0.5 text-[11px] font-medium text-[#0b0b12]">
          Send <CornerDownLeft className="size-3" />
        </span>
      </button>
    </div>
  )
}

function FinishedCard({ journey }: { journey: Journey }) {
  const controller = useController()
  const journeys = useJourneys()
  const others = journeys.filter((candidate) => candidate.id !== journey.id)
  return (
    <div className="fixed right-6 bottom-10 z-50 flex w-[340px] flex-col gap-3 rounded-xl border border-hint/40 bg-[#17171c]/95 p-4 text-[13px] text-[#d4d4d8] shadow-2xl backdrop-blur">
      <div className="text-[11px] font-medium tracking-wide text-hint uppercase">Tour complete</div>
      <div className="text-[15px] font-semibold text-white">{journey.title}</div>
      <p className="m-0 text-[#a1a1aa]">The workspace stays live: click around, or take another tour.</p>
      <div className="flex flex-col gap-1">
        {others.map((other) => (
          <JourneyButton key={other.id} journey={other} />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" className="flex items-center gap-1 text-[#a1a1aa] hover:text-white" onClick={() => controller.restart()}>
          <RotateCcw className="size-3.5" /> Replay
        </button>
        <button type="button" className="text-[#a1a1aa] hover:text-white" onClick={() => controller.exit()}>
          Close
        </button>
      </div>
    </div>
  )
}

export function JourneyButton({ journey }: { journey: Journey }) {
  const controller = useController()
  return (
    <button
      type="button"
      className="flex flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-hint/10"
      onClick={() => controller.start(journey)}
    >
      <span className="flex items-center gap-1.5 font-medium text-white">
        <Sparkles className="size-3.5 text-hint" /> {journey.title}
      </span>
      <span className="text-[12px] text-[#a1a1aa]">{journey.summary}</span>
    </button>
  )
}

function Hotspots() {
  const journeys = useJourneys()
  const [hovered, setHovered] = useState<Region | undefined>(undefined)
  const [open, setOpen] = useState<Region | undefined>(undefined)
  const byRegion = useMemo(() => {
    const map = new Map<Region, Journey[]>()
    for (const journey of journeys) {
      for (const region of journey.regions) {
        map.set(region, [...(map.get(region) ?? []), journey])
      }
    }
    return map
  }, [journeys])

  useEffect(() => {
    let leave: ReturnType<typeof setTimeout> | undefined
    const onMove = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`[${HOTSPOT_ATTR}]`)) {
        clearTimeout(leave)
        return
      }
      const region = hotspotAt(target, byRegion)
      if (region) {
        clearTimeout(leave)
        setHovered(region)
        return
      }
      clearTimeout(leave)
      leave = setTimeout(() => setHovered(undefined), HOVER_LEAVE_MS)
    }
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Element && event.target.closest(`[${HOTSPOT_ATTR}]`))) {
        setOpen(undefined)
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerdown', onDown)
    return () => {
      clearTimeout(leave)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [byRegion])

  const shown = open ?? hovered
  const read = useMemo(() => (shown ? () => measure([shown]) : undefined), [shown])
  const rect = useTrackedRect(read)
  if (!shown || !rect) {
    return null
  }
  const offered = byRegion.get(shown) ?? []
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed z-40 rounded-lg border border-dashed border-hint/70 bg-hint/[0.04]"
        style={box(inflate(rect, 2))}
      />
      <div
        {...{ [HOTSPOT_ATTR]: '' }}
        className="fixed z-50"
        style={{ top: rect.top + 6, left: rect.left + rect.width - 6, transform: 'translateX(-100%)' }}
      >
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full bg-hint px-2.5 py-1 text-[12px] font-medium text-[#0b0b12] shadow-lg hover:bg-hint-strong"
          onClick={() => setOpen(open ? undefined : shown)}
        >
          <Sparkles className="size-3.5" />
          {offered.length === 1 ? offered[0]!.title : `${offered.length} tours`}
        </button>
        {open ? (
          <div className="absolute top-full right-0 mt-2 flex w-[320px] flex-col rounded-xl border border-hint/40 bg-[#17171c]/95 p-1.5 text-[13px] shadow-2xl backdrop-blur">
            {offered.map((journey) => (
              <JourneyButton key={journey.id} journey={journey} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
}

function hotspotAt(target: Element | null, offered: ReadonlyMap<Region, Journey[]>): Region | undefined {
  let element = target?.closest(`[${REGION_ATTR}]`) ?? null
  while (element) {
    const region = element.getAttribute(REGION_ATTR)!
    if (offered.has(region)) {
      return region
    }
    element = element.parentElement?.closest(`[${REGION_ATTR}]`) ?? null
  }
  return undefined
}

function place(anchor: Rect | undefined, placement: Placement, height: number): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!anchor || placement === 'center') {
    return { top: Math.max(24, (vh - height) / 2), left: (vw - CARD_WIDTH) / 2 }
  }
  const room = {
    right: vw - (anchor.left + anchor.width),
    left: anchor.left,
    bottom: vh - (anchor.top + anchor.height),
    top: anchor.top,
  }
  const side =
    placement !== 'auto'
      ? placement
      : room.left >= CARD_WIDTH + CARD_GAP * 2 || room.right >= CARD_WIDTH + CARD_GAP * 2
        ? room.left > room.right
          ? 'left'
          : 'right'
        : room.bottom > room.top
          ? 'bottom'
          : 'top'
  const clampTop = (top: number): number => Math.min(Math.max(12, top), vh - height - 12)
  const clampLeft = (left: number): number => Math.min(Math.max(12, left), vw - CARD_WIDTH - 12)
  switch (side) {
    case 'left': {
      return { top: clampTop(anchor.top + SPOT_PAD), left: clampLeft(anchor.left - CARD_WIDTH - CARD_GAP - SPOT_PAD) }
    }
    case 'right': {
      return { top: clampTop(anchor.top + SPOT_PAD), left: clampLeft(anchor.left + anchor.width + CARD_GAP + SPOT_PAD) }
    }
    case 'top': {
      return { top: clampTop(anchor.top - height - CARD_GAP - SPOT_PAD), left: clampLeft(anchor.left + anchor.width / 2 - CARD_WIDTH / 2) }
    }
    default: {
      return {
        top: clampTop(anchor.top + anchor.height + CARD_GAP + SPOT_PAD),
        left: clampLeft(anchor.left + anchor.width / 2 - CARD_WIDTH / 2),
      }
    }
  }
}

function box(rect: Rect): CSSProperties {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}
