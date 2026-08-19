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
import {
  PROTOCOL_VERSION,
  mergeUsage,
  orderUsageWindows,
  usageInfos,
  type ModelOption,
  type PermissionMode,
  type RateLimitInfo,
} from '@workerdeck/protocol'
import {
  useAttachments,
  useClaudeSession,
  useHostFileSearch,
  useProfileUsage,
  useToolCallHost,
  type ConnectionState,
  type ProducedFileRef,
  type TranscriptState,
  type UseToolCallHostOptions,
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
import { TerminalPermissionPrompt } from '../terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../terminal/QuestionPrompt.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import type { TerminalAffordances } from '../terminal/affordances.tsx'

import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import { ToolResultFetchProvider } from './tool-result-fetch.tsx'
import {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptFont,
  type TranscriptVariant,
} from './transcript-variant.tsx'
import { UsageDialog } from './UsageDialog.tsx'

/**
 * The box the pending prompts sit in.
 *
 * Under the terminal theme they are rows of the same run as the transcript, so
 * they need that theme's cell — and its `--term-bleed`, so an approval's diff
 * bands reach the same edges the transcript's do. Every other variant keeps the
 * centred content column the panel uses everywhere else.
 */
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
    return (
      <div className='mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] flex-col gap-2'>
        {children}
      </div>
    )
  }
  return (
    <TerminalSurface
      fontSize={metrics?.fontSize}
      lineHeight={metrics?.lineHeight}
      affordances={affordances}
      bleed='1ch'
      className='term-transcript'>
      {children}
    </TerminalSurface>
  )
}

/**
 * The character cell the terminal theme draws on, in **whole pixels**.
 *
 * One object rather than two props because the panel mounts three separate
 * `TerminalSurface`s — the transcript, the pending prompts, the composer — and
 * they must agree: a prompt drawn at a different line height from the rows above
 * it is three surfaces on three grids, which is the failure this theme is built
 * to make impossible. Passing one value through one prop is what keeps them from
 * drifting.
 *
 * Absent means the CLI's own 13/18. A host that follows an editor font size
 * (VS Code) hands that down instead.
 */
export type TerminalMetrics = { fontSize?: number; lineHeight?: number }

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
  /**
   * Which end of the panel the status bar sits at. Default `top`.
   *
   * `bottom` is the editor convention — VS Code's status bar runs along the
   * foot of the window — and suits a host where the panel *is* the editor area
   * and the chrome above it already belongs to the app. Placement only; the bar
   * is the same bar, with the same `⋯` menu in its trailing slot, so this
   * composes with {@link statusSurface} rather than competing with it (external
   * still means "there isn't one").
   */
  statusPlacement?: 'top' | 'bottom'
  /** Where `panelSurface: 'external'` routes opens. Absent = the affordances
   * (status-bar clicks, `/mcp`) become inert rather than half-working. */
  onOpenPanel?: (panel: SessionSurfacePanel) => void
  /** Live session vitals, fired whenever they change — for embedders mirroring
   * status/context/usage into chrome outside the panel (identity-stable via an
   * internal ref, so an inline closure is fine). */
  onVitals?: (vitals: SessionVitals) => void
  /**
   * How the transcript draws a turn — `'cards'` (default, the chat convention)
   * or `'terminal'`, the CLI's own form: every row on a character cell, no boxes
   * anywhere, diffs as full-width bands. An embedder in a dock (the VS Code
   * panel) wants `'terminal'`; a full-width dashboard may prefer cards.
   */
  transcriptVariant?: TranscriptVariant
  /**
   * Terminal theme only: the pointer affordances a real terminal cannot offer —
   * the hover fill, the hover-revealed copy. `false` for none. None of them
   * costs layout, so turning them off changes no glyph's position. See
   * {@link TerminalAffordances}.
   */
  affordances?: TerminalAffordances | boolean
  /**
   * Terminal theme only: the character cell, in whole pixels. See
   * {@link TerminalMetrics} — it reaches all three of the panel's terminal
   * surfaces, which is why it is one prop and not two per surface.
   */
  terminalMetrics?: TerminalMetrics
  /**
   * Terminal theme only: replace the scrollbar with the **overview ruler** — a
   * `2ch` rail of coloured marks in three lanes (what you typed, the answer and
   * its turn end, errors and a waiting approval), which you can hover to peek,
   * click to jump, and drag to scrub.
   *
   * Its premise is the terminal theme's own: one line height and one cell make
   * every row's height derivable, so a mark's position is *computed* rather than
   * guessed from rows that have not mounted. That is why it is not offered under
   * `cards` — there the flag is inert.
   *
   * `false` keeps the native scrollbar. So does `affordances={false}`, which
   * leaves the marks painted but inert rather than removing a reader's only way
   * to scroll.
   */
  scrubber?: boolean
  /**
   * Bookmarked **item indices**, painted full-width on the rail. Paint only —
   * the panel neither stores bookmarks nor offers a way to set one, because who
   * owns that store is the embedder's question (a private pin belongs with the
   * client's watermarks; a shared one is session metadata on the gateway).
   */
  scrubberMarks?: readonly number[]
  /**
   * Scroll a tool call into view; bump `nonce` to ask again for the same one.
   * See {@link TranscriptProps.reveal} — this is the panel's pass-through, and
   * exists so a surface *outside* the panel (a sessions list showing a session's
   * running sub-agents) can say "take me to that one" without opening a second
   * attach to find out where it is.
   */
  reveal?: { toolUseId: string; nonce: number }
  /**
   * Terminal theme only: hold the prompt of the turn you are reading at the top
   * of the transcript, as the Claude Code CLI does. The **real row** is pinned
   * rather than a copy drawn above it, so it lines up with the rows beneath by
   * construction — see `TranscriptRows`.
   */
  stickyPrompt?: boolean
  /**
   * How much air the transcript gives each row — `'comfortable'` (default: a
   * blank line between messages, as the Claude Code CLI leaves) or `'compact'`
   * (rows tight against one another). Independent of `transcriptVariant`: the
   * variant follows from the surface, density is the reader's preference, and a
   * dock is allowed to be roomy.
   */
  transcriptDensity?: TranscriptDensity
  /**
   * The panel's typeface — `'sans'` (default, the host's UI font) or `'mono'`,
   * which repoints the sans token at the mono stack **for this subtree only**.
   *
   * The third reader preference beside variant and density, and the same kind of
   * thing: how a transcript should read is a property of the person reading it.
   * Scoped to the panel because that is the whole claim — a monospace agent view
   * next to an ordinary app, not a monospace app.
   */
  transcriptFont?: TranscriptFont
  /**
   * Where the session's own controls — model and permission mode — live.
   * `'internal'` (default) draws them in the composer's toolbar row.
   * `'status'` draws them in the panel's OWN status bar, beside the readings
   * they act on; the composer collapses to a single line either way. That is
   * VS Code's arrangement without VS Code — a host whose panel carries a status
   * bar of its own (`statusPlacement: 'bottom'`) gets the same streamlined
   * shape without having to host the pickers itself.
   * `'external'` draws neither: the embedder renders the pickers in its own
   * chrome (VS Code's window status bar, where a click opens a QuickPick) and
   * drives them through {@link onControls}.
   *
   * `'status'` needs a status bar to put them in — with
   * `statusSurface: 'external'` there is none, and the two together would hide
   * the controls entirely, so that combination falls back to the composer.
   *
   * The options themselves ride {@link SessionVitals} — an embedder must not
   * attach a second time to learn what the models are.
   */
  controlsSurface?: 'internal' | 'external' | 'status'
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
  /**
   * A viewer, not a seat at the session: transcript, status bar and panels as
   * usual, but no composer and no approval prompts.
   *
   * For a surface that is *about* a run rather than in it — the dashboard's job
   * detail, where the session belongs to the queue and typing into it would be a
   * second operator arriving mid-run. Deliberately not "disabled controls": a
   * greyed-out composer says the session is busy, an absent one says this screen
   * does not drive it. The attach is still live and read paths are untouched,
   * so the transcript streams and the file tree browses.
   *
   * It does **not** claim to be an authorization boundary. Anything holding this
   * client can still send; what it removes is the affordance, and the honest
   * enforcement lives on the gateway.
   */
  readOnly?: boolean
  /**
   * Options for the browser tool host this panel runs on its own attach — or
   * `false` to run none at all.
   *
   * The panel hosts server-bridged tool calls itself, because the bridge asks
   * the *first attached client* and the panel owns the session's one attach: an
   * embedder subscribing to the same handle separately would find this host
   * already answering, and refusing, anything outside its allow-list. So the
   * options come through here.
   *
   * Merged over the defaults, which host `eval_script` alone. Widening `tools`
   * is a real grant — this tab will execute what the gateway asks it to for
   * every name in the list — so it names them explicitly rather than accepting
   * a wildcard.
   */
  toolHost?: UseToolCallHostOptions | false
  /**
   * Keep this session's transcript warm across remounts (default true), so
   * switching back to a recently viewed session paints instantly and replays
   * only what it missed — `UseClaudeSessionOptions.cacheTranscript`. Set
   * `false` for an embedder whose principal varies on one gateway URL by means
   * the client cannot see.
   */
  cacheTranscript?: boolean
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
  statusPlacement = 'top',
  onOpenPanel,
  onVitals,
  transcriptVariant = 'cards',
  transcriptDensity = 'comfortable',
  transcriptFont = 'sans',
  affordances,
  terminalMetrics,
  scrubber = false,
  scrubberMarks,
  reveal,
  stickyPrompt = false,
  controlsSurface = 'internal',
  onControls,
  focusComposerOnClick = false,
  unseen,
  readOnly = false,
  toolHost,
  cacheTranscript,
  className,
}: SessionPanelProps) {
  const external = panelSurface === 'external'
  const statusExternal = statusSurface === 'external'
  // Both non-internal surfaces take the pickers out of the composer, which is
  // what collapses it to a single line.
  const controlsInStatus = controlsSurface === 'status' && !statusExternal
  const controlsExternal = controlsSurface === 'external' || controlsInStatus
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
  useToolCallHost(handle, toolHost === false ? { enabled: false } : toolHost)
  const terminal = transcriptVariant === 'terminal'
  const capabilities = state.capabilities

  // Plan usage as the *gateway* knows it, merged over this session's own
  // reading — one derivation, feeding the bar, the terminal status line, the
  // Usage panel and the vitals an external chrome renders from, because four
  // surfaces disagreeing about the same percentage is worse than any of them
  // being stale. A session's own `rate_limit` readings land only at a turn's
  // edges, so an idle session's numbers age silently and a sibling session's
  // spend never shows up here at all; `mergeUsage` is where that rule is
  // written down. Skipped entirely for an engine that reports no windows.
  const { usage: profileUsage } = useProfileUsage(client, state.session?.profile, {
    enabled: capabilities.rateLimits,
  })
  const usage = useMemo(
    () =>
      mergeUsage(
        { rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt },
        profileUsage,
      ),
    [state.rateLimits, state.rateLimitsUpdatedAt, profileUsage],
  )
  // Undefined rather than an empty map when nothing has been reported: absent is
  // *unknown*, and a surface that can't tell the two apart draws 0%.
  const rateLimits: Record<string, RateLimitInfo> | undefined = useMemo(
    () => (Object.keys(usage).length > 0 ? usageInfos(usage) : undefined),
    [usage],
  )
  const usageUpdatedAt = useMemo(() => {
    const stamps = Object.values(usage).map((w) => w.updatedAt)
    return stamps.length > 0 ? Math.max(...stamps) : undefined
  }, [usage])

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
      rateLimits,
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
    rateLimits,
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
  // Protocol's ordering, over the merged readings — each row keeping its own
  // date, since they no longer share one clock.
  const windows = useMemo(() => orderUsageWindows(usage), [usage])
  // Reads a picture the engine left on the host (codex's `image_gen` reports a
  // path, never bytes). Stable and memoized per path: transcript rows re-render
  // on every delta, and a fresh function would re-fetch each time.
  const hostImage = useHostImage(client, sessionId, state.producedFiles)
  const composerRef = useRef<ComposerHandle>(null)
  // The catch-up strip's way of scrolling the (virtualized, usually unmounted)
  // recap row into view — the transcript fills it in. See TranscriptProps.
  const jumpToRecap = useRef<(() => void) | null>(null)
  // Filled by the transcript; pressed on send. See `handleSend`.
  const repinTranscript = useRef<(() => void) | null>(null)

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
    // ...and sending is the statement that you want to watch what happens next,
    // so following resumes here too. Scrolling up escapes the bottom lock, and
    // without this the reply streams in off screen: the transcript stays parked
    // where you were reading and sending looks like it did nothing. Ordered
    // before `send` only for readability — the re-pin is instant and the first
    // row is a round trip away either way.
    repinTranscript.current?.()
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

  // Built once and placed at one end or the other — the bar has a `⋯` menu and
  // three open handlers, and two copies of that in the tree would be two things
  // to keep in step.
  // Built once, placed by `controlsSurface`: the composer's toolbar row, or the
  // status bar beside the readings they act on, or nowhere at all when the host
  // draws them in its own chrome.
  const sessionControls = (
    <>
      {/* Codex reports no `capabilities` event, so its models arrive from the
          profile catalog instead — without that fallback its picker would be
          permanently empty and the session unswitchable. */}
      {models.length ? (
        <ModelSelect
          models={models}
          model={effectiveModel}
          onModelChange={setModel}
          disabled={ended}
          // The bar is one line of label-sized text; a 24px trigger would set
          // its height instead of fitting in it.
          className={controlsInStatus ? 'h-5' : undefined}
        />
      ) : null}
      {state.permissionMode ? (
        <PermissionModeSelect
          mode={state.permissionMode}
          onModeChange={setPermissionMode}
          // Only what this engine implements — the rest would come back as a
          // protocol_error.
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

  // Dead-space clicks land in the composer. Anything the user actually aimed at
  // — a control, a link, the end of a drag-selection — keeps its own meaning;
  // this only claims what was left over.
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!focusComposerOnClick || readOnly) return
    const target = event.target as HTMLElement | null
    if (target?.closest(INTERACTIVE)) return
    if (window.getSelection()?.isCollapsed === false) return
    composerRef.current?.focus()
  }

  return (
    // The variant is a panel-wide fact, not a transcript-only one: the composer
    // and the pending prompts live outside the scroller but belong to the same
    // run, and they read it from this context rather than a prop chain.
    <TranscriptVariantProvider value={transcriptVariant}>
      <TranscriptDensityProvider value={transcriptDensity}>
      {/* The panel owns the session's one attach, so it is the only thing that
          can answer a row asking for the rest of a truncated tool result. Rows
          rendered anywhere else fall back to the context's no-op, which is
          correct for them: nothing truncates a replay they never asked for. */}
      <ToolResultFetchProvider value={loadFullResult}>
      <div
        data-slot='session-panel'
        // The typeface is a cascade fact, not a React one — one attribute here,
        // and the `[data-agent-font]` rule in theme.css does the rest. Nothing
        // outside this subtree can pick it up.
        data-agent-font={transcriptFont}
        onClick={handleClick}
        className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}>
        {headerTakesActions ? header({ actions: menu }) : header}
        {statusPlacement === 'top' ? statusBar : null}
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
          fontSize={terminalMetrics?.fontSize}
          lineHeight={terminalMetrics?.lineHeight}
          affordances={affordances}
          stickyPrompt={stickyPrompt}
          scrubber={scrubber}
          scrubberMarks={scrubberMarks}
          replaying={replaying}
          catchUp={
            catchUp && newCount > 0
              ? { from: catchUp.itemCount, since: catchUp.since }
              : undefined
          }
          reveal={reveal}
          jumpToRecapRef={jumpToRecap}
          repinRef={repinTranscript}
        />
        {/* The way back into what you missed. Above the composer because that is
            where the eye already is on returning, and because the transcript
            itself opens pinned to the newest row. Held with the transcript
            while the replay lands — its count is `state.items.length`, which
            during the replay is a number visibly climbing toward its answer. */}
        {catchUp && newCount > 0 && !replaying ? (
          <div className='px-3 pb-1'>
            <div
              data-slot='catch-up'
              className='mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] items-center gap-2 text-label text-fg-3'>
              <span
                aria-hidden
                className={cn('select-none', terminal ? 'text-fg-3' : 'text-accent')}>
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
        {/* A read-only surface has no answer to give: the status bar still says
            `awaiting approval`, and the place that can act on it is wherever the
            session is actually driven. */}
        {!readOnly && capabilities.interactiveApprovals && state.pendingApprovals.length > 0 ? (
          <div className={cn(terminal ? 'pb-2' : 'px-3 pb-2')}>
            <PromptSurface terminal={terminal} metrics={terminalMetrics} affordances={affordances}>
              {state.pendingApprovals.map((request) => {
                const isQuestion =
                  request.toolName === 'AskUserQuestion' &&
                  parseUserQuestions(request.input).length > 0
                if (terminal) {
                  return isQuestion ? (
                    <TerminalQuestionPrompt
                      key={request.id}
                      request={request}
                      onAnswer={approve}
                      onDismiss={(id) => deny(id, 'Question dismissed by user')}
                    />
                  ) : (
                    <TerminalPermissionPrompt
                      key={request.id}
                      request={request}
                      onApprove={approve}
                      onDeny={deny}
                    />
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
                  <PermissionPrompt
                    key={request.id}
                    request={request}
                    onApprove={approve}
                    onDeny={deny}
                  />
                )
              })}
            </PromptSurface>
          </div>
        ) : null}
        {readOnly ? null : (
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
          toolbar={controlsExternal ? undefined : sessionControls}
          fontSize={terminalMetrics?.fontSize}
          lineHeight={terminalMetrics?.lineHeight}
          affordances={affordances}
        />
        )}
        {/* Below the composer, along the foot of the panel — the editor
            convention. Last in the flex column, so it is the bottom edge. */}
        {statusPlacement === 'bottom' ? statusBar : null}

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
      </ToolResultFetchProvider>
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
