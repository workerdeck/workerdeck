import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { recapLine, summarizeSince, type TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { Conversation, ConversationContent, ConversationScrollButton } from './Conversation.tsx'
import { Loader } from './Loader.tsx'
import { SessionEmptyState } from './SessionEmptyState.tsx'
import { AffordanceProvider, resolveAffordances, type TerminalAffordances } from '../terminal/affordances.tsx'
import { WorkingRow } from '../terminal/items.tsx'
import { isHiddenThinking, subagentItems, terminalBlocks, type ToolCallItem } from '../terminal/blocks.ts'
import { taskBrief, taskBusy } from '../terminal/tool-run.ts'
import { type TranscriptRow } from './transcript-rows.ts'
import { TranscriptRows } from './TranscriptRows.tsx'
import { SessionNamesProvider, SkillNamesProvider } from './PromptTokenText.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { ROW_GAP, TranscriptVariantProvider, type TranscriptVariant } from './transcript-variant.tsx'
import { HostImageProvider } from './tool-result-image.tsx'

function useRunStart(status: TranscriptState['status']): number | undefined {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

function showLoader(state: TranscriptState): boolean {
  if (state.status !== 'running' && state.status !== 'starting') {
    return false
  }
  const last = state.items.at(-1)
  if (!last) {
    return true
  }
  if (last.kind === 'assistant_text' && last.streaming) {
    return false
  }
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') {
    return false
  }
  return last.kind !== 'turn_result' || state.status === 'running'
}

function TerminalShell({
  active,
  fontSize,
  lineHeight,
  affordances,
  children,
}: {
  active: boolean
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  children: ReactNode
}) {
  if (!active) {
    return (
      <div data-cards="" className="contents">
        <AffordanceProvider value={resolveAffordances(affordances)}>{children}</AffordanceProvider>
      </div>
    )
  }
  return (
    <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={affordances} bleed="1ch" className="term-transcript">
      {children}
    </TerminalSurface>
  )
}

export { rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'

export interface TranscriptProps {
  state: TranscriptState
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  canBrowseFiles?: boolean
  hostImage?: (path: string) => Promise<string | undefined>
  variant?: TranscriptVariant
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  stickyPrompt?: boolean
  hideThinking?: boolean
  scrubber?: boolean
  bookmarks?: readonly string[]
  // Folded peer slugs, so a `#Name` this client can name draws as a token.
  sessionNames?: readonly string[]
  replaying?: boolean
  catchUp?: { from: number; since?: number }
  jumpToRecapRef?: RefObject<(() => void) | null>
  repinRef?: RefObject<(() => void) | null>
  reveal?: { toolUseId: string; nonce: number }
  frame?: { parentToolUseId: string }
  onOpenSubagent?: (toolUseId: string) => void
  emptyState?: ReactNode
  className?: string
}

const SETTLE_MAX_MS = 300

// After the replay lands the rows still trade estimated heights for measured ones; the panel stays covered until the content height holds for two frames.
function useSettledReveal(replaying: boolean): { hidden: boolean; holdRef: RefObject<HTMLDivElement | null> } {
  const holdRef = useRef<HTMLDivElement | null>(null)
  const [settling, setSettling] = useState(false)
  const was = useRef(replaying)
  useLayoutEffect(() => {
    if (was.current && !replaying) {
      setSettling(true)
    }
    was.current = replaying
  }, [replaying])
  useEffect(() => {
    if (!settling) {
      return
    }
    const content = holdRef.current?.parentElement?.querySelector<HTMLElement>('[data-slot="conversation-content"]')
    const deadline = performance.now() + SETTLE_MAX_MS
    let last = -1
    let steady = 0
    let frame = 0
    const check = () => {
      const height = content?.getBoundingClientRect().height ?? 0
      steady = height === last ? steady + 1 : 0
      last = height
      if (!content || steady >= 2 || performance.now() > deadline) {
        setSettling(false)
        return
      }
      frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [settling])
  return { hidden: replaying || settling, holdRef }
}

export function Transcript({
  state,
  fileUrl,
  attachmentUrl,
  canBrowseFiles,
  hostImage,
  variant = 'cards',
  fontSize,
  lineHeight,
  affordances,
  stickyPrompt = false,
  hideThinking = false,
  scrubber,
  bookmarks,
  sessionNames,
  replaying = false,
  catchUp,
  jumpToRecapRef,
  repinRef,
  reveal,
  frame,
  onOpenSubagent,
  emptyState,
  className,
}: TranscriptProps) {
  const terminal = variant === 'terminal'
  const { hidden, holdRef } = useSettledReveal(replaying)
  const items = useMemo(() => (frame ? subagentItems(state.items, frame.parentToolUseId) : state.items), [state.items, frame])
  const frameTask = useMemo(
    () =>
      frame ? state.items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === frame.parentToolUseId) : undefined,
    [state.items, frame],
  )
  const gap = ROW_GAP[variant]
  const runStartedAt = useRunStart(state.status)
  const boundary = !frame && catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  const recap = useMemo(() => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))), [state, boundary])
  const brief = useMemo(
    () => (frame && frameTask && !items.some((item) => item.kind === 'user') ? taskBrief(frameTask) : undefined),
    [frame, frameTask, items],
  )
  const rows = useMemo<TranscriptRow[]>(() => {
    const fold = (from: number, to: number) => terminalBlocks(items.slice(from, to), from, terminal, hideThinking ? isHiddenThinking : undefined)
    const lead: TranscriptRow[] = brief ? [{ key: 'brief' as const, text: brief }] : []
    if (boundary === undefined || !recap) {
      return [...lead, ...fold(0, items.length)]
    }
    return [...fold(0, boundary), { key: 'recap' as const, line: recap }, ...fold(boundary, items.length)]
  }, [items, boundary, recap, terminal, brief, hideThinking])
  const skillNames = useMemo(() => state.skills?.map((skill) => skill.name), [state.skills])
  return (
    <TranscriptVariantProvider value={variant}>
      <HostImageProvider value={hostImage}>
        <SkillNamesProvider names={skillNames}>
          <SessionNamesProvider names={sessionNames}>
            <Conversation className={cn(hidden && 'invisible', className)}>
              <ConversationContent className={cn(terminal && 'gap-0 p-0')}>
                <TerminalShell active={terminal} fontSize={fontSize} lineHeight={lineHeight} affordances={affordances}>
                  {frame ? (
                    frameTask === undefined && !replaying ? (
                      <div className={cn(terminal ? 'term-row text-fg-4' : 'p-4 text-body-sm text-fg-4')}>
                        This sub-agent's work is not in this transcript.
                      </div>
                    ) : null
                  ) : items.length === 0 && state.status !== 'starting' ? (
                    emptyState !== undefined ? (
                      emptyState
                    ) : (
                      <SessionEmptyState
                        cwd={state.cwd}
                        hasCommands={!!state.commands?.length}
                        hasSkills={!!state.skills?.some((s) => s.enabled)}
                        canBrowseFiles={canBrowseFiles}
                      />
                    )
                  ) : null}
                  {frame && frameTask === undefined && !replaying ? null : (
                    <TranscriptRows
                      rows={rows}
                      boundary={boundary}
                      since={catchUp?.since}
                      terminal={terminal}
                      replaying={hidden}
                      stickyPrompt={!frame && stickyPrompt}
                      gap={gap}
                      fontSize={fontSize}
                      lineHeight={lineHeight}
                      items={items}
                      pendingApprovals={state.pendingApprovals}
                      scrubber={scrubber}
                      bookmarks={frame ? undefined : bookmarks}
                      affordances={affordances}
                      fileUrl={fileUrl}
                      attachmentUrl={attachmentUrl}
                      hostImage={hostImage}
                      jumpToRecapRef={jumpToRecapRef}
                      repinRef={repinRef}
                      reveal={frame ? undefined : reveal}
                      frameParentId={frame?.parentToolUseId}
                      onOpenSubagent={frame ? undefined : onOpenSubagent}
                    />
                  )}
                  {(frame ? frameTask !== undefined && taskBusy(frameTask, items) : showLoader(state)) ? (
                    terminal ? (
                      <>
                        {state.items.length > 0 ? <div className="term-blank" aria-hidden /> : null}
                        <WorkingRow
                          label={state.status === 'starting' ? 'Starting…' : 'Working…'}
                          startedAt={runStartedAt}
                          tokens={state.contextUsage?.totalTokens}
                        />
                      </>
                    ) : (
                      <Loader label={state.status === 'starting' ? 'Starting session…' : undefined} />
                    )
                  ) : null}
                </TerminalShell>
              </ConversationContent>
              <ConversationScrollButton />
              {hidden ? (
                <div
                  ref={holdRef}
                  data-slot="transcript-hold"
                  aria-hidden
                  className="wd-hold-appear visible pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <div className={cn('mx-auto w-full max-w-[var(--wd-transcript-max-width)]', !terminal && 'px-4 py-4')}>
                    {terminal ? (
                      <TerminalSurface
                        fontSize={fontSize}
                        lineHeight={lineHeight}
                        affordances={false}
                        bleed="1ch"
                        className="term-transcript"
                      >
                        <WorkingRow label="Loading…" />
                      </TerminalSurface>
                    ) : (
                      <Loader label="Loading session…" />
                    )}
                  </div>
                </div>
              ) : null}
            </Conversation>
          </SessionNamesProvider>
        </SkillNamesProvider>
      </HostImageProvider>
    </TranscriptVariantProvider>
  )
}

export interface TerminalTranscriptProps {
  state: TranscriptState
  fileUrl?: (path: string) => string
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  className?: string
}

export function TerminalTranscript(props: TerminalTranscriptProps) {
  return <Transcript {...props} variant="terminal" />
}
