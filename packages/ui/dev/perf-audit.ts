export interface PerfReport {
  rows: number
  totalPx: number
  frames: number
  frameMs: { mean: number; p50: number; p95: number; max: number }
  /** Frames over ~2× the 60Hz budget — visible hitches. */
  dropped: number
  longTasks: { count: number; totalMs: number; maxMs: number }
  sweepMs: number
}

function round(n: number) {
  return Math.round(n * 10) / 10
}

export async function perfSweep(scroller: HTMLElement, { step = 400 }: { step?: number } = {}): Promise<PerfReport> {
  const longTasks: { duration: number }[] = []
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ duration: entry.duration })
      }
    })
    observer.observe({ type: 'longtask' })
  } catch {
    // Long-task timing is Chromium-only; the frame numbers still stand.
  }

  const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  scroller.scrollTop = 0
  await raf()
  await raf()

  const max = scroller.scrollHeight - scroller.clientHeight
  const deltas: number[] = []
  const started = performance.now()
  let last = started
  for (const dir of [1, -1] as const) {
    const steps = Math.ceil(max / step)
    for (let i = 0; i < steps; i++) {
      scroller.scrollTop += dir * step
      await raf()
      const now = performance.now()
      deltas.push(now - last)
      last = now
    }
  }
  observer?.disconnect()

  const sorted = [...deltas].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  const rows = scroller.querySelectorAll('[data-index]').length
  return {
    rows,
    totalPx: max,
    frames: deltas.length,
    frameMs: {
      mean: round(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)),
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      max: round(sorted[sorted.length - 1] ?? 0),
    },
    dropped: deltas.filter((d) => d > 33).length,
    longTasks: {
      count: longTasks.length,
      totalMs: round(longTasks.reduce((a, t) => a + t.duration, 0)),
      maxMs: round(Math.max(0, ...longTasks.map((t) => t.duration))),
    },
    sweepMs: round(performance.now() - started),
  }
}
