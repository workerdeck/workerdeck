import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  PROTOCOL_VERSION,
  mergeUsage,
  orderUsageWindows,
  subagentLabel,
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
import { subagentItems, type ToolCallItem } from '../terminal/blocks.ts'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { TerminalPermissionPrompt } from '../terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../terminal/QuestionPrompt.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import type { TerminalAffordances } from '../terminal/affordances.tsx'

import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import { ToolResultFetchProvider } from './tool-result-fetch.tsx'
import { ToolResultImageProvider, useToolResultImages } from './tool-result-image.tsx'
import {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptFont,
  type TranscriptVariant,
} from './transcript-variant.tsx'
import { UsageDialog } from './UsageDialog.tsx'

/** The box the pending prompts sit in. Under the terminal theme they are rows
 * of the same run as the transcript, so they need that theme's cell and its
 * `--term-bleed`; every other variant keeps the centred content column. */
const PromptSurface = ({
  terminal,
  metrics,
  affordances,
  children,
}: {
  terminal: boolean
  metrics?: TerminalMetrics
  affordances?: TerminalAffordances | boolean
  children: ReactNode
}) => {
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

/**
 * The character cell the terminal theme draws on, in **whole pixels**. One
 * object rather than two props because the panel mounts three separate
 * `TerminalSurface`s — transcript, prompts, composer — and they must agree.
 * Absent means the CLI's own 13/18.
 */
export type TerminalMetrics = { fontSize?: number; lineHeight?: number }

export interface SessionPanelProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  /**
   * Optional slot rendered at the top, above the status bar.
   *
   * Pass a **function** to take the session-actions (`⋯`) menu into your own
   * chrome: it is called with the menu element and the status bar then renders
   * without it. The seam exists because the menu can only be *built* here — it
   * needs the capability record, the host-file verdict and the dialog state.
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
   * `2ch` rail of marks in three lanes, hover to peek, click to jump, drag to
   * scrub. Its premise is the theme's own computed row heights, so it is inert
   * under `cards`. `false` keeps the native scrollbar; so does
   * `affordances={false}`, which leaves the marks painted but inert.
   */
  scrubber?: boolean
  /**
   * Bookmarked **item indices**, painted full-width on the rail. Paint only —
   * the panel neither stores bookmarks nor offers a way to set one; who owns
   * that store is the embedder's question.
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
   * Open a **sub-agent takeover**: the panel body becomes that agent's own work,
   * with a way back. Bump `nonce` to ask again for the same one.
   *
   * A *request*, not a controlled value: the panel owns which agent is open and
   * *reports* through {@link SessionPanelProps.onSubagentChange}; only a
   * **change** of this prop is a request.
   *
   * **Withdrawing the request closes the frame** — the prop going away without a
   * remount means "the conversation, plainly", because a host keeping its
   * request in route state (`?subagent=`) has only that one way to say it.
   *
   * Hosts must clear their request on a session switch: a stale one replayed at
   * remount would open a frame the new transcript cannot answer.
   */
  openSubagent?: { toolUseId: string; nonce: number }
  /**
   * Which sub-agent the panel now has framed — a *statement* where
   * {@link SessionPanelProps.openSubagent} is a *request*, and not an echo: the
   * panel enters frames the host never asked for and leaves them on its own.
   *
   * **Never fired for a fresh mount's initial `undefined`, and never from an
   * unmount.** The first would clear the very `?subagent=` request the panel is
   * mid-way through honouring (the seeding effect consumes `openSubagent` in
   * the same commit); the second lets a panel keyed away on a session switch
   * stomp what the host believes about the next one.
   */
  onSubagentChange?: (toolUseId: string | undefined) => void
  /**
   * Hold the prompt of the turn you are reading at the top of the transcript.
   * Works in both variants: the terminal clips to one line (as the CLI does),
   * cards shows a frosted bar. The **real row** is pinned rather than a copy
   * drawn above it, so it lines up with the rows beneath by construction.
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
   * The panel's typeface — `'sans'` (default) or `'mono'`, which repoints the
   * sans token at the mono stack **for this subtree only**: a monospace agent
   * view next to an ordinary app, not a monospace app.
   */
  transcriptFont?: TranscriptFont
  /**
   * Where the session's own controls — model and permission mode — live.
   * `'internal'` (default) draws them in the composer's toolbar row; `'status'`
   * in the panel's own status bar beside the readings they act on; `'external'`
   * neither, leaving the embedder to render them and drive them through
   * {@link onControls}.
   *
   * `'status'` needs a status bar, so with `statusSurface: 'external'` it falls
   * back to the composer. The options themselves ride {@link SessionVitals} —
   * an embedder must not attach a second time to learn what the models are.
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
   * Click dead space and the caret lands in the composer. Only dead space — a
   * click that hits a control, or that ends a text selection, is that action.
   * Off by default: a full-page surface has plenty of meaningless dead space.
   */
  focusComposerOnClick?: boolean
  /**
   * What this session looked like when last looked at. Behind the current
   * transcript → **catch-up**: a recap row at the boundary, everything above it
   * dimmed, and a bar offering to jump or dismiss. The embedder owns the
   * watermark — only it knows what "looked at" means in its own chrome — and
   * the panel reports the number through `SessionVitals.itemCount`.
   */
  unseen?: { itemCount: number; since?: number }
  /**
   * A viewer, not a seat at the session: no composer and no approval prompts,
   * for a surface that is *about* a run rather than in it. Absent rather than
   * disabled — a greyed-out composer says the session is busy, an absent one
   * says this screen does not drive it.
   *
   * **Not an authorization boundary.** Anything holding this client can still
   * send; this removes the affordance, and the gateway does the enforcing.
   */
  readOnly?: boolean
  /**
   * Options for the browser tool host this panel runs on its own attach, or
   * `false` for none. The panel hosts server-bridged calls itself because the
   * bridge asks the *first attached client* and the panel owns the session's
   * one attach.
   *
   * Merged over the defaults, which host `eval_script` alone. **Widening
   * `tools` is a real grant** — this tab will execute what the gateway asks for
   * every name in the list — so names are explicit and there is no wildcard.
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
  /**
   * Replaces the default empty state when the transcript has no messages. Pass
   * your product's own onboarding content instead of WorkerDeck's generic
   * "`>_` Tell the agent what to do." placeholder.
   */
  emptyState?: ReactNode
  /**
   * Called when a link in the transcript is clicked. Return truthy to say the
   * click was handled and suppress the default `window.open(href, '_blank')`.
   * Absent means browser default; VS Code's webview overrides this through its
   * own native handler and does not need the prop.
   */
  onLinkClick?: (href: string) => boolean | void
  /**
   * Client-side tool handlers. Each key is a tool name the model can call; the
   * handler receives the model's input and returns a result. The tool's
   * **schema** must be registered server-side (via `tools` on
   * `ProviderRunnerOptions`), but the handler runs here — right where the data
   * the tool needs lives.
   *
   * Shorthand for `toolHost.clientTools`; when both are set, this wins for
   * overlapping names.
   *
   * ```tsx
   * <SessionPanel
   *   clientTools={{
   *     app_navigate: async (input) => {
   *       router.push((input as { path: string }).path)
   *       return { value: 'navigated' }
   *     },
   *   }}
   * />
   * ```
   */
  clientTools?: Record<string, import('@workerdeck/react').ClientToolHandler>
  /**
   * Base font size in **whole pixels**, scaling everything the panel draws in
   * both variants. Under the terminal theme it sets `--term-font-size` and
   * derives `--term-line` at the CLI's 13 : 18 ratio (unless
   * {@link terminalMetrics} overrides them); under cards it sets the panel
   * root's `font-size`. Absent means platform default.
   */
  fontSize?: number
  className?: string
}

/** What an embedder needs to *change* a session it doesn't own the attach for. */
export type SessionControls = {
  setModel: (model?: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  interrupt: () => void
  /** Put the caret in the composer. The panel cannot infer this: from in here a
   * session appearing looks identical whether someone asked for it or it was
   * restored. */
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
  /** How the client is reaching the gateway. Load-bearing outside the panel:
   * `status` is the last thing the session *said*, and over a dropped socket
   * that is a stale reading. */
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
  /** Session-cumulative cost in USD. The internal status bar renders this via
   * `formatCost`; an external host needs it to reproduce that reading. */
  totalCostUsd: number
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
  // ── Font size resolution ──────────────────────────────────────────────
  // `fontSize` is the panel-wide knob; `terminalMetrics` is the terminal-
  // specific override that predates it. The two compose: `fontSize` provides
  // the default the terminal derives from (13 : 18 ratio), and individual
  // terminalMetrics fields can still override each axis.
  const effectiveTermFontSize = terminalMetrics?.fontSize ?? fontSize
  const effectiveTermLineHeight = terminalMetrics?.lineHeight ?? (fontSize !== undefined ? Math.round(fontSize * (18 / 13)) : undefined)

  const external = panelSurface === 'external'
  const statusExternal = statusSurface === 'external'
  // Both non-internal surfaces take the pickers out of the composer, which is
  // what collapses it to a single line.
  const controlsInStatus = controlsSurface === 'status' && !statusExternal
  const controlsExternal = controlsSurface === 'external' || controlsInStatus
  // Rejected commands render INSIDE the panel rather than through `toast`: the
  // panel mounts no `Toaster`, and an embedder that doesn't either would lose
  // the only signal that a command failed.
  const [protocolError, setProtocolError] = useState<string | undefined>(undefined)
  const [panel, setPanel] = useState<Panel | undefined>()
  /**
   * The sub-agent takeover: which `Task` call the body is currently showing, or
   * undefined for the conversation.
   *
   * Deliberately **not** a `Panel` member. Those route outward under
   * `panelSurface: 'external'` so a host can draw them natively — and a host
   * cannot draw this one: it is a transcript, and the transcript is in here. It
   * is a mode of the conversation surface, not a screen over it.
   */
  const [subagentId, setSubagentId] = useState<string | undefined>(undefined)
  /**
   * Where to land on the way back — the row of the Task you entered from,
   * asked for through the ordinary reveal seam.
   *
   * The alternative was keeping the main transcript mounted-but-hidden to
   * preserve its scroll offset, which costs two live virtualizers and an
   * absolute-position layout on a panel whose height just changed (the composer
   * came back). Re-revealing is both cheaper and more honest: you return to the
   * row you left from rather than to wherever you happened to be scrolled.
   */
  const [returnReveal, setReturnReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
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
  // Belt to the remount contract, for the same reason: a takeover left standing
  // across a switch would frame one session's Task id against another's items.
  useEffect(() => {
    setSubagentId(undefined)
    setReturnReveal(undefined)
  }, [sessionId])

  // Every way out of the frame that carries no destination of its own — Back,
  // Escape, a withdrawn request — funnels through here, so they all land the
  // reader on the Task row they entered from. A reveal is the one exit that
  // doesn't: it brought its own destination.
  const leaveSubagent = useCallback(() => {
    setSubagentId((current) => {
      if (current !== undefined) {
        setReturnReveal({ toolUseId: current, nonce: Date.now() })
      }
      return undefined
    })
  }, [])

  // The host asking — or withdrawing the ask. Keyed on the nonce, so asking
  // twice works and a request arriving while another frame is open swaps it in
  // place. A withdrawn request CLOSES the frame (see the prop's docblock). Two
  // non-cases that look like hazards: a fresh mount with no request finds
  // nothing framed, and a host echoing the panel's own report re-arrives with
  // the nonce unchanged, so the echo is inert by construction.
  const openSubagentNonce = openSubagent?.nonce
  const openSubagentId = openSubagent?.toolUseId
  useEffect(() => {
    if (openSubagentId === undefined) {
      leaveSubagent()
    } else {
      setSubagentId(openSubagentId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSubagentNonce])

  // A *reveal* asked for while framed means the reader wants the conversation:
  // latest intent wins. Leaving the frame up and scrolling something invisible
  // underneath it would be the worst of both.
  const revealNonce = reveal?.nonce
  useEffect(() => {
    if (revealNonce === undefined) {
      return
    }
    setSubagentId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce])

  // Escape leaves the frame — the keyboard half of Back. `defaultPrevented`
  // keeps a dialog's own Escape (and the composer's) ahead of it: this is the
  // outermost thing Escape can mean here, so it goes last.
  useEffect(() => {
    if (subagentId === undefined) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      leaveSubagent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subagentId, leaveSubagent])

  // Fired off the STATE rather than from each exit path: the state is the only
  // place all the ways in and out meet.
  //
  // The ref pair is the mount guard and it is load-bearing. On a deep-linked
  // mount `subagentId` is `undefined` for the whole first commit (the seeding
  // effect's setState lands in the next one), so a naive dep array reports
  // `undefined` first and the host clears the `?subagent=` it asked with. The
  // ref starts at `undefined`, so the first commit is silent by construction,
  // wherever this sits relative to the seeding effect. No cleanup report on
  // unmount: a departing panel announcing "nothing framed" would stomp what
  // the host holds for the next session.
  const onSubagentChangeRef = useRef(onSubagentChange)
  onSubagentChangeRef.current = onSubagentChange
  const reportedSubagentId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (reportedSubagentId.current === subagentId) {
      return
    }
    reportedSubagentId.current = subagentId
    onSubagentChangeRef.current?.(subagentId)
  }, [subagentId])

  // Snapshotted into state rather than read from the prop each render: the
  // embedder keeps updating the watermark while the panel is on screen, and a
  // boundary creeping forward would un-dim the rows the reader came back for.
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
      if (external) {
        onOpenPanel?.(target)
      } else {
        setPanel(target)
      }
    },
    [external, onOpenPanel],
  )
  // A tab that was in the background has been sitting out the reconnect backoff;
  // coming back to it is exactly when waiting the rest of it out is wrong.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reconnectNow])
  // On the SAME handle the panel attached with — the bridge asks the first
  // attached client. Free for Claude sessions: the guest loads lazily on a
  // first call that never comes.
  useToolCallHost(
    handle,
    toolHost === false
      ? { enabled: false }
      : clientTools
        ? { ...toolHost, clientTools: { ...toolHost?.clientTools, ...clientTools } }
        : toolHost,
  )
  const terminal = transcriptVariant === 'terminal'

  // Both come from the transcript, the only complete source:
  // `SessionInfo.subagents` keeps eight settled records and is explicitly not a
  // session's Task history.
  const subagentFrameItems = useMemo(
    () => (subagentId === undefined ? [] : subagentItems(state.items, subagentId)),
    [state.items, subagentId],
  )
  const subagentTask = useMemo(
    () =>
      subagentId === undefined
        ? undefined
        : state.items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === subagentId),
    [state.items, subagentId],
  )
  // The one thing the rollup is allowed to do: name an agent whose `Task` call
  // the transcript does not have. A label is not content.
  const subagentFallbackLabel = useMemo(() => {
    const record = state.session?.subagents?.find((sub) => sub.toolUseId === subagentId)
    return record ? subagentLabel(record) : 'Sub-agent'
  }, [state.session, subagentId])
  const capabilities = state.capabilities

  // Plan usage as the *gateway* knows it, merged over this session's own
  // reading — **one** derivation feeding the bar, the terminal status line, the
  // Usage panel and the vitals, because four surfaces disagreeing about one
  // percentage is worse than any of them being stale. A session's own
  // `rate_limit` readings land only at a turn's edges; `mergeUsage` holds the
  // rule. Skipped for an engine that reports no windows.
  const { usage: profileUsage } = useProfileUsage(client, state.session?.profile, {
    enabled: capabilities.rateLimits,
  })
  const usage = useMemo(
    () => mergeUsage({ rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt }, profileUsage),
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

  // Keyed on the readings themselves, so an inline closure prop does not
  // retrigger this every render.
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
    state.cwd,
    state.contextUsage,
    rateLimits,
    state.items.length,
    state.totalCostUsd,
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
  // Rooted at the session's cwd, which arrives with the snapshot, so `@` is
  // inert until then and on a gateway that serves no host files.
  const hostFiles = useHostFileSearch(client, state.cwd)
  // Protocol's ordering, over the merged readings — each row keeping its own
  // date, since they no longer share one clock.
  const windows = useMemo(() => orderUsageWindows(usage), [usage])
  // Reads a picture the engine left on the host. Memoized per path: transcript
  // rows re-render on every delta, and a fresh function would re-fetch.
  const hostImage = useHostImage(client, sessionId, state.producedFiles)
  // The other picture route: an image *part* of a tool result, delivered as a
  // reference by an opted-in replay. Bounded, unlike `useHostImage`.
  const resultImages = useToolResultImages(client, sessionId)
  const composerRef = useRef<ComposerHandle>(null)
  // The catch-up strip's way of scrolling the (virtualized, usually unmounted)
  // recap row into view — the transcript fills it in. See TranscriptProps.
  const jumpToRecap = useRef<(() => void) | null>(null)
  // Filled by the transcript; pressed on send. See `handleSend`.
  const repinTranscript = useRef<(() => void) | null>(null)

  // "/model" is handled panel-side (see handleSend) — surface it in the autocomplete
  // even though the CLI's command list doesn't include it.
  const commands = useMemo(() => {
    if (!state.commands) {
      return undefined
    }
    if (state.commands.some((c) => c.name === 'model')) {
      return state.commands
    }
    return [{ name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' }, ...state.commands]
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
    // Typing into a session says you have read it.
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
        {/* On the capability alone, like MCP's entry. Codex answers
            `skills/list` only over a live child, so before the first turn there
            is no list yet — but hiding the entry until then made the dialog's
            own explanation of that unreachable, which read as the feature being
            missing. The empty state says it instead. */}
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

  // A function header claims the menu; anything else leaves it on the status bar.
  // The external surface has no menu to claim — those entries live in the
  // embedder's own chrome, reached through onOpenPanel.
  const menu = external ? null : actionsMenu
  const headerTakesActions = typeof header === 'function'

  // Built once and placed at one end or the other; two copies in the tree would
  // be two things to keep in step.
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

  // Capture phase, so it fires before any default handling. Only installed when
  // the prop is present — VS Code and the dashboard want the webview/browser
  // default.
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

  // Dead-space clicks land in the composer; anything the user actually aimed at
  // keeps its own meaning.
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
    // The variant is panel-wide: the composer and the pending prompts live
    // outside the scroller but belong to the same run.
    <TranscriptVariantProvider value={transcriptVariant}>
      <TranscriptDensityProvider value={transcriptDensity}>
        {/* The panel owns the session's one attach, so it is the only thing that
          can answer a row asking for the rest of a truncated tool result. Rows
          rendered anywhere else fall back to the context's no-op, which is
          correct for them: nothing truncates a replay they never asked for. */}
        <ToolResultFetchProvider value={loadFullResult}>
          <ToolResultImageProvider value={resultImages}>
            <div
              ref={panelRef}
              data-slot="session-panel"
              // The typeface is a cascade fact, not a React one — one attribute here,
              // and the `[data-agent-font]` rule in theme.css does the rest. Nothing
              // outside this subtree can pick it up.
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
              {/* The takeover's one line: who is on screen, and the way back. Above
            the transcript because it is a frame around it, not a row in it —
            and because Back must be reachable without scrolling a stream that
            is still growing. */}
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
              <Transcript
                /* A remount, so the frame opens pinned to its own bottom with a fresh
             virtualizer and height epoch — which is the right landing for both
             cases: the live tail of a running agent, and the final report of a
             settled one. */
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
                scrubberMarks={scrubberMarks}
                replaying={replaying}
                catchUp={catchUp && newCount > 0 ? { from: catchUp.itemCount, since: catchUp.since } : undefined}
                /* On the way back, land on the Task you came from — see `returnReveal`.
             The host's own reveal still wins when it is the newer intent. */
                reveal={returnReveal ?? reveal}
                frame={subagentId === undefined ? undefined : { parentToolUseId: subagentId }}
                onOpenSubagent={setSubagentId}
                emptyState={emptyState}
                jumpToRecapRef={jumpToRecap}
                repinRef={repinTranscript}
              />
              {/* The way back into what you missed. Above the composer because that is
            where the eye already is on returning, and because the transcript
            itself opens pinned to the newest row. Held with the transcript
            while the replay lands — its count is `state.items.length`, which
            during the replay is a number visibly climbing toward its answer. */}
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
              {/* An engine with no approval channel never raises these, but a stale
            pending request from a replayed log would still render — the record is
            the authority on whether an approval UI means anything here. */}
              {/* A read-only surface has no answer to give: the status bar still says
            `awaiting approval`, and the place that can act on it is wherever the
            session is actually driven. */}
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
              {/* No composer while a sub-agent is framed: you cannot talk to one, and a
            live-looking input that silently addresses its *parent* is worse than
            no input at all. Its interrupt goes with it — Back is one press away,
            and a second interrupt control would be a second thing that stops
            something the reader is not looking at.

            The approval prompts above deliberately do NOT go with it. A
            sub-agent's own tool calls raise session-level permission requests,
            so hiding them here would let the takeover deadlock the very agent it
            is showing until the reader happened to press Back. */}
              {readOnly || subagentId !== undefined ? null : (
                <Composer
                  ref={composerRef}
                  onSend={handleSend}
                  onInterrupt={interrupt}
                  busy={busy}
                  disabled={ended || !sessionId}
                  commands={capabilities.slashCommands ? commands : undefined}
                  skills={capabilities.skillsList ? state.skills : undefined}
                  attachments={attachments}
                  onSearchFiles={hostFiles.available ? (query, options) => hostFiles.search(query, { ...options, limit: 8 }) : undefined}
                  layout={controlsExternal ? 'inline' : 'stacked'}
                  toolbar={controlsExternal ? undefined : sessionControls}
                  fontSize={effectiveTermFontSize}
                  lineHeight={effectiveTermLineHeight}
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
          </ToolResultImageProvider>
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
const useHostImage = (
  client: WorkerDeckClient,
  sessionId: string | undefined,
  producedFiles: Record<string, ProducedFileRef> | undefined,
): ((path: string) => Promise<string | undefined>) => {
  const cache = useRef(new Map<string, Promise<string | undefined>>())
  // Object URLs pin their blob until revoked, so a long session that generated
  // a dozen images would hold a dozen megabytes past unmount.
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
          ? // Fetched rather than pointed at: the panel may be talking to a
            // header-authenticated gateway, where a bare URL in an `<img src>`
            // carries no credential.
            client
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
const Notice = ({ level, onDismiss, children }: { level: 'warning' | 'error'; onDismiss?: () => void; children: ReactNode }) => {
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
