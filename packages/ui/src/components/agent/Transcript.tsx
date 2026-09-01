import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { recapLine, summarizeSince, type TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { Conversation, ConversationContent, ConversationScrollButton } from './Conversation.tsx'
import { Loader } from './Loader.tsx'
import { SessionEmptyState } from './SessionEmptyState.tsx'
import { type TerminalAffordances } from '../terminal/affordances.tsx'
import { WorkingRow } from '../terminal/items.tsx'
import { subagentItems, terminalBlocks, type ToolCallItem } from '../terminal/blocks.ts'
import { taskBrief, taskBusy } from '../terminal/tool-run.ts'
import { type TranscriptRow } from './transcript-rows.ts'
import { TranscriptRows } from './TranscriptRows.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { ROW_GAP, TranscriptVariantProvider, type TranscriptDensity, type TranscriptVariant } from './transcript-variant.tsx'

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
    return <>{children}</>
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
  density?: TranscriptDensity
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  stickyPrompt?: boolean
  scrubber?: boolean
  scrubberMarks?: readonly number[]
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

export function Transcript({
  state,
  fileUrl,
  attachmentUrl,
  canBrowseFiles,
  hostImage,
  variant = 'cards',
  density = 'comfortable',
  fontSize,
  lineHeight,
  affordances,
  stickyPrompt = false,
  scrubber,
  scrubberMarks,
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
  const items = useMemo(() => (frame ? subagentItems(state.items, frame.parentToolUseId) : state.items), [state.items, frame])
  const frameTask = useMemo(
    () =>
      frame ? state.items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === frame.parentToolUseId) : undefined,
    [state.items, frame],
  )
  const gap = ROW_GAP[variant][density]
  const runStartedAt = useRunStart(state.status)
  const boundary = !frame && catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  const recap = useMemo(() => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))), [state, boundary])
  const brief = useMemo(
    () => (frame && frameTask && !items.some((item) => item.kind === 'user') ? taskBrief(frameTask) : undefined),
    [frame, frameTask, items],
  )
  const rows = useMemo<TranscriptRow[]>(() => {
    const fold = (from: number, to: number) => terminalBlocks(items.slice(from, to), from, terminal)
    const lead: TranscriptRow[] = brief ? [{ key: 'brief' as const, text: brief }] : []
    if (boundary === undefined || !recap) {
      return [...lead, ...fold(0, items.length)]
    }
    return [...fold(0, boundary), { key: 'recap' as const, line: recap }, ...fold(boundary, items.length)]
  }, [items, boundary, recap, terminal, brief])
  return (
    <TranscriptVariantProvider value={variant}>
      <Conversation className={cn(replaying && 'invisible', className)}>
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
                replaying={replaying}
                stickyPrompt={!frame && stickyPrompt}
                gap={gap}
                fontSize={fontSize}
                lineHeight={lineHeight}
                items={items}
                pendingApprovals={state.pendingApprovals}
                scrubber={scrubber}
                scrubberMarks={frame ? undefined : scrubberMarks}
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
                <Loader
                  label={state.status === 'starting' ? 'Starting session…' : undefined}
                  startedAt={runStartedAt}
                  tokens={state.contextUsage?.totalTokens}
                />
              )
            ) : null}
          </TerminalShell>
        </ConversationContent>
        <ConversationScrollButton />
        {replaying ? (
          <div
            data-slot="transcript-hold"
            aria-hidden
            className="wd-hold-appear visible pointer-events-none absolute inset-0 overflow-hidden"
          >
            <div className={cn('mx-auto w-full max-w-[var(--wd-transcript-max-width)]', !terminal && 'px-4 py-4')}>
              {terminal ? (
                <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={false} bleed="1ch" className="term-transcript">
                  <WorkingRow label="Loading…" />
                </TerminalSurface>
              ) : (
                <Loader label="Loading session…" />
              )}
            </div>
          </div>
        ) : null}
      </Conversation>
    </TranscriptVariantProvider>
  )
}
