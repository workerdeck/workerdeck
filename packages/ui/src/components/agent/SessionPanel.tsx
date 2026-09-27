import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  PROTOCOL_VERSION,
  mergeUsage,
  orderUsageWindows,
  sessionTasks,
  usageInfos,
  type ModelOption,
  type PermissionMode,
  type RateLimitInfo,
  type SessionTask,
  type ShellInfo,
  type SkillInfo,
  type SubagentInfo,
} from '@workerdeck/protocol'
import {
  useAttachments,
  useClaudeSession,
  useDraft,
  useHostFileSearch,
  usePeerSessions,
  useProfileUsage,
  useToolCallHost,
  type ClientToolHandler,
  type ConnectionState,
  type TranscriptState,
  type UseToolCallHostOptions,
} from '@workerdeck/react'
import { ChartPie, FolderTree, Gauge, Info, MoreHorizontal, Plug, Sparkles, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.tsx'
import { Composer, type ComposerHandle } from './Composer.tsx'
import {
  buildClientCommands,
  composerCommandRows,
  matchClientCommand,
  mergeComposerRows,
  skillPrompt,
  type ComposerCommandRow,
} from './composer-commands.ts'
import { ContextDialog } from './ContextDialog.tsx'
import { HostFilesDialog } from './HostFilesDialog.tsx'
import { McpDialog } from './McpDialog.tsx'
import { SkillsDialog } from './SkillsDialog.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionModeSelect, permissionModeChoices, type PermissionModeChoice } from './PermissionModeSelect.tsx'
import { SubagentStrip } from './SubagentStrip.tsx'
import { useSubagentFrame } from './use-subagent-frame.ts'
import { ShellStrip } from './ShellStrip.tsx'
import { ShellTerminal } from './ShellTerminal.tsx'
import { useShellFrame } from './use-shell-frame.ts'
import { BookmarkProvider, type BookmarkHandle, type TerminalAffordances } from '../terminal/affordances.tsx'
import type { FileLinkOpener } from '../terminal/file-link.tsx'
import { ApprovalPrompts, type ApprovalPromptProps } from './ApprovalPrompts.tsx'
import { SessionPanelProviders } from './session-panel-providers.tsx'
import { useCatchUp } from './use-catch-up.ts'
import { useHostImage } from './use-host-image.ts'
import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import { useToolResultImages } from './tool-result-image.tsx'
import { ImageViewerProvider } from './image-viewer.tsx'
import type { TranscriptFont, TranscriptVariant } from './transcript-variant.tsx'
import { UsageDialog } from './UsageDialog.tsx'

export type TerminalMetrics = { fontSize?: number; lineHeight?: number }

export type { ApprovalPromptProps }

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
  // Bookmarked transcript item ids - the host owns membership and persistence.
  bookmarks?: readonly string[]
  // `#` mentions of the other sessions on this gateway. On by default; an embedder whose people
  // should not learn that the other sessions exist turns it off.
  peerMentions?: boolean
  onToggleBookmark?: (itemId: string) => void
  // Where a file link in the transcript goes. Without it, such a link stays an ordinary anchor.
  onOpenFile?: FileLinkOpener
  reveal?: { toolUseId: string; nonce: number }
  openSubagent?: { toolUseId: string; nonce: number }
  onSubagentChange?: (toolUseId: string | undefined) => void
  // Host request to drill in to a shell's terminal; `shellId: undefined` withdraws it (Back/Forward).
  openShell?: { shellId: string; nonce: number }
  onShellChange?: (shellId: string | undefined) => void
  // The attach frame's `state.session` never refreshes, so a host that polls the sessions list passes the live records here.
  subagents?: SubagentInfo[]
  shells?: ShellInfo[]
  stickyPrompt?: boolean
  transcriptFont?: TranscriptFont
  controlsSurface?: 'internal' | 'external' | 'status'
  onControls?: (controls: SessionControls | undefined) => void
  focusComposerOnClick?: boolean
  unseen?: { itemCount: number; since?: number }
  readOnly?: boolean
  approvalPrompts?: Record<string, ComponentType<ApprovalPromptProps>>
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

export type SessionSurfacePanel = 'info' | 'context' | 'usage' | 'mcp' | 'files' | 'skills' | 'tasks'
type Panel = SessionSurfacePanel
type MenuPanel = Exclude<Panel, 'tasks'>

const PANEL_ITEMS: { panel: MenuPanel; label: string; Icon: LucideIcon }[] = [
  { panel: 'context', label: 'Context', Icon: ChartPie },
  { panel: 'usage', label: 'Usage', Icon: Gauge },
  { panel: 'info', label: 'Session info', Icon: Info },
  { panel: 'mcp', label: 'MCP servers', Icon: Plug },
  { panel: 'skills', label: 'Skills', Icon: Sparkles },
  { panel: 'files', label: 'Project files', Icon: FolderTree },
]

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
  // Everything `/` offers this session, flattened for a native host that cannot run the composer's own merge.
  composerCommands: ComposerCommandRow[]
  cwd: TranscriptState['cwd']
  contextUsage: TranscriptState['contextUsage']
  tasks: SessionTask[]
  rateLimits: TranscriptState['rateLimits']
  // When the newest window in `rateLimits` was reported, as event time - not receive time. External chrome (the
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
  transcriptFont = 'sans',
  affordances,
  terminalMetrics,
  scrubber = false,
  bookmarks,
  peerMentions = true,
  onToggleBookmark,
  reveal,
  subagents,
  shells,
  openSubagent,
  onSubagentChange,
  openShell,
  onShellChange,
  stickyPrompt = false,
  controlsSurface = 'internal',
  onControls,
  focusComposerOnClick = false,
  unseen,
  readOnly = false,
  approvalPrompts,
  toolHost,
  clientTools,
  cacheTranscript,
  emptyState,
  onLinkClick,
  onOpenFile,
  fontSize,
  className,
}: SessionPanelProps) {
  const cell = {
    fontSize: terminalMetrics?.fontSize ?? fontSize,
    lineHeight: terminalMetrics?.lineHeight ?? (fontSize !== undefined ? Math.round(fontSize * (18 / 13)) : undefined),
  }

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
    shell,
    pricing,
    models,
    effectiveModel,
    handle,
    send,
    runShell,
    approve,
    deny,
    interrupt,
    clearContext,
    setModel,
    setPermissionMode,
    reconnectNow,
    loadFullResult,
    loadShellOutput,
    verifyShell,
    killShell,
    setShellAgentWrite,
  } = useClaudeSession(client, sessionId, { onProtocolError: setProtocolError, cacheTranscript })
  const {
    shellId: framedShellId,
    enterShell,
    leaveShell,
    returnReveal: shellReturnReveal,
    shell: framedShell,
    label: framedShellLabel,
  } = useShellFrame({ sessionId, items: state.items, session: state.session, shells, reveal, openShell, onShellChange })
  const agentWrite = state.session?.shellAgentWrite !== undefined ? setShellAgentWrite : undefined
  const shellActions = useMemo(
    () => ({ loadOutput: loadShellOutput, verify: verifyShell, kill: killShell, open: enterShell, agentWrite }),
    [loadShellOutput, verifyShell, killShell, enterShell, agentWrite],
  )
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

  // Two frames, one reveal slot: the more recent exit wins, so leaving a shell never lands on the
  // row a sub-agent frame left behind.
  const frameReturnReveal = useMemo(() => {
    if (returnReveal && shellReturnReveal) {
      return returnReveal.nonce >= shellReturnReveal.nonce ? returnReveal : shellReturnReveal
    }
    return returnReveal ?? shellReturnReveal
  }, [returnReveal, shellReturnReveal])

  const { mark: catchUp, dismiss: dismissCatchUp } = useCatchUp(sessionId, unseen)
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

  const { usage: profileUsage, spend: profileSpend } = useProfileUsage(client, state.session?.profile, {
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

  const tasks = useMemo(
    () => sessionTasks({ checklist: state.checklist, subagents: subagents ?? state.session?.subagents }),
    [state.checklist, subagents, state.session?.subagents],
  )

  const hasModels = models.length > 0
  const clientCommands = useMemo(
    () => buildClientCommands({ capabilities, hasModels, setModel, setPermissionMode, clearContext, openPanel }),
    [capabilities, hasModels, openPanel, clearContext, setModel, setPermissionMode],
  )

  const composerCommands = useMemo(
    () =>
      composerCommandRows(
        mergeComposerRows({
          commands: capabilities.slashCommands ? state.commands : undefined,
          clientCommands,
          skills: capabilities.skillsList ? state.skills : undefined,
        }),
      ),
    [capabilities.slashCommands, capabilities.skillsList, state.commands, state.skills, clientCommands],
  )

  const onVitalsRef = useRef(onVitals)
  onVitalsRef.current = onVitals
  const vitalsModel = effectiveModel ?? state.model
  const permissionModes = useMemo(
    () => permissionModeChoices(capabilities.permissionModes, state.session?.canBypassPermissions),
    [capabilities.permissionModes, state.session?.canBypassPermissions],
  )
  const vitals: SessionVitals = {
    status: state.status,
    connection,
    engine: state.engine,
    capabilities: state.capabilities,
    model: vitalsModel,
    models,
    permissionMode: state.permissionMode,
    permissionModes,
    skills: state.skills,
    composerCommands,
    cwd: state.cwd,
    contextUsage: state.contextUsage,
    tasks,
    rateLimits,
    rateLimitsUpdatedAt: usageUpdatedAt,
    itemCount: state.items.length,
    totalCostUsd: state.totalCostUsd,
  }
  const lastVitals = useRef<SessionVitals | undefined>(undefined)
  // Every render, compared field by field: a streamed token changes none of them and never reaches the host.
  useEffect(() => {
    if (lastVitals.current && sameVitals(lastVitals.current, vitals)) {
      return
    }
    lastVitals.current = vitals
    onVitalsRef.current?.(vitals)
  })

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
  // Read here rather than taken as a prop, the way file search is: every embedding that has a
  // gateway has the sessions list, and a host that has to wire it would be a host that forgets to.
  const peers = usePeerSessions(client, sessionId, peerMentions)
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

  const handleSend = (text: string, attachmentIds: string[]) => {
    if (attachmentIds.length === 0) {
      const local = matchClientCommand(text, clientCommands)
      if (local && local.command.run(local.args)) {
        return
      }
    }
    dismissCatchUp()
    repinTranscript.current?.()
    send(text, attachmentIds)
  }

  const menuShows: Record<MenuPanel, boolean> = {
    context: capabilities.contextUsage,
    usage: capabilities.rateLimits,
    info: true,
    mcp: capabilities.mcpStatus,
    skills: capabilities.skillsList,
    files: hostFiles.available,
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
        {PANEL_ITEMS.filter((item) => menuShows[item.panel]).map(({ panel: target, label, Icon }) => (
          <MenuItem key={target} onClick={() => openPanel(target)}>
            <Icon className="size-3.5 text-fg-3" /> {label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )

  const menu = external ? null : actionsMenu
  const dialog = (target: Panel) => ({ open: panel === target, onOpenChange: (next: boolean) => setPanel(next ? target : undefined) })
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

  const fileLinks = useMemo(() => (onOpenFile ? { cwd: state.cwd, open: onOpenFile } : undefined), [onOpenFile, state.cwd])

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
    <SessionPanelProviders
      variant={transcriptVariant}
      fileLinks={fileLinks}
      loadFullResult={loadFullResult}
      shellActions={shellActions}
      toolTitles={state.toolTitles}
      resultImages={resultImages}
    >
      <div
        ref={panelRef}
        data-slot="session-panel"
        data-agent-font={transcriptFont}
        onClick={handleClick}
        className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}
        style={fontSize !== undefined ? ({ '--wd-font-size': `${Math.round(fontSize)}px` } as React.CSSProperties) : undefined}
      >
        <ImageViewerProvider>
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
          {framedShellId !== undefined ? (
            <ShellStrip
              shell={framedShell}
              label={framedShellLabel}
              onBack={leaveShell}
              onKill={() => void killShell(framedShellId)}
              onAgentWrite={agentWrite ? (enabled) => void agentWrite(framedShellId, enabled) : undefined}
              terminal={terminal}
              {...cell}
            />
          ) : null}
          {framedShellId === undefined && subagentId !== undefined ? (
            <SubagentStrip
              task={subagentTask}
              items={subagentFrameItems}
              label={subagentFallbackLabel}
              onBack={leaveSubagent}
              terminal={terminal}
              {...cell}
            />
          ) : null}
          {framedShellId !== undefined ? (
            <ShellTerminal key={framedShellId} handle={handle} shellId={framedShellId} fontSize={cell.fontSize} />
          ) : (
            <BookmarkProvider value={bookmarkHandle}>
              <Transcript
                key={subagentId ?? 'session'}
                state={state}
                fileUrl={sessionId ? (path) => client.sessionFileUrl(sessionId, path) : undefined}
                attachmentUrl={sessionId ? (id) => client.attachmentUrl(sessionId, id) : undefined}
                canBrowseFiles={hostFiles.available}
                sessionNames={peers.names}
                hostImage={hostImage}
                variant={transcriptVariant}
                {...cell}
                affordances={affordances}
                stickyPrompt={stickyPrompt}
                scrubber={scrubber}
                bookmarks={bookmarks}
                replaying={replaying}
                catchUp={catchUp && newCount > 0 ? { from: catchUp.itemCount, since: catchUp.since } : undefined}
                reveal={frameReturnReveal ?? reveal}
                frame={subagentId === undefined ? undefined : { parentToolUseId: subagentId }}
                onOpenSubagent={enterSubagent}
                emptyState={emptyState}
                jumpToRecapRef={jumpToRecap}
                repinRef={repinTranscript}
              />
            </BookmarkProvider>
          )}
          {catchUp && newCount > 0 && !replaying && subagentId === undefined && framedShellId === undefined ? (
            <CatchUpBanner
              count={newCount}
              since={catchUp.since}
              terminal={terminal}
              onJump={() => jumpToRecap.current?.()}
              onDismiss={dismissCatchUp}
            />
          ) : null}
          {!readOnly && capabilities.interactiveApprovals && state.pendingApprovals.length > 0 ? (
            <ApprovalPrompts
              requests={state.pendingApprovals}
              terminal={terminal}
              {...cell}
              affordances={affordances}
              hostPrompts={approvalPrompts}
              onApprove={approve}
              onDeny={deny}
            />
          ) : null}
          {readOnly || subagentId !== undefined || framedShellId !== undefined ? null : (
            <>
              <Composer
                ref={composerRef}
                onSend={handleSend}
                onInterrupt={interrupt}
                busy={busy}
                disabled={ended || !sessionId}
                commands={capabilities.slashCommands ? state.commands : undefined}
                skills={capabilities.skillsList ? state.skills : undefined}
                clientCommands={clientCommands}
                attachments={attachments}
                draft={draft}
                onSearchFiles={hostFiles.available ? searchComposerFiles : undefined}
                peers={peers.peers}
                onShellCommand={shell ? runShell : undefined}
                layout={controlsExternal ? 'inline' : 'stacked'}
                toolbar={controlsExternal ? undefined : sessionControls}
                {...cell}
                affordances={affordances}
              />
            </>
          )}
          {statusPlacement === 'bottom' ? statusBar : null}

          {!external ? (
            <>
              <SessionInfoDialog state={state} client={client} sessionId={sessionId} {...dialog('info')} />
              <ContextDialog usage={state.contextUsage} engine={state.engine ?? 'claude'} {...dialog('context')} />
              <UsageDialog
                rateLimits={windows}
                subscriptionType={state.subscriptionType}
                engine={state.engine ?? 'claude'}
                totalCostUsd={state.totalCostUsd}
                costUsd={state.costUsd}
                usageByModel={state.usageByModel}
                pricing={pricing}
                spend={profileSpend}
                updatedAt={usageUpdatedAt}
                {...dialog('usage')}
              />
              <McpDialog client={client} sessionId={sessionId} canManageServers={capabilities.mcpServerActions} {...dialog('mcp')} />
              <SkillsDialog
                skills={state.skills}
                {...dialog('skills')}
                onUse={(skill) => composerRef.current?.insertText(skillPrompt(skill))}
              />
              <HostFilesDialog client={client} cwd={state.cwd} {...dialog('files')} />
            </>
          ) : null}
        </ImageViewerProvider>
      </div>
    </SessionPanelProviders>
  )
}

type CatchUpBannerProps = { count: number; since: number | undefined; terminal: boolean; onJump: () => void; onDismiss: () => void }

function CatchUpBanner({ count, since, terminal, onJump, onDismiss }: CatchUpBannerProps) {
  return (
    <div className="px-3 pb-1">
      <div
        data-slot="catch-up"
        className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] items-center gap-2 text-label text-fg-3"
      >
        <span aria-hidden className={cn('select-none', terminal ? 'text-fg-3' : 'text-accent')}>
          ※
        </span>
        <span className="min-w-0 flex-1 truncate">
          {count} new {count === 1 ? 'row' : 'rows'}
          {since !== undefined ? ` since you were last here` : ''}
        </span>
        <button type="button" onClick={onJump} className="shrink-0 underline-offset-2 hover:text-fg-1 hover:underline">
          jump
        </button>
        <button type="button" onClick={onDismiss} className="shrink-0 underline-offset-2 hover:text-fg-1 hover:underline">
          dismiss
        </button>
      </div>
    </div>
  )
}

function sameVitals(a: SessionVitals, b: SessionVitals): boolean {
  return (Object.keys(b) as (keyof SessionVitals)[]).every((key) => Object.is(a[key], b[key]))
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
