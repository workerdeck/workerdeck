import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { PROTOCOL_VERSION, type ModelOption, type PermissionMode } from '@workerdeck/protocol'
import {
  rateLimitWindows,
  useAttachments,
  useClaudeSession,
  useHostFileSearch,
  useToolCallHost,
  type ConnectionState,
  type ProducedFileRef,
  type TranscriptState,
} from '@workerdeck/react'
import {
  ChartPie,
  FolderTree,
  Gauge,
  Info,
  MoreHorizontal,
  Plug,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.tsx'
import { Composer, skillPrompt, type ComposerHandle } from './Composer.tsx'
import { ContextDialog } from './ContextDialog.tsx'
import { HostFilesDialog } from './HostFilesDialog.tsx'
import { McpDialog } from './McpDialog.tsx'
import { SkillsDialog } from './SkillsDialog.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import {
  PermissionModeSelect,
  permissionModeChoices,
  type PermissionModeChoice,
} from './PermissionModeSelect.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptVariant,
} from './transcript-variant.tsx'
import { UsageDialog } from './UsageDialog.tsx'

export interface SessionPanelProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  /**
   * Optional slot rendered at the top, above the status bar.
   *
   * Pass a **function** to take the session-actions (`⋯`) menu into your own
   * chrome: it is called with the menu element, and wherever you put it is
   * where it lives — the status bar then renders without it, so it never
   * appears twice. Pass a plain node (or nothing) and the menu stays in the
   * status bar's trailing slot.
   *
   * The seam exists because the menu can only be *built* here — it needs the
   * capability record, the host-file verdict and the panel's own dialog state —
   * but an embedder with a real header usually wants it up there with the rest
   * of the session's controls, not stranded on the status line.
   */
  header?: ReactNode | ((slots: { actions: ReactNode }) => ReactNode)
  /**
   * Where the info/context/usage/MCP/skills/files surfaces live. `'internal'`
   * (default) renders them as dialogs inside the panel. `'external'` renders
   * NO dialogs and no `⋯` menu: every affordance that would open one calls
   * {@link onOpenPanel} instead, so an embedder can host those surfaces in its
   * own chrome (a VS Code sidebar, a drawer) and keep the panel purely a
   * conversation surface.
   */
  panelSurface?: 'internal' | 'external'
  /**
   * Where the status bar lives. `'internal'` (default) draws it across the top
   * of the panel. `'external'` draws none — the readings still leave through
   * {@link onVitals}, so an embedder with a status line of its own (VS Code's
   * window status bar) renders them there instead of stacking a second bar
   * inside a panel that already sits in one.
   *
   * Deliberately independent of {@link panelSurface}: hosting the dialogs and
   * hosting the bar are separate decisions. One coupling to know about — the
   * `⋯` menu lives in the bar's trailing slot, so `statusSurface: 'external'`
   * with `panelSurface: 'internal'` must pass a **function** {@link header} to
   * take the menu, or it has nowhere left to go.
   */
  statusSurface?: 'internal' | 'external'
  /** Where `panelSurface: 'external'` routes opens. Absent = the affordances
   * (status-bar clicks, `/mcp`) become inert rather than half-working. */
  onOpenPanel?: (panel: SessionSurfacePanel) => void
  /** Live session vitals, fired whenever they change — for embedders mirroring
   * status/context/usage into chrome outside the panel (identity-stable via an
   * internal ref, so an inline closure is fine). */
  onVitals?: (vitals: SessionVitals) => void
  /**
   * How the transcript draws a turn — `'cards'` (default) or `'lines'`, the
   * space-efficient terminal treatment: no boxes, no bubbles, one full-width
   * hover-highlit row per event behind a gutter glyph. An embedder in a dock
   * (the VS Code panel) wants `'lines'`; a full-width dashboard usually doesn't.
   */
  transcriptVariant?: TranscriptVariant
  /**
   * How much air the transcript gives each row — `'comfortable'` (default: a
   * blank line between messages, as the Claude Code CLI leaves) or `'compact'`
   * (rows tight against one another). Independent of `transcriptVariant`: the
   * variant follows from the surface, density is the reader's preference, and a
   * dock is allowed to be roomy.
   */
  transcriptDensity?: TranscriptDensity
  /**
   * Where the session's own controls — model and permission mode — live.
   * `'internal'` (default) draws them in the composer's toolbar row.
   * `'external'` draws neither, and the composer collapses to a single line
   * with its attach/send buttons beside the field: the embedder renders the
   * pickers in its own chrome (VS Code's status bar, where a click opens a
   * QuickPick) and drives them through {@link onControls}.
   *
   * The options themselves ride {@link SessionVitals} — an embedder must not
   * attach a second time to learn what the models are.
   */
  controlsSurface?: 'internal' | 'external'
  /**
   * Handed the session's setters once the panel is live, and `undefined` on
   * unmount. The counterpart to `controlsSurface: 'external'`: vitals carry the
   * readings out, this carries the commands back in. Stable identity — safe to
   * stash in a ref.
   */
  onControls?: (controls: SessionControls | undefined) => void
  /**
   * Click anywhere the panel isn't already doing something and the caret lands
   * in the composer — the terminal/chat convention, and what a docked panel
   * wants: the field is why the panel is focussed at all.
   *
   * Only dead space. A click that hits a control (a tool row expanding, a link,
   * a button) or that ends a text selection is that action, not a request for
   * the input. Off by default: a full-page surface has plenty of dead space that
   * means nothing in particular.
   */
  focusComposerOnClick?: boolean
  /**
   * What this session looked like when it was last looked at: how many
   * transcript items had been seen, and when. Present and behind the current
   * transcript → **catch-up**: a recap row at the boundary, everything above it
   * dimmed, and a bar offering to jump there or to dismiss.
   *
   * The embedder owns the watermark because only it knows what "looked at"
   * means in its own chrome — a hidden dock is not being read. The panel reports
   * the number to remember through `SessionVitals.itemCount`.
   */
  unseen?: { itemCount: number; since?: number }
  className?: string
}

/** What an embedder needs to *change* a session it doesn't own the attach for. */
export type SessionControls = {
  setModel: (model?: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  interrupt: () => void
  /**
   * Put the caret in the composer.
   *
   * For an embedder whose own chrome is how you arrive at a session — clicking a
   * row in VS Code's sidebar — where revealing the panel and being able to type
   * are the same intention. The panel cannot infer it: from in here, a session
   * appearing looks identical whether someone asked for it or it was restored.
   */
  focusComposer: () => void
}

/** Everything a click can mean other than "put the caret in the composer".
 * Deliberately broad: mistaking a real target for dead space steals focus from
 * whatever the user just opened. */
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

/** The panels the session surface can raise. One at a time, by identity: a bag
 * of booleans would let two open at once. */
export type SessionSurfacePanel = 'info' | 'context' | 'usage' | 'mcp' | 'files' | 'skills'
type Panel = SessionSurfacePanel

/** What {@link SessionPanelProps.onVitals} reports: the live readings a host
 * chrome outside the panel would otherwise have to attach a second time for —
 * which the tool bridge forbids (it asks the first attached client). */
export type SessionVitals = {
  status: TranscriptState['status']
  /**
   * How the client is reaching the gateway. Load-bearing for a host rendering
   * these outside the panel: `status` is the last thing the session *said*, and
   * over a dropped socket that is a stale reading. The panel's own bar gives
   * the connection the status slot when it isn't `'live'` for exactly this
   * reason — an embedder showing `status` alone would present stale as current.
   */
  connection: ConnectionState
  engine: TranscriptState['engine']
  capabilities: TranscriptState['capabilities']
  model: string | undefined
  /** The models this session can switch to — the panel's own list, so an
   * external picker offers exactly what the internal one would. */
  models: ModelOption[]
  permissionMode: TranscriptState['permissionMode']
  /** The modes it can switch into, already filtered by the capability record
   * and the session's bypass grant (see `permissionModeChoices`). */
  permissionModes: PermissionModeChoice[]
  cwd: TranscriptState['cwd']
  contextUsage: TranscriptState['contextUsage']
  rateLimits: TranscriptState['rateLimits']
  /** How many transcript rows exist right now — the number an embedder stores
   * as its "seen" watermark while the panel is actually on screen, and compares
   * against later to know what is new. */
  itemCount: number
}

/**
 * The all-in-one embeddable session surface: status bar, streaming transcript,
 * permission prompts, composer. Attaches via useClaudeSession; remount (key) to switch
 * sessions.
 *
 * Every affordance is gated on the session's **capability record** rather than on
 * the engine name — an absent capability hides the control instead of offering
 * one that can only fail.
 */
export function SessionPanel({
  client,
  sessionId,
  header,
  panelSurface = 'internal',
  statusSurface = 'internal',
  onOpenPanel,
  onVitals,
  transcriptVariant = 'cards',
  transcriptDensity = 'comfortable',
  controlsSurface = 'internal',
  onControls,
  focusComposerOnClick = false,
  unseen,
  className,
}: SessionPanelProps) {
  const external = panelSurface === 'external'
  const statusExternal = statusSurface === 'external'
  const controlsExternal = controlsSurface === 'external'
  // Rejected commands (the CLI refusing a permission-mode switch, say) render INSIDE
  // the panel rather than through `toast`. The panel does not mount a `Toaster`, and
  // an embedder that doesn't either would drop the only signal that a command failed
  // — the select would just "not stick". An error channel a host can lose by omission
  // is not an error channel.
  const [protocolError, setProtocolError] = useState<string | undefined>(undefined)
  const [panel, setPanel] = useState<Panel | undefined>()
  const {
    state,
    connection,
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
  } = useClaudeSession(client, sessionId, { onProtocolError: setProtocolError })
  // Callers are told to remount on a session switch, but a changed prop must not leave
  // the previous session's failure on screen.
  useEffect(() => setProtocolError(undefined), [sessionId])

  // Catch-up is entered once, from the watermark the embedder handed over, and
  // left when dismissed or when the user sends anything (they are plainly
  // caught up at that point). Snapshotted into state rather than read from the
  // prop each render: the embedder keeps updating the watermark while the panel
  // is on screen, and a boundary that crept forward under the reader would
  // un-dim the very rows they came back to read.
  const [caughtUp, setCaughtUp] = useState(false)
  useEffect(() => {
    setCaughtUp(false)
  }, [sessionId])
  const [catchUpMark] = useState(unseen)
  const catchUp = caughtUp ? undefined : catchUpMark
  const newCount = catchUp ? Math.max(0, state.items.length - catchUp.itemCount) : 0

  // One router for every panel-opening affordance: internal surface opens the
  // dialog, external hands the intent to the embedder (or drops it, absent a
  // handler — inert beats half-working).
  const openPanel = useCallback(
    (target: SessionSurfacePanel) => {
      if (external) onOpenPanel?.(target)
      else setPanel(target)
    },
    [external, onOpenPanel],
  )
  // A tab that was in the background has been sitting out the reconnect backoff;
  // coming back to it is exactly when waiting the rest of it out is wrong.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reconnectNow])
  // Host server-bridged tool calls (provider-engine sessions) in this tab, on the
  // SAME handle the panel attached with — the bridge asks the first attached
  // client. Free for Claude sessions: the guest loads lazily on the first call,
  // which for them never comes.
  useToolCallHost(handle)
  const capabilities = state.capabilities

  // Vitals out to the embedder, keyed on the readings themselves so an inline
  // closure prop doesn't retrigger it every render.
  const onVitalsRef = useRef(onVitals)
  onVitalsRef.current = onVitals
  const vitalsModel = effectiveModel ?? state.model
  // The choices, not just the current values: an external picker has no second
  // attach to learn them from.
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
      cwd: state.cwd,
      contextUsage: state.contextUsage,
      rateLimits: state.rateLimits,
      itemCount: state.items.length,
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
    state.cwd,
    state.contextUsage,
    state.rateLimits,
    state.items.length,
  ])

  // The commands back in. One stable object reading through refs, so an
  // embedder can stash it and a re-render never invalidates what it holds.
  const onControlsRef = useRef(onControls)
  onControlsRef.current = onControls
  const setters = useRef({ setModel, setPermissionMode, interrupt })
  setters.current = { setModel, setPermissionMode, interrupt }
  const controls = useRef<SessionControls>({
    setModel: (model) => setters.current.setModel(model),
    setPermissionMode: (mode) => setters.current.setPermissionMode(mode),
    interrupt: () => setters.current.interrupt(),
    focusComposer: () => composerRef.current?.focus(),
  })
  useEffect(() => {
    const handler = onControlsRef.current
    handler?.(controls.current)
    return () => handler?.(undefined)
  }, [sessionId])
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'
  const attachments = useAttachments(client, sessionId, {
    capabilities,
    engine: state.engine,
  })
  // Rooted at the session's cwd, which arrives with the snapshot — so `@` is
  // inert for the moment before it does, and stays inert on a gateway that
  // serves no host files.
  const hostFiles = useHostFileSearch(client, state.cwd)
  const windows = useMemo(() => rateLimitWindows(state), [state])
  // Reads a picture the engine left on the host (codex's `image_gen` reports a
  // path, never bytes). Stable and memoized per path: transcript rows re-render
  // on every delta, and a fresh function would re-fetch each time.
  const hostImage = useHostImage(client, sessionId, state.producedFiles)
  const composerRef = useRef<ComposerHandle>(null)
  // The catch-up strip's way of scrolling the (virtualized, usually unmounted)
  // recap row into view — the transcript fills it in. See TranscriptProps.
  const jumpToRecap = useRef<(() => void) | null>(null)

  // "/model" is handled panel-side (see handleSend) — surface it in the autocomplete
  // even though the CLI's command list doesn't include it.
  const commands = useMemo(() => {
    if (!state.commands) return undefined
    if (state.commands.some((c) => c.name === 'model')) return state.commands
    return [
      { name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' },
      ...state.commands,
    ]
  }, [state.commands])

  // Two things are answered here rather than sent, because sending them would
  // spend a turn on a model reading the words back.
  const handleSend = (text: string, attachmentIds: string[]) => {
    if (attachmentIds.length === 0) {
      // "/model <id>" switches the model directly instead of going to the CLI.
      const modelCommand = /^\/model\s+(\S+)$/.exec(text)
      if (modelCommand) {
        setModel(modelCommand[1])
        return
      }
      // The CLI's own `/mcp` is an interactive picker, not a prompt. Only where
      // the capability exists: elsewhere it is ordinary message text, like any
      // other slash command on an engine without them.
      if (capabilities.mcpStatus && text.trim() === '/mcp') {
        openPanel('mcp')
        return
      }
    }
    // Typing into a session is the clearest possible statement that you have
    // read it — nothing left to catch up on.
    setCaughtUp(true)
    send(text, attachmentIds)
  }

  // Everything the panel can open, in one place — and each one is also
  // reachable by clicking the thing on the bar that summarises it. Entries the
  // capability record forswears are absent, not present-and-empty.
  //
  // Built once and placed once: either the embedder's header takes it (see the
  // `header` render-prop) or the status bar does. Never both — two `⋯` menus on
  // one screen is worse than either position.
  const actionsMenu = (
    <Menu>
      <MenuTrigger
        render={
          <Button variant='ghost' size='icon-sm' aria-label='Session actions'>
            <MoreHorizontal className='size-4' />
          </Button>
        }
      />
      <MenuContent>
        {capabilities.contextUsage ? (
          <MenuItem onClick={() => openPanel('context')}>
            <ChartPie className='size-3.5 text-fg-3' /> Context
          </MenuItem>
        ) : null}
        {capabilities.rateLimits ? (
          <MenuItem onClick={() => openPanel('usage')}>
            <Gauge className='size-3.5 text-fg-3' /> Usage
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => openPanel('info')}>
          <Info className='size-3.5 text-fg-3' /> Session info
        </MenuItem>
        {capabilities.mcpStatus ? (
          <MenuItem onClick={() => openPanel('mcp')}>
            <Plug className='size-3.5 text-fg-3' /> MCP servers
          </MenuItem>
        ) : null}
        {/* On the capability alone, like MCP's entry. Codex answers
            `skills/list` only over a live child, so before the first turn there
            is no list yet — but hiding the entry until then made the dialog's
            own explanation of that unreachable, which read as the feature being
            missing. The empty state says it instead. */}
        {capabilities.skillsList ? (
          <MenuItem onClick={() => openPanel('skills')}>
            <Sparkles className='size-3.5 text-fg-3' /> Skills
          </MenuItem>
        ) : null}
        {hostFiles.available ? (
          <MenuItem onClick={() => openPanel('files')}>
            <FolderTree className='size-3.5 text-fg-3' /> Project files
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  )

  // A function header claims the menu; anything else leaves it on the status bar.
  // The external surface has no menu to claim — those entries live in the
  // embedder's own chrome, reached through onOpenPanel.
  const menu = external ? null : actionsMenu
  const headerTakesActions = typeof header === 'function'

  // Dead-space clicks land in the composer. Anything the user actually aimed at
  // — a control, a link, the end of a drag-selection — keeps its own meaning;
  // this only claims what was left over.
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!focusComposerOnClick) return
    const target = event.target as HTMLElement | null
    if (target?.closest(INTERACTIVE)) return
    if (window.getSelection()?.isCollapsed === false) return
    composerRef.current?.focus()
  }

  return (
    // The variant is a panel-wide fact, not a transcript-only one: the approval
    // and question prompts live outside the scroller but are line items in the
    // same run, and they read `useLines()` like every other row.
    <TranscriptVariantProvider value={transcriptVariant}>
      <TranscriptDensityProvider value={transcriptDensity}>
      <div
        data-slot='session-panel'
        onClick={handleClick}
        className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}>
        {headerTakesActions ? header({ actions: menu }) : header}
        {statusExternal ? null : (
          <StatusBar
            state={state}
            connection={connection}
            onOpenStatus={external && !onOpenPanel ? undefined : () => openPanel('info')}
            onOpenContext={external && !onOpenPanel ? undefined : () => openPanel('context')}
            onOpenUsage={external && !onOpenPanel ? undefined : () => openPanel('usage')}
            actions={headerTakesActions ? undefined : menu}
          />
        )}
        {protocolMismatch !== undefined ? (
          <Notice level='warning'>
            Server speaks protocol v{protocolMismatch}, this build renders v{PROTOCOL_VERSION}. Some
            events may not render.
          </Notice>
        ) : null}
        {protocolError ? (
          <Notice level='error' onDismiss={() => setProtocolError(undefined)}>
            {protocolError}
          </Notice>
        ) : null}
        <Transcript
          state={state}
          fileUrl={sessionId ? (path) => client.sessionFileUrl(sessionId, path) : undefined}
          attachmentUrl={sessionId ? (id) => client.attachmentUrl(sessionId, id) : undefined}
          canBrowseFiles={hostFiles.available}
          hostImage={hostImage}
          variant={transcriptVariant}
          density={transcriptDensity}
          catchUp={
            catchUp && newCount > 0
              ? { from: catchUp.itemCount, since: catchUp.since }
              : undefined
          }
          jumpToRecapRef={jumpToRecap}
        />
        {/* The way back into what you missed. Above the composer because that is
            where the eye already is on returning, and because the transcript
            itself opens pinned to the newest row. */}
        {catchUp && newCount > 0 ? (
          <div className='px-3 pb-1'>
            <div
              data-slot='catch-up'
              className='mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] items-center gap-2 text-label text-fg-3'>
              <span aria-hidden className='select-none text-accent'>
                ※
              </span>
              <span className='min-w-0 flex-1 truncate'>
                {newCount} new {newCount === 1 ? 'row' : 'rows'}
                {catchUp.since !== undefined ? ` since you were last here` : ''}
              </span>
              <button
                type='button'
                onClick={() => jumpToRecap.current?.()}
                className='shrink-0 underline-offset-2 hover:text-fg-1 hover:underline'>
                jump
              </button>
              <button
                type='button'
                onClick={() => setCaughtUp(true)}
                className='shrink-0 underline-offset-2 hover:text-fg-1 hover:underline'>
                dismiss
              </button>
            </div>
          </div>
        ) : null}
        {/* An engine with no approval channel never raises these, but a stale
            pending request from a replayed log would still render — the record is
            the authority on whether an approval UI means anything here. */}
        {capabilities.interactiveApprovals && state.pendingApprovals.length > 0 ? (
          <div className='px-3 pb-2'>
            <div className='mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] flex-col gap-2'>
              {state.pendingApprovals.map((request) =>
                request.toolName === 'AskUserQuestion' &&
                parseUserQuestions(request.input).length > 0 ? (
                  <QuestionPrompt
                    key={request.id}
                    request={request}
                    onAnswer={approve}
                    onDismiss={(id) => deny(id, 'Question dismissed by user')}
                  />
                ) : (
                  <PermissionPrompt
                    key={request.id}
                    request={request}
                    onApprove={approve}
                    onDeny={deny}
                  />
                ),
              )}
            </div>
          </div>
        ) : null}
        <Composer
          ref={composerRef}
          onSend={handleSend}
          onInterrupt={interrupt}
          busy={busy}
          disabled={ended || !sessionId}
          commands={capabilities.slashCommands ? commands : undefined}
          skills={capabilities.skillsList ? state.skills : undefined}
          attachments={attachments}
          onSearchFiles={
            hostFiles.available
              ? (query, options) => hostFiles.search(query, { ...options, limit: 8 })
              : undefined
          }
          layout={controlsExternal ? 'inline' : 'stacked'}
          toolbar={
            controlsExternal ? undefined : (
            <>
              {/* Codex reports no `capabilities` event, so its models arrive from
                  the profile catalog instead — without that fallback its picker
                  would be permanently empty and the session unswitchable. */}
              {models.length ? (
                <ModelSelect
                  models={models}
                  model={effectiveModel}
                  onModelChange={setModel}
                  disabled={ended}
                />
              ) : null}
              {state.permissionMode ? (
                <PermissionModeSelect
                  mode={state.permissionMode}
                  onModeChange={setPermissionMode}
                  // Only what this engine implements — the rest would come back as
                  // a protocol_error.
                  modes={capabilities.permissionModes}
                  canBypass={state.session?.canBypassPermissions}
                  disabled={ended}
                />
              ) : null}
            </>
            )
          }
        />

        {/* The internal dialog surface. The external one renders none of these —
            the embedder hosts equivalent surfaces and is handed the intents. */}
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
            open={panel === 'context'}
            onOpenChange={(next) => setPanel(next ? 'context' : undefined)}
          />
          <UsageDialog
            rateLimits={windows}
            subscriptionType={state.subscriptionType}
            engine={state.engine ?? 'claude'}
            totalCostUsd={state.totalCostUsd}
            updatedAt={state.rateLimitsUpdatedAt}
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
            // Drafts into the composer; the operator sends it. There is no engine
            // call that runs a skill, so there is nothing else this button could do.
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
      </TranscriptDensityProvider>
    </TranscriptVariantProvider>
  )
}

/**
 * Turns a host path a tool card is holding into something an `<img>` can show.
 *
 * Two sources, tried in that order and for a reason:
 *
 * 1. **The session's produced files.** If this session's own runner announced
 *    writing that path (`file_produced`), the gateway will serve it from
 *    `/sessions/:id/produced/:fileId` — no host-file roots to declare, no byte
 *    cap to raise. This is the path codex's generated images take, and it is
 *    why they now render out of the box.
 * 2. **`/fs/read`.** For a path nothing produced — a picture the model looked
 *    at, an image already in the tree — where the operator's declared roots are
 *    the right gate and the answer is legitimately "no" outside them.
 *
 * The cache is what makes this usable from a transcript row: rows re-render on
 * every streamed delta, and an uncached resolver would re-fetch the picture each
 * time. A refusal is cached too, so it costs one request rather than one per
 * render.
 *
 * Keyed by `fileId`-or-path so that a path which becomes produced *after* a
 * failed `/fs/read` is retried under a different key rather than staying cached
 * as a miss.
 */
function useHostImage(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  producedFiles: Record<string, ProducedFileRef> | undefined,
): (path: string) => Promise<string | undefined> {
  const cache = useRef(new Map<string, Promise<string | undefined>>())
  // Object URLs pin their blob until revoked, so a long session that generated
  // a dozen images would hold a dozen megabytes past unmount.
  const objectUrls = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url)
      objectUrls.current = []
    },
    [],
  )
  return useCallback(
    (path: string) => {
      const produced = producedFiles?.[path]
      const key = produced ? `produced:${produced.fileId}` : `fs:${path}`
      const hit = cache.current.get(key)
      if (hit) return hit
      const pending =
        produced && sessionId
          ? // Fetched rather than pointed at: the panel may be talking to a
            // header-authenticated gateway, where a bare URL in an `<img src>`
            // carries no credential.
            client
              .readProducedFile(sessionId, produced.fileId)
              .then((blob) => {
                if (blob.size === 0) return undefined
                const url = URL.createObjectURL(blob)
                objectUrls.current.push(url)
                return url
              })
              .catch(() => undefined)
          : client
              .readHostFile(path)
              .then((file) => {
                if (file.encoding !== 'base64') return undefined
                // The route reports bytes and an encoding but not a media type;
                // the extension is what a browser needs to decode it.
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

/** Extensions worth rendering inline, and what to call them. Anything else is
 * left to the card's path text — guessing a media type is how an HTML file ends
 * up in an `<img>`. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** A dismissible advisory strip above the transcript. */
function Notice({
  level,
  onDismiss,
  children,
}: {
  level: 'warning' | 'error'
  onDismiss?: () => void
  children: ReactNode
}) {
  return (
    <div className='px-3 pt-2'>
      <div
        role='alert'
        className={cn(
          'mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] items-start gap-2 rounded-md border px-3 py-2 text-body-sm',
          level === 'error'
            ? 'border-danger/40 bg-danger-bg text-danger'
            : 'border-warning/40 bg-warning-bg text-warning',
        )}>
        <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
        <span className='min-w-0 flex-1 break-words'>{children}</span>
        {onDismiss ? (
          <button
            type='button'
            onClick={onDismiss}
            aria-label='Dismiss'
            className='shrink-0 opacity-70 transition-opacity hover:opacity-100'>
            <X className='size-3.5' />
          </button>
        ) : null}
      </div>
    </div>
  )
}
