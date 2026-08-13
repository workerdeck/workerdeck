import { useRef, useState } from 'react'
import { TerminalPermissionPrompt } from '../src/components/terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../src/components/terminal/QuestionPrompt.tsx'
import { TerminalStatusLine } from '../src/components/terminal/StatusLine.tsx'
import { TerminalSurface } from '../src/components/terminal/surface.tsx'
import { Transcript } from '../src/components/agent/Transcript.tsx'
import { BASH_APPROVAL, EDIT_APPROVAL, FIXTURES, QUESTIONS } from './fixtures.ts'
import { auditGrid, type GridReport } from './grid-audit.ts'
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
  const [answered, setAnswered] = useState<string>()
  const surface = useRef<HTMLDivElement>(null)

  const state = FIXTURES.find((f) => f.key === fixture)!.state

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
            state={state}
            variant='terminal'
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}
            className={cn('h-[70vh]', grid && 'term-grid-overlay')}
          />
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
