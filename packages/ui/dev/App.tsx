import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptState } from '@workerdeck/react'
import { TerminalPermissionPrompt } from '../src/components/terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../src/components/terminal/QuestionPrompt.tsx'
import { TerminalStatusLine } from '../src/components/terminal/StatusLine.tsx'
import { TerminalSurface } from '../src/components/terminal/surface.tsx'
import { Composer } from '../src/components/agent/Composer.tsx'
import { Transcript } from '../src/components/agent/Transcript.tsx'
import { TranscriptVariantProvider } from '../src/components/agent/transcript-variant.tsx'
import { BASH_APPROVAL, EDIT_APPROVAL, FIXTURES, QUESTIONS } from './fixtures.ts'
import { markdownHeight, measureCh, textLines } from '../src/components/terminal/height.ts'
import { terminalBlocks } from '../src/components/terminal/items.tsx'
import { rowIndexForItem, type TranscriptRow } from '../src/components/agent/Transcript.tsx'
import { auditGrid, type GridReport } from './grid-audit.ts'
import { auditHeights } from './height-audit.ts'
import { perfSweep } from './perf-audit.ts'
import { cn } from '../src/lib/utils.ts'

/** The prompts are not transcript items — they are the panel's, rendered under
 * it — so the playground mounts them the same way an embedder would. */
const PROMPTS = [
  { key: 'none', label: '—' },
  { key: 'edit', label: 'edit approval' },
  { key: 'bash', label: 'bash approval' },
  { key: 'ask', label: 'questions' },
] as const

/**
 * The playground: a fixture picker, the metrics, and the grid overlay.
 *
 * Deliberately plain — everything interesting is on the right-hand side. The
 * controls exist because the three things that break a grid renderer are a
 * changed cell size, a narrow viewport and a row that only *looks* aligned, and
 * each needs to be reachable in one click.
 */
/** A stand-in thumbnail: a 1x1 PNG, stretched by `object-cover`. */
const ATTACHMENT_PREVIEW =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export function App() {
  const [fixture, setFixture] = useState(FIXTURES[0]!.key)
  const [grid, setGrid] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [fontSize, setFontSize] = useState(13)
  const [lineHeight, setLineHeight] = useState(18)
  const [width, setWidth] = useState(0)
  const [report, setReport] = useState<GridReport | undefined>()
  const [prompt, setPrompt] = useState<(typeof PROMPTS)[number]['key']>('none')
  const [affordances, setAffordances] = useState(true)
  const [scrub, setScrub] = useState(true)
  const [answered, setAnswered] = useState<string>()
  const surface = useRef<HTMLDivElement>(null)

  // Attach replay, simulated. A real attach does not hand the transcript its
  // items in one render: the gateway replays the whole event log over the WS
  // and the reducer appends as it goes, so the content grows in bursts. That is
  // the one candidate for "opening a long session visibly scrolls" that a
  // fixture switch cannot reproduce, and the reason `__wdReplay` exists.
  // `undefined` = not replaying, show the fixture whole.
  const [replayTo, setReplayTo] = useState<number | undefined>(undefined)
  // The replay hold, as the panel would drive it from `useClaudeSession`'s
  // `replaying`: true from the first burst, false in the SAME commit as the
  // last one — which is exactly when the hook's derived boolean flips, the
  // render that applies the replay's final event.
  const [replayHold, setReplayHold] = useState(false)
  // The status matters and used to matter more: the retired `useSettled` latch
  // only allowed smooth scrolling on a *live* status, so a replay under `idle`
  // could never reproduce the travel. Overridable so it can.
  const [statusOverride, setStatusOverride] = useState<TranscriptState['status'] | undefined>()
  const whole = FIXTURES.find((f) => f.key === fixture)!.state
  const state = useMemo(() => {
    if (replayTo === undefined && !statusOverride) return whole
    return {
      ...whole,
      ...(statusOverride ? { status: statusOverride } : {}),
      ...(replayTo === undefined ? {} : { items: whole.items.slice(0, replayTo) }),
    }
  }, [whole, replayTo, statusOverride])
  // The huge fixture carries a catch-up splice, so the recap jump (the re-aim
  // loop) can be exercised across hundreds of unmeasured rows.
  const catchUp = fixture === 'huge' ? { from: 300 } : undefined
  const jumpRef = useRef<(() => void) | null>(null)
  const repinRef = useRef<(() => void) | null>(null)
  // Staged attachments, faked. The real hook needs a gateway to upload to, but
  // the strip's geometry is the composer's and belongs in the grid audit —
  // one of each state, so the overlays get drawn too.
  const [attachmentCount, setAttachmentCount] = useState(0)
  const stagedAttachments = useMemo(() => {
    const states = ['ready', 'uploading', 'failed', 'ready'] as const
    const items = Array.from({ length: attachmentCount }, (_, i) => ({
      key: `att-${i}`,
      name: `Screenshot ${i + 1}.png`,
      mediaType: i === 2 ? 'application/pdf' : 'image/png',
      bytes: 188_293,
      previewUrl: i === 2 ? undefined : ATTACHMENT_PREVIEW,
      status: states[i % states.length],
      id: `id-${i}`,
      error: states[i % states.length] === 'failed' ? 'too large (413)' : undefined,
    }))
    return {
      items,
      readyIds: items.filter((i) => i.status === 'ready').map((i) => i.id),
      uploading: items.some((i) => i.status === 'uploading'),
      hasFailure: items.some((i) => i.status === 'failed'),
      accept: 'image/*',
      disabled: false,
      add: () => setAttachmentCount((n) => n + 1),
      retry: () => {},
      remove: (key: string) =>
        setAttachmentCount((n) => Math.max(0, n - (key ? 1 : 0))),
      clear: () => setAttachmentCount(0),
      dismissError: () => {},
    }
  }, [attachmentCount])

  // Hooks for driving the audits headlessly (chrome devtools).
  // `__wdAudit` audits whatever rows are mounted; the driver scrolls and merges.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    // The boundary goes in explicitly: the recap row shifts every row index
    // after it, and it is unmounted exactly when you are auditing the rows that
    // shift (see `recapRowIndex`).
    w.__wdAudit = () =>
      surface.current ? auditHeights(state, surface.current, catchUp?.from) : undefined
    w.__wdJumpRecap = () => jumpRef.current?.()
    w.__wdRepin = () => repinRef.current?.()
    // Stage N fake attachments — the strip needs a gateway otherwise.
    w.__wdAttach = (n?: number) => setAttachmentCount(n ?? 4)
    // The scroll-performance sweep (`perf-audit.ts`) — run it on `perf`.
    w.__wdPerf = (step?: number) => {
      const scroller = surface.current?.querySelector<HTMLElement>(
        '[data-slot="conversation"] > div',
      )
      return scroller ? perfSweep(scroller, { step }) : undefined
    }
    w.__wdSetFixture = (key: string) => setFixture(key)
    // Replay the current fixture in bursts, sampling `scrollTop` every frame —
    // the check for "does opening a long session travel". A pinned transcript
    // should show exactly one scrollTop per burst and never an intermediate
    // value, because `Conversation` is `instant` on both `initial` and
    // `resize`. Resolves to the trace so a driver can assert on it.
    // `hold` = drive the replay under the panel's replay hold (the
    // `replaying` prop), released in the same commit as the final burst. The
    // trace then also carries per-frame visibility, so a driver can assert the
    // two things the hold promises: every burst lands hidden, and the first
    // VISIBLE frame is already at the final scroll position.
    w.__wdReplay = (
      batch = 25,
      everyMs = 30,
      status: TranscriptState['status'] = 'running',
      hold = false,
    ) => {
      const root = () => surface.current?.querySelector<HTMLElement>('[data-slot="conversation"]')
      const scroller = () =>
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"] > div') ??
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"]')
      const total = whole.items.length
      setStatusOverride(status)
      setReplayTo(0)
      setReplayHold(hold)
      return new Promise<{
        tops: number[]
        visibleTops: number[]
        hiddenFrames: number
        revealTop: number | undefined
        final: number
        bottomGap: number
      }>((resolve) => {
        const frames: Array<{ top: number; hidden: boolean }> = []
        let shown = 0
        let sampling = true
        const raf = () => {
          const el = scroller()
          const r = root()
          if (el && r)
            frames.push({
              top: Math.round(el.scrollTop),
              hidden: getComputedStyle(r).visibility === 'hidden',
            })
          if (sampling) requestAnimationFrame(raf)
        }
        requestAnimationFrame(raf)
        const timer = setInterval(() => {
          shown = Math.min(total, shown + batch)
          setReplayTo(shown)
          if (shown >= total) {
            clearInterval(timer)
            // Same synchronous block as the final `setReplayTo`, so React
            // commits the last rows and the reveal together — the hook's shape.
            setReplayHold(false)
            setTimeout(() => {
              sampling = false
              const el = scroller()
              setReplayTo(undefined)
              setStatusOverride(undefined)
              const firstHidden = frames.findIndex((f) => f.hidden)
              const afterHold = firstHidden === -1 ? [] : frames.slice(firstHidden)
              const visible = afterHold.filter((f) => !f.hidden)
              resolve({
                tops: [...new Set(frames.map((f) => f.top))],
                visibleTops: [...new Set(visible.map((f) => f.top))],
                hiddenFrames: afterHold.length - visible.length,
                revealTop: visible[0]?.top,
                final: el ? Math.round(el.scrollTop) : -1,
                bottomGap: el ? el.scrollHeight - el.clientHeight - Math.round(el.scrollTop) : -1,
              })
            }, 400)
          }
        }, everyMs)
      })
    }
    w.__wdSetWidth = (px: number) => setWidth(px)
    w.__wdSetMetrics = (fs: number, lh: number) => {
      setFontSize(fs)
      setLineHeight(lh)
    }
    // Debug probes for the spike.
    w.__wdMd = (md: string, width: number, line = lineHeight) => {
      const el = surface.current?.querySelector<HTMLElement>('[data-terminal]')
      return el ? markdownHeight(md, { width, ch: measureCh(el), line }) : undefined
    }
    w.__wdLines = (text: string, cols: number) => textLines(text, cols)
    // The item→row mapping's regression check: binary search vs a linear
    // reference, plus a containment assertion (the found row must actually
    // cover the item), across every fixture × every item index × several
    // recap-splice positions. This is the off-by-a-fold trap's test.
    w.__wdCheckMapping = () => {
      const buildRows = (items: typeof state.items, boundary?: number): TranscriptRow[] =>
        boundary === undefined
          ? terminalBlocks(items, 0, true)
          : [
              ...terminalBlocks(items.slice(0, boundary), 0, true),
              { key: 'recap' as const, line: 'check' },
              ...terminalBlocks(items.slice(boundary), boundary, true),
            ]
      const linear = (rows: TranscriptRow[], itemIndex: number): number => {
        let best = 0
        rows.forEach((row, index) => {
          if ('index' in row && row.index <= itemIndex) best = index
        })
        return best
      }
      let cases = 0
      const mismatches: unknown[] = []
      for (const f of FIXTURES) {
        const items = f.state.items
        if (items.length === 0) continue
        const boundaries = [undefined, 1, Math.floor(items.length / 2), items.length - 1]
        for (const boundary of boundaries) {
          const rows = buildRows(items, boundary)
          for (let i = 0; i < items.length; i++) {
            cases += 1
            const got = rowIndexForItem(rows, i)
            const want = linear(rows, i)
            const row = rows[got]!
            const covers =
              'shell' in row
                ? i >= row.index && i < row.index + row.shell.length
                : 'item' in row && row.index === i
            if (got !== want || !covers)
              mismatches.push({ fixture: f.key, boundary, i, got, want, covers })
          }
        }
      }
      return { cases, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) }
    }
  })

  return (
    <div
      data-theme={theme}
      className='flex h-screen bg-bg text-fg-1'
      style={{ colorScheme: theme }}>
      <aside className='flex w-56 shrink-0 flex-col gap-4 border-r border-border p-3 text-body-sm'>
        <div className='flex flex-col gap-1'>
          <span className='text-label text-fg-4'>FIXTURE</span>
          {FIXTURES.map((f) => (
            <button
              key={f.key}
              type='button'
              onClick={() => setFixture(f.key)}
              className={`rounded px-2 py-1 text-left ${
                fixture === f.key ? 'bg-surface-hover text-fg-1' : 'text-fg-3 hover:bg-surface'
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        <div className='flex flex-col gap-1'>
          <span className='text-label text-fg-4'>PROMPT</span>
          {PROMPTS.map((p) => (
            <button
              key={p.key}
              type='button'
              onClick={() => {
                setPrompt(p.key)
                setAnswered(undefined)
              }}
              className={`rounded px-2 py-1 text-left ${
                prompt === p.key ? 'bg-surface-hover text-fg-1' : 'text-fg-3 hover:bg-surface'
              }`}>
              {p.label}
            </button>
          ))}
          {answered ? <p className='text-label text-success'>{answered}</p> : null}
        </div>

        <label className='flex items-center gap-2 text-fg-3'>
          <input type='checkbox' checked={grid} onChange={(e) => setGrid(e.target.checked)} />
          cell grid
        </label>
        <label className='flex items-center gap-2 text-fg-3'>
          <input
            type='checkbox'
            checked={affordances}
            onChange={(e) => setAffordances(e.target.checked)}
          />
          affordances
        </label>
        <label className='flex items-center gap-2 text-fg-3'>
          <input type='checkbox' checked={scrub} onChange={(e) => setScrub(e.target.checked)} />
          scrubber
        </label>
        <label className='flex items-center gap-2 text-fg-3'>
          <input
            type='checkbox'
            checked={theme === 'light'}
            onChange={(e) => setTheme(e.target.checked ? 'light' : 'dark')}
          />
          light
        </label>

        <label className='flex flex-col gap-1 text-fg-3'>
          font-size {fontSize}px
          <input
            type='range'
            min={10}
            max={20}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
        </label>
        <label className='flex flex-col gap-1 text-fg-3'>
          line-height {lineHeight}px
          <input
            type='range'
            min={12}
            max={32}
            value={lineHeight}
            onChange={(e) => setLineHeight(Number(e.target.value))}
          />
        </label>
        <label className='flex flex-col gap-1 text-fg-3'>
          width {width === 0 ? 'full' : `${width}px`}
          <input
            type='range'
            min={0}
            max={1200}
            step={20}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
        <div className='mt-auto flex flex-col gap-1'>
          <button
            type='button'
            className='rounded border border-border px-2 py-1 text-fg-2 hover:bg-surface'
            onClick={() => {
              const element = surface.current?.querySelector<HTMLElement>('[data-terminal]')
              if (element) setReport(auditGrid(element))
            }}>
            audit grid
          </button>
          {report ? (
            <p
              className={`text-label ${report.violations.length ? 'text-danger' : 'text-success'}`}>
              {report.violations.length
                ? `${report.violations.length} off-grid of ${report.checked}: ${report.violations[0]!.kind} by ${report.violations[0]!.by}px — ${report.violations[0]!.text}`
                : `${report.checked} nodes on a ${report.line}px grid`}
            </p>
          ) : null}
        </div>
      </aside>

      <main className='flex min-w-0 flex-1 justify-center overflow-auto'>
        <div ref={surface} className='min-w-0 flex-1' style={width ? { maxWidth: width } : undefined}>
          {/* The real shell — virtualized, stick-to-bottom, recap — with the
              terminal theme as its variant. Proving the integration here is the
              point: the playground must exercise what an embedder gets. */}
          <Transcript
            stickyPrompt
            state={state}
            variant='terminal'
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}
            scrubber={scrub}
            scrubberMarks={fixture === 'huge' ? [30, 210, 480] : undefined}
            replaying={replayHold}
            catchUp={catchUp}
            jumpToRecapRef={jumpRef}
            repinRef={repinRef}
            className={cn('h-[70vh]', grid && 'term-grid-overlay')}
          />
          {/* The composer is the panel's foot and its own terminal surface, so
              it is mounted the way the panel mounts it — inside the variant
              provider, at the same metrics. The grid audit reaches it too. */}
          <TranscriptVariantProvider value='terminal'>
            <Composer
              attachments={stagedAttachments}
              onSend={(text) => {
                // The panel re-pins on send (`SessionPanel.handleSend`), so the
                // playground does too — otherwise the one integration this
                // harness exists to prove is the one it skips.
                repinRef.current?.()
                setAnswered(`sent: ${text}`)
              }}
              onInterrupt={() => setAnswered('interrupted')}
              busy={false}
              fontSize={fontSize}
              lineHeight={lineHeight}
              affordances={affordances}
            />
          </TranscriptVariantProvider>
          <TerminalSurface
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}
            bleed='1ch'
            className='term-transcript'>
            <TerminalStatusLine
              state={state}
              connection='live'
              onOpenStatus={() => setAnswered('open status')}
              onOpenContext={() => setAnswered('open context')}
              onOpenUsage={() => setAnswered('open usage')}
            />
          </TerminalSurface>
          {prompt === 'none' ? null : (
            <TerminalSurface
              fontSize={fontSize}
              lineHeight={lineHeight}
              affordances={affordances}
              bleed='1ch'
              className='term-transcript'>
              {prompt === 'ask' ? (
                <TerminalQuestionPrompt
                  request={QUESTIONS}
                  onAnswer={(_, input) => setAnswered(JSON.stringify(input.answers))}
                  onDismiss={() => setAnswered('dismissed')}
                />
              ) : (
                <TerminalPermissionPrompt
                  request={prompt === 'edit' ? EDIT_APPROVAL : BASH_APPROVAL}
                  onApprove={() => setAnswered('approved')}
                  onDeny={(_, message, interrupt) =>
                    setAnswered(`denied${interrupt ? ' + stop' : ''}${message ? `: ${message}` : ''}`)
                  }
                />
              )}
            </TerminalSurface>
          )}
        </div>
      </main>
    </div>
  )
}
