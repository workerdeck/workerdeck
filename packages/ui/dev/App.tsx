import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
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

  // Attach replay, simulated: a real attach grows the transcript in bursts as the
  // reducer appends the replayed log, which a fixture switch cannot reproduce.
  // `undefined` = not replaying, show the fixture whole.
  const [replayTo, setReplayTo] = useState<number | undefined>(undefined)
  // The replay hold, as `useClaudeSession`'s `replaying` drives it: true from the
  // first burst, false in the SAME commit as the last one.
  const [replayHold, setReplayHold] = useState(false)
  // Overridable because scroll behaviour is status-dependent.
  const [statusOverride, setStatusOverride] = useState<TranscriptState['status'] | undefined>()
  // What a send appends: the re-pin is only interesting against a transcript that
  // grows under it. See `__wdPinTrace`.
  const [sent, setSent] = useState<TranscriptItem[]>([])
  const fixtureState = FIXTURES.find((f) => f.key === fixture)!.state
  const whole = useMemo(
    () => (sent.length === 0 ? fixtureState : { ...fixtureState, items: [...fixtureState.items, ...sent] }),
    [fixtureState, sent],
  )
  const state = useMemo(() => {
    if (replayTo === undefined && !statusOverride) {
      return whole
    }
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
  // A send as `SessionPanel.handleSend` shapes it: the typed row lands immediately,
  // the answer arrives later and keeps growing.
  const sendFixture = (text: string) => {
    const stamp = Date.now()
    setSent((prior) => [...prior, { id: `sent-${stamp}`, kind: 'user', text } as TranscriptItem])
    const reply = (n: number, body: string) =>
      setTimeout(
        () =>
          setSent((prior) => [
            ...prior,
            {
              id: `reply-${stamp}-${n}`,
              kind: 'assistant_text',
              text: body,
              streaming: false,
              parentToolUseId: null,
            } as TranscriptItem,
          ]),
        150 * n,
      )
    reply(1, 'Working on it.')
    reply(2, 'Reading the files that matter, then the two rules underneath them.')
    reply(3, 'Done — the change is in `packages/ui`, and the reason is in the header comment.')
  }
  // Staged attachments, faked (the real hook needs a gateway): one of each state, so
  // the strip's geometry lands in the grid audit.
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
      remove: (key: string) => setAttachmentCount((n) => Math.max(0, n - (key ? 1 : 0))),
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
    w.__wdAudit = () => (surface.current ? auditHeights(state, surface.current, catchUp?.from) : undefined)
    w.__wdJumpRecap = () => jumpRef.current?.()
    w.__wdRepin = () => repinRef.current?.()
    // Stage N fake attachments — the strip needs a gateway otherwise.
    w.__wdAttach = (n?: number) => setAttachmentCount(n ?? 4)
    // The scroll-performance sweep (`perf-audit.ts`) — run it on `perf`.
    w.__wdPerf = (step?: number) => {
      const scroller = surface.current?.querySelector<HTMLElement>('[data-slot="conversation"] > div')
      return scroller ? perfSweep(scroller, { step }) : undefined
    }
    // Does sending re-pin the transcript, and does the pin survive what sending sets
    // off — the composer shedding lines (a scroller resize `use-stick-to-bottom` reads
    // as the reader scrolling up), the typed row appending, the reply growing. Call it,
    // then send; it samples every frame for `ms`, and `final` is the gap to the bottom:
    // 0 is pinned, anything else is the reply streaming off screen.
    w.__wdPinTrace = (ms = 2000) => {
      const scroller = () =>
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"] > div') ??
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"]')
      return new Promise<{ gaps: number[]; final: number; heights: number[] }>((resolve) => {
        const gaps: number[] = []
        const heights: number[] = []
        const started = performance.now()
        const raf = () => {
          const el = scroller()
          if (el) {
            gaps.push(Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))
            heights.push(el.clientHeight)
          }
          if (performance.now() - started < ms) {
            requestAnimationFrame(raf)
          } else {
            resolve({ gaps, final: gaps[gaps.length - 1] ?? -1, heights })
          }
        }
        requestAnimationFrame(raf)
      })
    }
    // The reader's escape from the bottom — the precondition for everything above.
    w.__wdScrollUp = (px = 1200) => {
      const el =
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"] > div') ??
        surface.current?.querySelector<HTMLElement>('[data-slot="conversation"]')
      if (el) {
        el.scrollTop = Math.max(0, el.scrollTop - px)
      }
      return el ? Math.round(el.scrollTop) : -1
    }
    // A row that GROWS, not one that appends: only a changing last-row height fires
    // the virtualizer's size-change correction, the other writer of `scrollTop`.
    w.__wdStream = (deltas = 20, everyMs = 60) => {
      const id = `stream-${Date.now()}`
      let n = 0
      setSent((prior) => [
        ...prior,
        {
          id,
          kind: 'assistant_text',
          text: 'streaming',
          streaming: true,
          parentToolUseId: null,
        } as TranscriptItem,
      ])
      const timer = setInterval(() => {
        n += 1
        setSent((prior) =>
          prior.map((item) =>
            item.id === id
              ? ({
                  ...item,
                  text: `${(item as { text: string }).text} …and another clause of the answer, long enough to wrap the row and change its height (${n})`,
                } as TranscriptItem)
              : item,
          ),
        )
        if (n >= deltas) {
          clearInterval(timer)
        }
      }, everyMs)
      return id
    }
    w.__wdSetFixture = (key: string) => setFixture(key)
    // Replay in bursts, sampling `scrollTop` every frame: "does opening a long session
    // travel". A pinned transcript shows one scrollTop per burst and never an
    // intermediate value. `hold` drives it under the panel's replay hold, released in
    // the same commit as the final burst, so the trace also carries per-frame
    // visibility: every burst lands hidden, and the first VISIBLE frame is final.
    w.__wdReplay = (batch = 25, everyMs = 30, status: TranscriptState['status'] = 'running', hold = false) => {
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
          if (el && r) {
            frames.push({
              top: Math.round(el.scrollTop),
              hidden: getComputedStyle(r).visibility === 'hidden',
            })
          }
          if (sampling) {
            requestAnimationFrame(raf)
          }
        }
        requestAnimationFrame(raf)
        const timer = setInterval(() => {
          shown = Math.min(total, shown + batch)
          setReplayTo(shown)
          if (shown >= total) {
            clearInterval(timer)
            // Same synchronous block as the final `setReplayTo`, so React commits the
            // last rows and the reveal together.
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
    // The item→row mapping's regression check: binary search vs a linear reference,
    // plus containment (the found row must cover the item), across every fixture ×
    // item index × recap-splice position.
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
        // An absorbed child maps to its task's row wherever it fell in the
        // stream; everything else to the last row whose start is ≤ the target.
        let absorbed: number | undefined
        let best = 0
        rows.forEach((row, index) => {
          if ('task' in row && row.childIndices.includes(itemIndex)) {
            absorbed = index
          }
          if ('index' in row && row.index <= itemIndex) {
            best = index
          }
        })
        return absorbed ?? best
      }
      let cases = 0
      const mismatches: unknown[] = []
      for (const f of FIXTURES) {
        const items = f.state.items
        if (items.length === 0) {
          continue
        }
        const boundaries = [undefined, 1, Math.floor(items.length / 2), items.length - 1]
        for (const boundary of boundaries) {
          const rows = buildRows(items, boundary)
          for (let i = 0; i < items.length; i++) {
            cases += 1
            const got = rowIndexForItem(rows, i)
            const want = linear(rows, i)
            const row = rows[got]!
            // Identity membership, not index arithmetic: a run can fold across an
            // absorbed gap, so `[index, index + len)` no longer describes its coverage.
            const covers =
              'run' in row
                ? row.run.includes(items[i]! as (typeof row.run)[number])
                : 'task' in row
                  ? row.task === items[i] || row.childIndices.includes(i)
                  : 'item' in row && row.item === items[i]
            if (got !== want || !covers) {
              mismatches.push({ fixture: f.key, boundary, i, got, want, covers })
            }
          }
        }
      }
      return { cases, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) }
    }
  })

  return (
    <div data-theme={theme} className="flex h-screen bg-bg text-fg-1" style={{ colorScheme: theme }}>
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-border p-3 text-body-sm">
        <div className="flex flex-col gap-1">
          <span className="text-label text-fg-4">FIXTURE</span>
          {FIXTURES.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFixture(f.key)}
              className={`rounded px-2 py-1 text-left ${fixture === f.key ? 'bg-surface-hover text-fg-1' : 'text-fg-3 hover:bg-surface'}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-label text-fg-4">PROMPT</span>
          {PROMPTS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setPrompt(p.key)
                setAnswered(undefined)
              }}
              className={`rounded px-2 py-1 text-left ${prompt === p.key ? 'bg-surface-hover text-fg-1' : 'text-fg-3 hover:bg-surface'}`}
            >
              {p.label}
            </button>
          ))}
          {answered ? <p className="text-label text-success">{answered}</p> : null}
        </div>

        <label className="flex items-center gap-2 text-fg-3">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
          cell grid
        </label>
        <label className="flex items-center gap-2 text-fg-3">
          <input type="checkbox" checked={affordances} onChange={(e) => setAffordances(e.target.checked)} />
          affordances
        </label>
        <label className="flex items-center gap-2 text-fg-3">
          <input type="checkbox" checked={scrub} onChange={(e) => setScrub(e.target.checked)} />
          scrubber
        </label>
        <label className="flex items-center gap-2 text-fg-3">
          <input type="checkbox" checked={theme === 'light'} onChange={(e) => setTheme(e.target.checked ? 'light' : 'dark')} />
          light
        </label>

        <label className="flex flex-col gap-1 text-fg-3">
          font-size {fontSize}px
          <input type="range" min={10} max={20} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-fg-3">
          line-height {lineHeight}px
          <input type="range" min={12} max={32} value={lineHeight} onChange={(e) => setLineHeight(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-fg-3">
          width {width === 0 ? 'full' : `${width}px`}
          <input type="range" min={0} max={1200} step={20} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <div className="mt-auto flex flex-col gap-1">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-fg-2 hover:bg-surface"
            onClick={() => {
              const element = surface.current?.querySelector<HTMLElement>('[data-terminal]')
              if (element) {
                setReport(auditGrid(element))
              }
            }}
          >
            audit grid
          </button>
          {report ? (
            <p className={`text-label ${report.violations.length ? 'text-danger' : 'text-success'}`}>
              {report.violations.length
                ? `${report.violations.length} off-grid of ${report.checked}: ${report.violations[0]!.kind} by ${report.violations[0]!.by}px — ${report.violations[0]!.text}`
                : `${report.checked} nodes on a ${report.line}px grid`}
            </p>
          ) : null}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 justify-center overflow-auto">
        {/* Panel-shaped, exactly as `SessionPanel` mounts it: the composer is a
            *sibling* of the scroller, so every line it grows or sheds resizes the
            scroller — the other party writing `scrollTop`. */}
        <div ref={surface} className="flex h-[80vh] min-h-0 min-w-0 flex-1 flex-col" style={width ? { maxWidth: width } : undefined}>
          <Transcript
            stickyPrompt
            state={state}
            variant="terminal"
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}
            scrubber={scrub}
            scrubberMarks={fixture === 'huge' ? [30, 210, 480] : undefined}
            replaying={replayHold}
            catchUp={catchUp}
            jumpToRecapRef={jumpRef}
            repinRef={repinRef}
            className={cn('min-h-0 flex-1', grid && 'term-grid-overlay')}
          />
          {/* Mounted the way the panel mounts it — inside the variant provider, at the
              same metrics — so the grid audit reaches it too. */}
          <TranscriptVariantProvider value="terminal">
            <Composer
              attachments={stagedAttachments}
              onSend={(text) => {
                // The panel re-pins on send (`SessionPanel.handleSend`), so the
                // playground does too, and appends: a re-pin that survives the send but
                // not the reply is the bug this reproduces.
                repinRef.current?.()
                setAnswered(`sent: ${text}`)
                sendFixture(text)
              }}
              onInterrupt={() => setAnswered('interrupted')}
              busy={false}
              fontSize={fontSize}
              lineHeight={lineHeight}
              affordances={affordances}
            />
          </TranscriptVariantProvider>
          <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={affordances} bleed="1ch" className="term-transcript">
            <TerminalStatusLine
              state={state}
              connection="live"
              onOpenStatus={() => setAnswered('open status')}
              onOpenContext={() => setAnswered('open context')}
              onOpenUsage={() => setAnswered('open usage')}
            />
          </TerminalSurface>
          {prompt === 'none' ? null : (
            <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={affordances} bleed="1ch" className="term-transcript">
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
                  onDeny={(_, message, interrupt) => setAnswered(`denied${interrupt ? ' + stop' : ''}${message ? `: ${message}` : ''}`)}
                />
              )}
            </TerminalSurface>
          )}
        </div>
      </main>
    </div>
  )
}
