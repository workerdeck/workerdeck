import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  PROTOCOL_VERSION,
  mergeUsage,
  orderUsageWindows,
  usageInfos,
  type ModelOption,
  type PermissionMode,
  type RateLimitInfo,
  type SkillInfo,
} from '@workerdeck/protocol'
import {
  useAttachments,
  useClaudeSession,
  useDraft,
  useHostFileSearch,
  useProfileUsage,
  useToolCallHost,
  type ClientToolHandler,
  type ConnectionState,
  type ProducedFileRef,
  type TranscriptState,
  type UseToolCallHostOptions,
} from '@workerdeck/react'
import { ChartPie, FolderTree, Gauge, Info, MoreHorizontal, Plug, Sparkles, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.tsx'
import { Composer, skillPrompt, type ComposerHandle } from './Composer.tsx'
import { ContextDialog } from './ContextDialog.tsx'
import { HostFilesDialog } from './HostFilesDialog.tsx'
import { McpDialog } from './McpDialog.tsx'
import { SkillsDialog } from './SkillsDialog.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionModeSelect, permissionModeChoices, type PermissionModeChoice } from './PermissionModeSelect.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { SubagentStrip } from './SubagentStrip.tsx'
import { useSubagentFrame } from './use-subagent-frame.ts'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { TerminalPermissionPrompt } from '../terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../terminal/QuestionPrompt.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { BookmarkProvider, type BookmarkHandle, type TerminalAffordances } from '../terminal/affordances.tsx'

import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import { HeldSendsBar, useHeldSends } from './held-sends.tsx'
import { ToolResultFetchProvider } from './tool-result-fetch.tsx'
import { ToolTitleProvider } from './tool-titles.tsx'
import { ToolResultImageProvider, useToolResultImages } from './tool-result-image.tsx'
import {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptFont,
  type TranscriptVariant,
} from './transcript-variant.tsx'
import { UsageDialog } from './UsageDialog.tsx'

function PromptSurface({
  terminal,
  metrics,
  affordances,
  children,
}: {
  terminal: boolean
  metrics?: TerminalMetrics
  affordances?: TerminalAffordances | boolean
  children: ReactNode
}) {
  if (!terminal) {
    return <div className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] flex-col gap-2">{children}</div>
  }
  return (
    <TerminalSurface
      fontSize={metrics?.fontSize}
      lineHeight={metrics?.lineHeight}
      affordances={affordances}
      bleed="1ch"
      className="term-transcript"
    >
      {children}
    </TerminalSurface>
  )
}

export type TerminalMetrics = { fontSize?: number; lineHeight?: number }

export interface SessionPanelProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  header?: ReactNode | ((slots: { actions: ReactNode }) => ReactNode)
  panelSurface?: 'internal' | 'external'
  statusSurface?: 'internal' | 'external'
  statusPlacement?: 'top' | 'bottom'
  onOpenPanel?: (panel: SessionSurfacePanel) => void
  onVitals?: (vitals: SessionVitals) => void
  transcriptVariant?: TranscriptVariant
  affordances?: TerminalAffordances | boolean
  terminalMetrics?: TerminalMetrics
  scrubber?: boolean
  // Bookmarked transcript item ids — the host owns membership and persistence.
  bookmarks?: readonly string[]
  onToggleBookmark?: (itemId: string) => void
  reveal?: { toolUseId: string; nonce: number }
  openSubagent?: { toolUseId: string; nonce: number }
  onSubagentChange?: (toolUseId: string | undefined) => void
  stickyPrompt?: boolean
  transcriptDensity?: TranscriptDensity
  transcriptFont?: TranscriptFont
  // 'fold' sends a mid-turn message straight through, and the engine folds it into the running
  // turn (catch-up mode). 'hold' keeps it here until the turn ends.
  midTurnSend?: 'fold' | 'hold'
  controlsSurface?: 'internal' | 'external' | 'status'
  onControls?: (controls: SessionControls | undefined) => void
  focusComposerOnClick?: boolean
  unseen?: { itemCount: number; since?: number }
  readOnly?: boolean
  toolHost?: UseToolCallHostOptions | false
  cacheTranscript?: boolean
  emptyState?: ReactNode
  onLinkClick?: (href: string) => boolean | void
  clientTools?: Record<string, ClientToolHandler>
  fontSize?: number
  className?: string
}

export type SessionControls = {
  setModel: (model?: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  interrupt: () => void
  focusComposer: () => void
  insertComposerText: (text: string) => void
}

const INTERACTIVE = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'img',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
].join(',')

export type SessionSurfacePanel = 'info' | 'context' | 'usage' | 'mcp' | 'files' | 'skills'
type Panel = SessionSurfacePanel

export type SessionVitals = {
  status: TranscriptState['status']
  connection: ConnectionState
  engine: TranscriptState['engine']
  capabilities: TranscriptState['capabilities']
  model: string | undefined
  models: ModelOption[]
  permissionMode: TranscriptState['permissionMode']
  permissionModes: PermissionModeChoice[]
  skills: SkillInfo[] | undefined
  cwd: TranscriptState['cwd']
  contextUsage: TranscriptState['contextUsage']
  rateLimits: TranscriptState['rateLimits']
  // When the newest window in `rateLimits` was reported, as event time — not receive time. External chrome (the
  // VS Code status bar, iOS) cannot otherwise tell a live reading from one a days-old session just replayed.
  // Absent means unknown, which is not the same as fresh.
  rateLimitsUpdatedAt: number | undefined
  itemCount: number
  totalCostUsd: number
}

export function SessionPanel({
  client,
  sessionId,
  header,
  panelSurface = 'internal',
  statusSurface = 'internal',
  statusPlacement = 'top',
  onOpenPanel,
  onVitals,
  transcriptVariant = 'cards',
  transcriptDensity = 'comfortable',
  transcriptFont = 'sans',
  midTurnSend = 'fold',
  affordances,
  terminalMetrics,
  scrubber = false,
  bookmarks,
  onToggleBookmark,
  reveal,
  openSubagent,
  onSubagentChange,
  stickyPrompt = false,
  controlsSurface = 'internal',
  onControls,
  focusComposerOnClick = false,
  unseen,
  readOnly = false,
  toolHost,
  clientTools,
  cacheTranscript,
  emptyState,
  onLinkClick,
  fontSize,
  className,
}: SessionPanelProps) {
  const effectiveTermFontSize = terminalMetrics?.fontSize ?? fontSize
  const effectiveTermLineHeight = terminalMetrics?.lineHeight ?? (fontSize !== undefined ? Math.round(fontSize * (18 / 13)) : undefined)

  const external = panelSurface === 'external'
  const statusExternal = statusSurface === 'external'
  const controlsInStatus = controlsSurface === 'status' && !statusExternal
  const controlsExternal = controlsSurface === 'external' || controlsInStatus
  const [protocolError, setProtocolError] = useState<string | undefined>(undefined)
  const [panel, setPanel] = useState<Panel | undefined>()
  const {
    state,
    connection,
    replaying,
    protocolMismatch,
    models,
    effectiveModel,
    handle,
    send,
    approve,
    deny,
    interrupt,
    setModel,
    setPermissionMode,
    reconnectNow,
    loadFullResult,
  } = useClaudeSession(client, sessionId, { onProtocolError: setProtocolError, cacheTranscript })
  useEffect(() => setProtocolError(undefined), [sessionId])
  const {
    subagentId,
    enterSubagent,
    leaveSubagent,
    returnReveal,
    frameItems: subagentFrameItems,
    task: subagentTask,
    fallbackLabel: subagentFallbackLabel,
  } = useSubagentFrame({ sessionId, items: state.items, session: state.session, reveal, openSubagent, onSubagentChange })

  const [caughtUp, setCaughtUp] = useState(false)
  useEffect(() => {
    setCaughtUp(false)
  }, [sessionId])
  const [catchUpMark] = useState(unseen)
  const catchUp = caughtUp ? undefined : catchUpMark
  const newCount = catchUp ? Math.max(0, state.items.length - catchUp.itemCount) : 0

  const openPanel = useCallback(
    (target: SessionSurfacePanel) => {
      if (external) {
        onOpenPanel?.(target)
      } else {
        setPanel(target)
      }
    },
    [external, onOpenPanel],
  )
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reconnectNow])
  useToolCallHost(
    handle,
    toolHost === false
      ? { enabled: false }
      : clientTools
        ? { ...toolHost, clientTools: { ...toolHost?.clientTools, ...clientTools } }
        : toolHost,
  )
  const terminal = transcriptVariant === 'terminal'

  const capabilities = state.capabilities

  const { usage: profileUsage } = useProfileUsage(client, state.session?.profile, {
    enabled: capabilities.rateLimits,
  })
  const usage = useMemo(
    () => mergeUsage({ rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt }, profileUsage),
    [state.rateLimits, state.rateLimitsUpdatedAt, profileUsage],
  )
  const rateLimits: Record<string, RateLimitInfo> | undefined = useMemo(
    () => (Object.keys(usage).length > 0 ? usageInfos(usage) : undefined),
    [usage],
  )
  const usageUpdatedAt = useMemo(() => {
    const stamps = Object.values(usage).map((w) => w.updatedAt)
    return stamps.length > 0 ? Math.max(...stamps) : undefined
  }, [usage])

  const onVitalsRef = useRef(onVitals)
  onVitalsRef.current = onVitals
  const vitalsModel = effectiveModel ?? state.model
  const permissionModes = useMemo(
    () => permissionModeChoices(capabilities.permissionModes, state.session?.canBypassPermissions),
    [capabilities.permissionModes, state.session?.canBypassPermissions],
  )
  useEffect(() => {
    onVitalsRef.current?.({
      status: state.status,
      connection,
      engine: state.engine,
      capabilities: state.capabilities,
      model: vitalsModel,
      models,
      permissionMode: state.permissionMode,
      permissionModes,
      skills: state.skills,
      cwd: state.cwd,
      contextUsage: state.contextUsage,
      rateLimits,
      rateLimitsUpdatedAt: usageUpdatedAt,
      itemCount: state.items.length,
      totalCostUsd: state.totalCostUsd,
    })
  }, [
    state.status,
    connection,
    state.engine,
    state.capabilities,
    vitalsModel,
    models,
    state.permissionMode,
    permissionModes,
    state.skills,
    state.cwd,
    state.contextUsage,
    rateLimits,
    usageUpdatedAt,
    state.items.length,
    state.totalCostUsd,
  ])

  const onControlsRef = useRef(onControls)
  onControlsRef.current = onControls
  const setters = useRef({ setModel, setPermissionMode, interrupt })
  setters.current = { setModel, setPermissionMode, interrupt }
  const controls = useRef<SessionControls>({
    setModel: (model) => setters.current.setModel(model),
    setPermissionMode: (mode) => setters.current.setPermissionMode(mode),
    interrupt: () => setters.current.interrupt(),
    focusComposer: () => composerRef.current?.focus(),
    insertComposerText: (text) => composerRef.current?.insertText(text),
  })
  useEffect(() => {
    const handler = onControlsRef.current
    handler?.(controls.current)
    return () => handler?.(undefined)
  }, [sessionId])
  const bookmarkSet = useMemo(() => new Set(bookmarks ?? []), [bookmarks])
  const bookmarkHandle = useMemo<BookmarkHandle | undefined>(
    () => (onToggleBookmark ? { has: (id) => bookmarkSet.has(id), toggle: onToggleBookmark } : undefined),
    [bookmarkSet, onToggleBookmark],
  )

  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'
  const attachments = useAttachments(client, sessionId, {
    capabilities,
    engine: state.engine,
  })
  const hostFiles = useHostFileSearch(client, state.cwd)
  const draft = useDraft(client, sessionId)
  // Stable identity: an inline arrow here would bust the Composer's `triggers`
  // memo on every streaming re-render, and with it every prompt-area callback
  // keyed on the triggers.
  const searchComposerFiles = useCallback(
    (query: string, options: { signal: AbortSignal }) => hostFiles.search(query, { ...options, limit: 8 }),
    [hostFiles.search],
  )
  const windows = useMemo(() => orderUsageWindows(usage), [usage])
  const hostImage = useHostImage(client, sessionId, state.producedFiles)
  const resultImages = useToolResultImages(client, sessionId)
  const composerRef = useRef<ComposerHandle>(null)
  const jumpToRecap = useRef<(() => void) | null>(null)
  const repinTranscript = useRef<(() => void) | null>(null)

  const commands = useMemo(() => {
    if (!state.commands) {
      return undefined
    }
    if (state.commands.some((c) => c.name === 'model')) {
      return state.commands
    }
    return [{ name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' }, ...state.commands]
  }, [state.commands])

  const heldSends = useHeldSends({ hold: midTurnSend === 'hold', busy: busy && !ended, send })

  const handleSend = (text: string, attachmentIds: string[]) => {
    if (attachmentIds.length === 0) {
      const modelCommand = /^\/model\s+(\S+)$/.exec(text)
      if (modelCommand) {
        setModel(modelCommand[1])
        return
      }
      if (capabilities.mcpStatus && text.trim() === '/mcp') {
        openPanel('mcp')
        return
      }
    }
    setCaughtUp(true)
    repinTranscript.current?.()
    heldSends.submit(text, attachmentIds)
  }

  const actionsMenu = (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Session actions">
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <MenuContent>
        {capabilities.contextUsage ? (
          <MenuItem onClick={() => openPanel('context')}>
            <ChartPie className="size-3.5 text-fg-3" /> Context
          </MenuItem>
        ) : null}
        {capabilities.rateLimits ? (
          <MenuItem onClick={() => openPanel('usage')}>
            <Gauge className="size-3.5 text-fg-3" /> Usage
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => openPanel('info')}>
          <Info className="size-3.5 text-fg-3" /> Session info
        </MenuItem>
        {capabilities.mcpStatus ? (
          <MenuItem onClick={() => openPanel('mcp')}>
            <Plug className="size-3.5 text-fg-3" /> MCP servers
          </MenuItem>
        ) : null}
        {capabilities.skillsList ? (
          <MenuItem onClick={() => openPanel('skills')}>
            <Sparkles className="size-3.5 text-fg-3" /> Skills
          </MenuItem>
        ) : null}
        {hostFiles.available ? (
          <MenuItem onClick={() => openPanel('files')}>
            <FolderTree className="size-3.5 text-fg-3" /> Project files
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  )

  const menu = external ? null : actionsMenu
  const headerTakesActions = typeof header === 'function'

  const sessionControls = (
    <>
      {models.length ? (
        <ModelSelect
          models={models}
          model={effectiveModel}
          onModelChange={setModel}
          disabled={ended}
          className={controlsInStatus ? 'h-5' : undefined}
        />
      ) : null}
      {state.permissionMode ? (
        <PermissionModeSelect
          mode={state.permissionMode}
          onModeChange={setPermissionMode}
          modes={capabilities.permissionModes}
          canBypass={state.session?.canBypassPermissions}
          disabled={ended}
          className={controlsInStatus ? 'h-5' : undefined}
        />
      ) : null}
    </>
  )

  const statusBar = statusExternal ? null : (
    <StatusBar
      state={state}
      rateLimits={rateLimits}
      connection={connection}
      placement={statusPlacement}
      controls={controlsInStatus && !readOnly ? sessionControls : undefined}
      onOpenStatus={external && !onOpenPanel ? undefined : () => openPanel('info')}
      onOpenContext={external && !onOpenPanel ? undefined : () => openPanel('context')}
      onOpenUsage={external && !onOpenPanel ? undefined : () => openPanel('usage')}
      actions={headerTakesActions ? undefined : menu}
    />
  )

  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!onLinkClick) {
      return
    }
    const el = panelRef.current
    if (!el) {
      return
    }
    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) {
        return
      }
      const href = anchor.getAttribute('href')
      if (!href) {
        return
      }
      if (onLinkClick(href)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    el.addEventListener('click', handler, true)
    return () => el.removeEventListener('click', handler, true)
  }, [onLinkClick])

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!focusComposerOnClick || readOnly) {
      return
    }
    const target = event.target as HTMLElement | null
    if (target?.closest(INTERACTIVE)) {
      return
    }
    if (window.getSelection()?.isCollapsed === false) {
      return
    }
    composerRef.current?.focus()
  }

  return (
    <TranscriptVariantProvider value={transcriptVariant}>
      <TranscriptDensityProvider value={transcriptDensity}>
        <ToolResultFetchProvider value={loadFullResult}>
          <ToolTitleProvider value={state.toolTitles}>
            <ToolResultImageProvider value={resultImages}>
              <div
                ref={panelRef}
                data-slot="session-panel"
                data-agent-font={transcriptFont}
                onClick={handleClick}
                className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}
                style={fontSize !== undefined ? ({ '--wd-font-size': `${Math.round(fontSize)}px` } as React.CSSProperties) : undefined}
              >
                {headerTakesActions ? header({ actions: menu }) : header}
                {statusPlacement === 'top' ? statusBar : null}
                {protocolMismatch !== undefined ? (
                  <Notice level="warning">
                    Server speaks protocol v{protocolMismatch}, this build renders v{PROTOCOL_VERSION}. Some events may not render.
                  </Notice>
                ) : null}
                {protocolError ? (
                  <Notice level="error" onDismiss={() => setProtocolError(undefined)}>
                    {protocolError}
                  </Notice>
                ) : null}
                {subagentId !== undefined ? (
                  <SubagentStrip
                    task={subagentTask}
                    items={subagentFrameItems}
                    label={subagentFallbackLabel}
                    onBack={leaveSubagent}
                    terminal={terminal}
                    fontSize={effectiveTermFontSize}
                    lineHeight={effectiveTermLineHeight}
                  />
                ) : null}
                <BookmarkProvider value={bookmarkHandle}>
                  <Transcript
                    key={subagentId ?? 'session'}
                    state={state}
                    fileUrl={sessionId ? (path) => client.sessionFileUrl(sessionId, path) : undefined}
                    attachmentUrl={sessionId ? (id) => client.attachmentUrl(sessionId, id) : undefined}
                    canBrowseFiles={hostFiles.available}
                    hostImage={hostImage}
                    variant={transcriptVariant}
                    density={transcriptDensity}
                    fontSize={effectiveTermFontSize}
                    lineHeight={effectiveTermLineHeight}
                    affordances={affordances}
                    stickyPrompt={stickyPrompt}
                    scrubber={scrubber}
                    bookmarks={bookmarks}
                    replaying={replaying}
                    catchUp={catchUp && newCount > 0 ? { from: catchUp.itemCount, since: catchUp.since } : undefined}
                    reveal={returnReveal ?? reveal}
                    frame={subagentId === undefined ? undefined : { parentToolUseId: subagentId }}
                    onOpenSubagent={enterSubagent}
                    emptyState={emptyState}
                    jumpToRecapRef={jumpToRecap}
                    repinRef={repinTranscript}
                  />
                </BookmarkProvider>
                {catchUp && newCount > 0 && !replaying && subagentId === undefined ? (
                  <div className="px-3 pb-1">
                    <div
                      data-slot="catch-up"
                      className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] items-center gap-2 text-label text-fg-3"
                    >
                      <span aria-hidden className={cn('select-none', terminal ? 'text-fg-3' : 'text-accent')}>
                        ※
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {newCount} new {newCount === 1 ? 'row' : 'rows'}
                        {catchUp.since !== undefined ? ` since you were last here` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => jumpToRecap.current?.()}
                        className="shrink-0 underline-offset-2 hover:text-fg-1 hover:underline"
                      >
                        jump
                      </button>
                      <button
                        type="button"
                        onClick={() => setCaughtUp(true)}
                        className="shrink-0 underline-offset-2 hover:text-fg-1 hover:underline"
                      >
                        dismiss
                      </button>
                    </div>
                  </div>
                ) : null}
                {!readOnly && capabilities.interactiveApprovals && state.pendingApprovals.length > 0 ? (
                  <div className={cn(terminal ? 'pb-2' : 'px-3 pb-2')}>
                    <PromptSurface
                      terminal={terminal}
                      metrics={{ fontSize: effectiveTermFontSize, lineHeight: effectiveTermLineHeight }}
                      affordances={affordances}
                    >
                      {state.pendingApprovals.map((request) => {
                        const isQuestion = request.toolName === 'AskUserQuestion' && parseUserQuestions(request.input).length > 0
                        if (terminal) {
                          return isQuestion ? (
                            <TerminalQuestionPrompt
                              key={request.id}
                              request={request}
                              onAnswer={approve}
                              onDismiss={(id) => deny(id, 'Question dismissed by user')}
                            />
                          ) : (
                            <TerminalPermissionPrompt key={request.id} request={request} onApprove={approve} onDeny={deny} />
                          )
                        }
                        return isQuestion ? (
                          <QuestionPrompt
                            key={request.id}
                            request={request}
                            onAnswer={approve}
                            onDismiss={(id) => deny(id, 'Question dismissed by user')}
                          />
                        ) : (
                          <PermissionPrompt key={request.id} request={request} onApprove={approve} onDeny={deny} />
                        )
                      })}
                    </PromptSurface>
                  </div>
                ) : null}
                {readOnly || subagentId !== undefined ? null : (
                  <>
                    <HeldSendsBar held={heldSends.held} onSendNow={heldSends.flush} />
                    <Composer
                      ref={composerRef}
                      onSend={handleSend}
                      onInterrupt={interrupt}
                      busy={busy}
                      disabled={ended || !sessionId}
                      commands={capabilities.slashCommands ? commands : undefined}
                      skills={capabilities.skillsList ? state.skills : undefined}
                      attachments={attachments}
                      draft={draft}
                      onSearchFiles={hostFiles.available ? searchComposerFiles : undefined}
                      layout={controlsExternal ? 'inline' : 'stacked'}
                      toolbar={controlsExternal ? undefined : sessionControls}
                      fontSize={effectiveTermFontSize}
                      lineHeight={effectiveTermLineHeight}
                      affordances={affordances}
                    />
                  </>
                )}
                {statusPlacement === 'bottom' ? statusBar : null}

                {!external ? (
                  <>
                    <SessionInfoDialog
                      state={state}
                      client={client}
                      sessionId={sessionId}
                      open={panel === 'info'}
                      onOpenChange={(next) => setPanel(next ? 'info' : undefined)}
                    />
                    <ContextDialog
                      usage={state.contextUsage}
                      engine={state.engine ?? 'claude'}
                      open={panel === 'context'}
                      onOpenChange={(next) => setPanel(next ? 'context' : undefined)}
                    />
                    <UsageDialog
                      rateLimits={windows}
                      subscriptionType={state.subscriptionType}
                      engine={state.engine ?? 'claude'}
                      totalCostUsd={state.totalCostUsd}
                      updatedAt={usageUpdatedAt}
                      open={panel === 'usage'}
                      onOpenChange={(next) => setPanel(next ? 'usage' : undefined)}
                    />
                    <McpDialog
                      client={client}
                      sessionId={sessionId}
                      canManageServers={capabilities.mcpServerActions}
                      open={panel === 'mcp'}
                      onOpenChange={(next) => setPanel(next ? 'mcp' : undefined)}
                    />
                    <SkillsDialog
                      skills={state.skills}
                      open={panel === 'skills'}
                      onOpenChange={(next) => setPanel(next ? 'skills' : undefined)}
                      onUse={(skill) => composerRef.current?.insertText(skillPrompt(skill))}
                    />
                    <HostFilesDialog
                      client={client}
                      cwd={state.cwd}
                      open={panel === 'files'}
                      onOpenChange={(next) => setPanel(next ? 'files' : undefined)}
                    />
                  </>
                ) : null}
              </div>
            </ToolResultImageProvider>
          </ToolTitleProvider>
        </ToolResultFetchProvider>
      </TranscriptDensityProvider>
    </TranscriptVariantProvider>
  )
}

function useHostImage(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  producedFiles: Record<string, ProducedFileRef> | undefined,
): (path: string) => Promise<string | undefined> {
  const cache = useRef(new Map<string, Promise<string | undefined>>())
  const objectUrls = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of objectUrls.current) {
        URL.revokeObjectURL(url)
      }
      objectUrls.current = []
    },
    [],
  )
  return useCallback(
    (path: string) => {
      const produced = producedFiles?.[path]
      const key = produced ? `produced:${produced.fileId}` : `fs:${path}`
      const hit = cache.current.get(key)
      if (hit) {
        return hit
      }
      const pending =
        produced && sessionId
          ? client
              .readProducedFile(sessionId, produced.fileId)
              .then((blob) => {
                if (blob.size === 0) {
                  return undefined
                }
                const url = URL.createObjectURL(blob)
                objectUrls.current.push(url)
                return url
              })
              .catch(() => undefined)
          : client
              .readHostFile(path)
              .then((file) => {
                if (file.encoding !== 'base64') {
                  return undefined
                }
                const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
                const mediaType = IMAGE_MEDIA_TYPES[extension]
                return mediaType ? `data:${mediaType};base64,${file.content}` : undefined
              })
              .catch(() => undefined)
      cache.current.set(key, pending)
      return pending
    },
    [client, sessionId, producedFiles],
  )
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function Notice({ level, onDismiss, children }: { level: 'warning' | 'error'; onDismiss?: () => void; children: ReactNode }) {
  return (
    <div className="px-3 pt-2">
      <div
        role="alert"
        className={cn(
          'mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] items-start gap-2 rounded-md border px-3 py-2 text-body-sm',
          level === 'error' ? 'border-danger/40 bg-danger-bg text-danger' : 'border-warning/40 bg-warning-bg text-warning',
        )}
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{children}</span>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
