/**
 * @workerdeck/protocol — the wire protocol between a workerdeck server and its clients.
 *
 * One session = one ordered stream of {@link SessionEvent}s (each stamped with a monotonically
 * increasing `seq`) plus a small command set ({@link SessionCommand}). Clients attach over
 * WebSocket, optionally replaying from a known `seq`, and drive the session with commands.
 *
 * This package is dependency-free and browser-safe. Anthropic API message content is modeled
 * structurally (see {@link ApiMessage}) so clients don't need the Agent SDK to render transcripts.
 */

/** Bumped on any breaking change to events, commands, or REST shapes. */
export const PROTOCOL_VERSION = 7

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * - `starting` — runner spawned, waiting for the SDK init handshake
 * - `running` — a turn is in progress
 * - `awaiting_approval` — blocked on at least one pending permission request
 * - `idle` — between turns; accepting user messages
 * - `parked` — waiting on a deferred tool execution. The live runner has been torn
 *   down and the session's state persisted; delivering the execution's result
 *   (`POST {basePath}/executions/:executionId/result`) rehydrates it under the same
 *   id and the run continues. Not terminal.
 * - `failed` — the underlying query errored; terminal
 * - `closed` — closed by a client or the host; terminal
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'idle'
  | 'parked'
  | 'failed'
  | 'closed'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

// ---------------------------------------------------------------------------
// API message content (structural mirror of Anthropic message shapes)
// ---------------------------------------------------------------------------

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  is_error?: boolean
  /**
   * This block carries only the **head** of the result: the replay truncated it
   * (see {@link TOOL_RESULT_HEAD_CHARS}), and the whole thing is one fetch away
   * at `GET /sessions/:id/events/:seq/result?toolUseId=`.
   *
   * On the **block**, never the event, and that is the same argument
   * `user_message.patch` has to make in reverse: the patch sits on the event and
   * its doc must therefore caveat "only when the message carries exactly one
   * `tool_result` block — with two, nothing says which one it belongs to". A
   * message answering three calls truncates whichever of them is large, so
   * paying that caveat a second time would make the marker unusable exactly
   * when it matters. {@link FilePatch.truncated} is the shipped precedent.
   *
   * Only ever set on a **replay** a client asked for (`truncateResults`), so a
   * client that has never heard of this field cannot receive one — which is why
   * this is additive at protocol 7 rather than a bump. Absent means the block is
   * whole.
   */
  truncated?: boolean
  /** How many characters the untruncated result had. Set iff `truncated`.
   *
   * A client cannot compute it — it holds the head — and the number is not
   * cosmetic: a collapsed row spells "… +N chars", and `height.ts` sizes the row
   * by wrapping **that exact string**, so a count derived from the head would be
   * both a lie and a different pixel height. */
  total_chars?: number
}

/**
 * How much of a tool result a truncating replay keeps.
 *
 * Chosen against the two clients' *own* budgets, and the relationship is the
 * whole point: the terminal theme shows ~400 characters collapsed and ~2,000
 * open, so at 8,000 the collapsed and open states are **byte-identical to an
 * untruncated attach** and only the uncapped "show everything" press ever
 * fetches. That collapses the entire feature to one press, and it is asserted
 * in a test rather than trusted — lowered below the open budget, this would
 * silently clip the open state with no marker, which is the one failure this
 * design must not have.
 *
 * Measured justification: on one 1,270-row session three `tool_result` frames
 * were 641 / 463 / 396 KB, 68% of a 3.1 MB attach. The cut is *structural* —
 * proportional to the thing that is actually large, wherever in the log it sits
 * — which a row window is not.
 */
export const TOOL_RESULT_HEAD_CHARS = 8_000

/**
 * A base64 image part, delivered as an address instead of its bytes.
 *
 * The **seventh** rule of the family, and the first written *after* its
 * measurement rather than before it. Across 214 local sessions, 91% of all
 * tool-result payload is base64 image data — 489 MB against 44 MB of text — and
 * **no client renders a byte of it**: `blockText` in the reducer and
 * `joinedText` on iOS both fold a `tool_result` to its text parts, and both
 * clients draw a tool's picture from a host *path* (`savedPath` → `/produced`,
 * `/fs/read`), never from block content. So it is `replayRetains`' argument at
 * nine times the size of the case that rule was written for: bytes whose entire
 * effect on the reader is `return base`.
 *
 * A **new part type rather than a hollowed-out `image`**, and that is the one
 * judgement here worth stating. `headOf`'s shape-preservation rule — "a
 * truncation is a shorter result, never a different kind of one" — cuts the
 * other way for pixels: a head *is* a valid shorter text, but an image with no
 * bytes is not a smaller image, and spelling it `{ type: 'image', source }` with
 * no `data` invites precisely the failure shape-preservation exists to prevent,
 * a renderer that trusts `source.data` drawing `data:;base64,undefined`. An
 * unfamiliar type instead falls through every fold that already exists, exactly
 * as the CLI's own `tool_reference` part does: no `text`, so it contributes
 * nothing, and an unaware consumer renders what it renders today, which is
 * nothing. That is this family's safe failure.
 *
 * Only ever produced for a socket that asked (`imageRefs`), so a client that has
 * never heard of this type cannot receive one — which is why this is additive at
 * protocol 7, the same argument {@link ToolResultBlock.truncated} makes. Unlike
 * truncation it applies to **live events as well as replays**: the client's one
 * render path is ref-then-fetch, so bytes on a live event would either be
 * discarded (335 KB median, once per attached watcher) or need a second
 * decode-from-event path pinning megabytes inside the transcript cache — the
 * disease relocated rather than cured.
 */
export type ImageRefPart = {
  type: 'image_ref'
  /** The stored part's own media type (`image/png`, `image/jpeg` and
   * `image/webp` are the three observed), or `application/octet-stream` when it
   * had none. Never the membership test — that is `image` plus a base64 source. */
  media_type: string
  /** Decoded size, which a client cannot compute from an address it has not
   * fetched yet. Not cosmetic: the placeholder spells it, and in the terminal
   * theme a rendered string *is* a row height. */
  bytes: number
  /**
   * Index of this part in the **stored** block's content array, and the address
   * a fetch is made with.
   *
   * A stamped field rather than the position it arrives at, because that
   * position is not stable: `headOf` builds a truncated head by keeping text
   * parts up to budget and dropping every other part, so a block that is both
   * over the text budget and image-bearing has its parts renumbered the moment
   * the two rules compose. Stamped, the address survives any later reshaping —
   * and the route verifies it against the stored block rather than trusting it.
   */
  part_index: number
}

/** How many bytes a base64 payload decodes to, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/**
 * Project one `tool_result` content part onto its {@link ImageRefPart}, or
 * `undefined` when the part is not a base64 image and must be delivered as it
 * stands.
 *
 * The rule's **one spelling**, shared by the transform that replaces parts
 * (core), the route that serves them back (server) and the property test that
 * proves the fold is otherwise unchanged (react) — the same reason every other
 * member of this family lives here rather than in whichever package applies it.
 *
 * Deliberately narrow. The corpus holds exactly two non-text part kinds: this
 * one, and the CLI's `tool_reference`, of which every instance across 214
 * sessions totals 122 KB. A "drop non-text parts" rule would sweep those in for
 * no measurable gain, and narrowness is this family's standing habit.
 */
export function imagePartRef(
  part: { type?: string; [key: string]: unknown },
  index: number,
): ImageRefPart | undefined {
  if (part.type !== 'image') return undefined
  const source = part.source as { type?: string; data?: unknown; media_type?: unknown } | undefined
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') return undefined
  return {
    type: 'image_ref',
    media_type:
      typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream',
    bytes: base64Bytes(source.data),
    part_index: index,
  }
}
/** Forward-compatible fallback for block types this protocol version doesn't model. */
export type UnknownBlock = { type: string; [key: string]: unknown }

/**
 * One hunk of a file edit, in unified-diff terms.
 *
 * The numbers are the engine's own, not the client's: `newStart` is where this
 * hunk begins in the file *after* the edit, which is what a reader needs to jump
 * to the change. A client cannot compute them — it has never seen the file — so
 * a diff rendered without this is a diff with no line numbers.
 */
export type PatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Body lines, each prefixed ' ' (context), '-' (removed) or '+' (added), as
   * unified diff spells them. The prefix is part of the string. */
  lines: string[]
}

/**
 * What a file-editing tool changed — the renderable half of an engine's edit
 * output, and deliberately only that half.
 *
 * Both engines can say far more: the Claude SDK's `FileEditOutput` carries
 * `originalFile`, the **entire** contents of the file before the edit. That must
 * not travel here. This log is replayed to every attaching client and captured
 * into parking snapshots, so a whole file on every edit is paid for again on
 * every attach, forever — the same reason attachment bytes are references (see
 * {@link MessageAttachment}) rather than inline base64.
 *
 * So the runner projects the engine's output down to the hunks, which is exactly
 * what a diff renders and nothing more.
 */
export type FilePatch = {
  /** Absolute path the engine reported, when it named one. */
  path?: string
  /** `create` when the file did not exist before this edit. */
  kind?: 'create' | 'update'
  hunks: PatchHunk[]
  /** Hunks were dropped to keep the event small. A renderer must say so rather
   * than present a partial diff as the whole change. */
  truncated?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | UnknownBlock

/**
 * A file the user attached to a message — a photo, a screenshot, a document.
 *
 * The bytes never travel on this protocol. An attachment is uploaded first
 * (`POST {basePath}/sessions/:id/attachments`), and the command that sends the
 * message names it by id; what lands in the seq-numbered event log is this
 * reference. That is deliberate: the log is replayed to every attaching client
 * and captured into parking snapshots, so a few phone photos inlined as base64
 * would be paid for on every attach, forever. Clients render a thumbnail by
 * fetching `GET {basePath}/sessions/:id/attachments/:attachmentId`.
 *
 * Lifetime is the session's, like `/files` — the store is in-memory and an
 * attachment 404s after a server restart. The message itself is unaffected: the
 * model saw the bytes at send time.
 */
export type MessageAttachment = {
  /** Server-assigned; the path segment of the download URL. */
  id: string
  /** Display name from the file the user picked. A leaf name, never a path. */
  name: string
  /** IANA media type, e.g. 'image/jpeg'. The server decides how it reaches the
   * model (image block, document block, or inlined text) from this. */
  mediaType: string
  bytes: number
}

export type ApiMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  stop_reason?: string | null
  /** Per-API-call token usage when the message carries it (assistant messages do).
   * Enables mid-run token accounting; result-message usage stays authoritative. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

/** A tool call promoted into a pending approval by the runner's canUseTool hook
 * (Claude), or an engine ask-channel request surfaced by its runner (codex).
 * The two do not share a tense: Claude asks BEFORE a tool runs; codex's command
 * approval is usually an escalation AFTER its sandbox already ran and refused
 * the command ("command failed; retry without sandbox?"). The runner authors
 * `title`/`description`/`decisionReason` to say which — clients should render
 * those fields rather than composing their own "X wants to run Y" sentence. */
export type PermissionRequest = {
  /** Server-assigned id; used by the `permission_decision` command. */
  id: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  /** Full prompt sentence from the SDK, e.g. "Claude wants to read foo.txt". */
  title?: string
  /** Short noun phrase for the tool action, e.g. "Read file". */
  displayName?: string
  /** Human-readable subtitle, e.g. "Claude will have read access to ~/x". */
  description?: string
  /** Why this permission request was triggered. */
  decisionReason?: string
  /** If raised from within a subagent, that subagent's id. */
  agentId?: string
  /** Epoch ms after which the server resolves it via its timeout policy. */
  expiresAt?: number
}

export type PermissionDecisionSource = 'client' | 'timeout' | 'policy'

// ---------------------------------------------------------------------------
// User questions (the AskUserQuestion tool)
// ---------------------------------------------------------------------------

/** One choice of an AskUserQuestion question (SDK tool-input mirror). */
export type UserQuestionOption = {
  label: string
  description?: string
  /** Optional preview content (markdown unless the session configures html)
   * rendered when the option is focused. */
  preview?: string
}

/** One question from the AskUserQuestion tool's input. By the tool's convention the
 * first option is the model's recommended choice. */
export type UserQuestion = {
  question: string
  /** Short chip/tag label (max ~12 chars), e.g. "Auth method". */
  header: string
  options: UserQuestionOption[]
  multiSelect?: boolean
}

/** How a session treats the AskUserQuestion tool:
 * - 'ask' (default) — a pending permission like any other: interactive UIs render the
 *   question form; job webhooks carry the full request so a remote controller can
 *   answer over REST (POST /sessions/:id/permissions/:requestId).
 * - 'auto' — resolved immediately with each question's first (recommended) option.
 * - 'deny' — the tool is refused with guidance to decide autonomously (unattended runs).
 * Answers ride a permission allow as `updatedInput.answers`: question text → chosen
 * option label(s), multi-select labels comma-joined — the shape the CLI's own UI uses. */
export type QuestionBehavior = 'ask' | 'auto' | 'deny'

// ---------------------------------------------------------------------------
// Session capabilities (models / slash commands the CLI reports)
// ---------------------------------------------------------------------------

/** A model the session can switch to (SDK ModelInfo mirror; fields it may grow stay unknown). */
export type ModelOption = {
  /** Model id for createSession.model / set_model. */
  value: string
  /** Wire model id this row resolves to ('sonnet' → 'claude-sonnet-5'). What a
   * session actually reports as its model is the resolved form, so this is how a
   * client matches the running model back to the row that names it. */
  resolvedModel?: string
  displayName: string
  description?: string
  /** Whether this belongs in a picker's main list rather than behind a "more
   * models" step: the newest model of each family. Derived server-side — the CLI
   * reports one flat list — so that every client groups it the same way. */
  primary?: boolean
  /** Reasoning efforts this model supports at create time (codex catalogs carry
   * them, from the binary's own per-model list). Absent = the engine's default
   * set ({@link EngineCapabilities.reasoningEfforts}) applies. Open strings —
   * the binary's vocabulary outruns its SDK's union. */
  reasoningEfforts?: readonly string[]
}

/**
 * A skill the engine can decide to use — **not** a command.
 *
 * The distinction is the whole point of this type existing beside
 * {@link SlashCommandInfo}. A slash command is wire syntax: the CLI parses
 * `/wrapup` out of the message and runs it. A skill is a capability the model
 * *chooses* from its description; there is no `/skillname` the engine would
 * recognise, and sending one reaches the model as literal text.
 *
 * So a client may list these, and may offer them as a **typing aid** that
 * inserts ordinary editable prose ({@link SkillInfo.defaultPrompt}) — but it
 * must never render them as command chips, and must never put them in
 * `capabilities.commands`, which means "the CLI accepts these as commands".
 */
export type SkillInfo = {
  /** Directory name under the skills root — the identity the model refers to. */
  name: string
  /** What the skill is for, as its own manifest states it. This is the text the
   * MODEL selects on, so it is also the most honest thing to show a human. */
  description?: string
  /** A one-liner where the skill declares one, for a list row too narrow for
   * `description`. */
  shortDescription?: string
  /** Human-facing name from the skill's own interface block, when it differs
   * from `name`. */
  displayName?: string
  /**
   * The engine's own suggested opening message for this skill. A client that
   * offers a picker INSERTS this as plain editable text for the user to finish
   * and send; it is a draft, never something submitted on selection.
   */
  defaultPrompt?: string
  /** Where the skill came from: 'user' | 'repo' | 'system' | 'admin' — kept as
   * a string, the engine's set may grow. */
  scope?: string
  /** False when the operator has this skill switched off: still listed, because
   * "installed but off" is a different answer from "not installed". */
  enabled: boolean
}

/** A slash command the CLI accepts as user-message text (SDK SlashCommand mirror). */
export type SlashCommandInfo = {
  /** Command name without the leading slash. */
  name: string
  description?: string
  /** Hint for arguments, e.g. "<file>". */
  argumentHint?: string
  /** Alternate names resolving to this command. */
  aliases?: string[]
}

// ---------------------------------------------------------------------------
// Usage telemetry (context window + subscription rate limits)
// ---------------------------------------------------------------------------

/** One category row from the CLI's context-usage breakdown (system prompt, tools, ...). */
export type ContextUsageCategory = {
  name: string
  tokens: number
  /** Color the CLI assigns the category. Often a CLI theme token name ('inactive',
   * 'promptBorder', ...), not a CSS color — validate before styling with it. */
  color: string
}

/** Context-window usage snapshot (SDK getContextUsage mirror), polled after each turn. */
export type ContextUsage = {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  /** Used share of the window, 0–100. */
  percentage: number
  /** Model the window sizing applies to. */
  model?: string
}

/**
 * One rate-limit window snapshot (SDK SDKRateLimitInfo mirror). Emitted only for
 * claude.ai subscription sessions — API-key sessions may never produce one, so
 * clients must render nothing (not 0%) until data arrives.
 */
export type RateLimitInfo = {
  /** 'allowed' | 'allowed_warning' | 'rejected' — kept as string, the SDK union may grow. */
  status: string
  /** Which window: 'five_hour' (session), 'seven_day' (weekly), 'seven_day_opus',
   * 'seven_day_sonnet', 'overage', ... — kept as string, the SDK union may grow. */
  rateLimitType?: string
  /** Used share of the window, 0–100. The CLI omits it on some updates — treat
   * absent as unknown, not 0. */
  utilization?: number
  /** Epoch **seconds** when the window resets (render countdowns client-side). */
  resetsAt?: number
  isUsingOverage?: boolean
}

// ---------------------------------------------------------------------------
// Tool execution (bridged, deferred, and remote)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one tool execution, correlated by `executionId` end to end.
 *
 * - `pending` — dispatched, result not in yet (bridged to a client, or queued).
 * - `deferred` — parked beyond this turn/process; may outlive the session's
 *   liveness and be applied on rehydration.
 * - `settled` / `failed` — terminal. Results are applied idempotently by id, so
 *   a duplicate delivery is a no-op rather than a second application.
 */
export type ToolExecutionStatus = 'pending' | 'deferred' | 'settled' | 'failed'

/** Where a tool execution ran (or is running). Advisory: for display and routing. */
export type ToolExecutionBackend = 'server' | 'browser' | 'managed' | 'remote'

/** Result payload of a tool execution, by value — never a live host reference. */
export type ToolExecutionOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }

// ---------------------------------------------------------------------------
// Session events (server -> client)
// ---------------------------------------------------------------------------

export type SessionEventBody =
  /** SDK init handshake: what this session actually is. */
  | {
      type: 'system_init'
      sdkSessionId: string
      model: string
      cwd: string
      /** Where the session's Anthropic auth came from: 'oauth' means a claude.ai
       * subscription login; other values ('user' | 'project' | 'org' | 'temporary')
       * are API-key provenance. Kept as string — the SDK union may grow. */
      apiKeySource: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      permissionMode: PermissionMode
      claudeCodeVersion: string
      mcpServers: Array<{ name: string; status: string }>
    }
  | { type: 'status_changed'; status: SessionStatus; detail?: string }
  /** Models and slash commands available to this session; fetched from the CLI after
   * init. Late attachers get it via replay like any other event. */
  | {
      type: 'capabilities'
      models: ModelOption[]
      commands: SlashCommandInfo[]
      /** Wire id the session's *default* resolves to, from the CLI's own `default`
       * row. Answers "what will this session answer as" before it has answered
       * anything — `system_init` carries the model, but a promptless session gets
       * no `system_init` until its first message. */
      defaultModel?: string
    }
  /**
   * The skills this session's engine can reach ({@link SkillInfo}) — a full
   * replacement each time, not a delta, so a late attacher's replay of several
   * of these converges on the last one. Emitted once the session's engine has
   * enumerated them, and again whenever the engine reports the set changed
   * (a skill added or edited on disk).
   *
   * Deliberately NOT folded into `capabilities.commands`: skills are not
   * commands (see {@link SkillInfo}). Only engines whose record sets
   * {@link EngineCapabilities.skillsList} ever emit it.
   */
  | { type: 'skills'; skills: SkillInfo[] }
  /**
   * The engine wrote a file on the **host filesystem** and handed over its path
   * — codex's `image_gen` saving a PNG is the case that motivated it. The
   * host-filesystem sibling of `file_delivered` (which is the scratch-VFS one).
   *
   * Fetch it at `GET {basePath}/sessions/:id/produced/:fileId` for as long as
   * the session lives. That route has no root allowlist and no size cap, and
   * that is sound *because of where the path came from*: this event is authored
   * by the runner about a file the engine itself just wrote, not by the agent
   * about a path it chose. `/fs/*` gates the second kind and must keep doing so
   * — a file the agent merely *read* is not a produced file and does not belong
   * here.
   *
   * Re-emitting the same file is a no-op: `fileId` is derived from the path, so
   * a runner that learns the path twice (codex reports `savedPath` on both the
   * progress and completed item) registers it once.
   */
  | {
      type: 'file_produced'
      /** Opaque, stable per session+path. The route's path segment. */
      fileId: string
      /** Absolute host path, as the engine reported it. Shown to the operator,
       * and what a client matches against a tool card's own `savedPath`. */
      path: string
      /** Media type when the runner could determine one (usually from the
       * extension). Absent = let the route's own sniffing decide. */
      mediaType?: string
      /** Size at the time it was reported, when the runner knew it. */
      bytes?: number
      /** The tool call that produced it, when one did. */
      toolUseId?: string
    }
  /** The session's model changed via `set_model`. `model` undefined = back to default. */
  | { type: 'model_changed'; model?: string }
  /** The session's permission mode changed via `set_permission_mode`. */
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  /** Context-window usage snapshot; the runner polls it after each turn. */
  | { type: 'context_usage'; usage: ContextUsage }
  /** Subscription rate-limit update for one window (see {@link RateLimitInfo}). */
  | { type: 'rate_limit'; info: RateLimitInfo }
  /** Which claude.ai plan the rate-limit windows belong to: 'pro' | 'max' | 'team' |
   * 'enterprise' — kept as string, the set may grow. Emitted from the same poll as
   * `rate_limit`, once per change, and never for an API-key session (which has no
   * plan). It names the windows; it does not size them — the tier suffix a
   * subscription page shows ("Max 20x") is not in the data. */
  | { type: 'plan_info'; subscriptionType: string }
  /**
   * The engine started a **fresh conversation inside the same session** — the
   * CLI's `/clear`, a plan-mode exit, and whatever fresh-conversation flows the
   * SDK grows. The session id, registry row, workspace and scope are all
   * unchanged; only the conversation is new. Clients empty the transcript and
   * keep every session-scoped fact (models, commands, skills, produced files,
   * rate limits, cwd, permission mode).
   *
   * The server's replay honours it too: an attach after a reset does not
   * resurrect the cleared rows, because the runner skips *transcript content*
   * below the latest reset (see {@link transcriptContent}) while still
   * replaying every state-bearing event. `SessionInfo.activityCount` stays
   * monotonic across a reset on purpose — it is an unread cursor, not an item
   * count, and winding it back would kill every stored watermark above it.
   */
  | {
      type: 'conversation_reset'
      /** The engine session id the fresh conversation runs under (the SDK's
       * `new_conversation_id`), when the engine reported one. The follow-up
       * `system_init` remains authoritative. */
      sdkSessionId?: string
    }
  | {
      type: 'assistant_message'
      message: ApiMessage
      /** Set when the message was produced inside a subagent (Task tool). */
      parentToolUseId: string | null
      /** True when backfilled from a resumed session's history. */
      replay?: boolean
      uuid: string
    }
  | {
      type: 'user_message'
      message: ApiMessage
      parentToolUseId: string | null
      /** True when replayed from a resumed session's history. */
      replay?: boolean
      /** True for tool results and other synthetic user-role messages. */
      synthetic?: boolean
      /** Files sent with this message, by reference (see {@link MessageAttachment}).
       * `message.content` carries the typed text only — the attachment bytes went
       * to the model, not into this log. */
      attachments?: MessageAttachment[]
      /**
       * What a file-editing tool changed, when this message carries that tool's
       * result (see {@link FilePatch}). Set by the runner from the engine's own
       * structured output — never derived by a client from the result text.
       *
       * Only when the message carries exactly one `tool_result` block, which is
       * what both engines send: with two, there is nothing that says which one
       * the patch belongs to, and guessing would attach a diff to the wrong call.
       */
      patch?: FilePatch
      uuid?: string
    }
  /** Raw Anthropic streaming event (message_start/content_block_delta/...); emitted only
   * when the session was created with `includePartialMessages`. */
  | {
      type: 'stream_delta'
      event: { type: string; [key: string]: unknown }
      parentToolUseId: string | null
      uuid: string
    }
  | {
      type: 'turn_result'
      subtype:
        | 'success'
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries'
      isError: boolean
      durationMs: number
      numTurns: number
      totalCostUsd: number
      /** Final text of the turn (success only). */
      result?: string
      errors?: string[]
      usage?: unknown
    }
  | { type: 'permission_requested'; request: PermissionRequest }
  | {
      type: 'permission_resolved'
      requestId: string
      behavior: 'allow' | 'deny'
      resolvedBy: PermissionDecisionSource
      /** Denial message, when denied. */
      message?: string
    }
  /** A tool execution was dispatched to a backend. For bridged executions this
   * precedes the `tool_call_request` frame; for deferred ones it is the record
   * that survives a teardown. */
  | {
      type: 'execution_dispatched'
      executionId: string
      toolName: string
      backend: ToolExecutionBackend
      /** True when the execution may outlive this turn or process. */
      deferred?: boolean
      /** Epoch ms after which the server applies its timeout policy. */
      expiresAt?: number
    }
  /** A dispatched execution produced a result. Applied idempotently by `executionId`. */
  | {
      type: 'execution_result'
      executionId: string
      output: ToolExecutionOutput
      /** Guest/agent-visible logs, if the backend captured any. */
      logs?: string[]
      durationMs?: number
    }
  /** A dispatched execution failed, timed out, or was orphaned. The failure is fed
   * back into the loop as tool output so the agent can adapt — it is not a session error. */
  | {
      type: 'execution_failed'
      executionId: string
      /** Machine-readable cause: 'timeout' | 'oom' | 'exception' | 'orphaned' | backend-specific. */
      reason: string
      error: string
      logs?: string[]
      durationMs?: number
    }
  /** The agent handed over a file from its session scratch filesystem (the
   * `deliver_file` tool). Download it via `GET {basePath}/sessions/:id/files/<path>`
   * for as long as the session lives (the VFS is in-memory). */
  | { type: 'file_delivered'; path: string; bytes: number; description?: string }
  /** Any SDKMessage this protocol version doesn't model first-class (task progress,
   * compaction boundaries, auth status, ...). Payload is the raw SDK message. */
  | { type: 'sdk_event'; payload: { type: string; [key: string]: unknown } }
  | { type: 'session_error'; message: string }
  | { type: 'session_closed'; reason: 'client' | 'server' | 'error' }

export type SessionEvent = SessionEventBody & {
  /** Monotonic per-session sequence number, starting at 1. */
  seq: number
  /** Epoch ms when the server emitted the event. */
  ts: number
}

// ---------------------------------------------------------------------------
// Commands (client -> server)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | {
      type: 'user_message'
      text: string
      /** Ids from `POST {basePath}/sessions/:id/attachments`, in the order they
       * should reach the model. Unknown ids fail the command rather than sending
       * a message that quietly lost its picture. */
      attachmentIds?: string[]
    }
  | {
      type: 'permission_decision'
      requestId: string
      behavior: 'allow' | 'deny'
      /** allow only: modified tool input to run instead of the original. */
      updatedInput?: Record<string, unknown>
      /** deny only: reason surfaced to the model. */
      message?: string
      /** deny only: also interrupt the running turn. */
      interrupt?: boolean
    }
  | { type: 'interrupt' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  /** Switch the model for subsequent responses; omit `model` for the default. */
  | { type: 'set_model'; model?: string }
  /**
   * Result of a tool execution the server bridged to this client (see
   * {@link ToolCallRequestFrame}). Unknown or already-settled `executionId`s are
   * ignored — delivery is idempotent, and a late result after a timeout must not
   * re-open a settled call.
   *
   * Browser-returned results are UNTRUSTED input: acceptable for the user's own
   * data, never a source for server-authoritative state.
   */
  | {
      type: 'tool_call_result'
      executionId: string
      output: ToolExecutionOutput
      logs?: string[]
    }
  /** The client could not execute a bridged call (unsupported tool, guest error,
   * tab closing). Fed back to the agent as tool output. */
  | {
      type: 'tool_call_error'
      executionId: string
      reason: string
      error: string
      logs?: string[]
    }
  | { type: 'close' }

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/** First frame the server sends after a successful attach. */
export type AttachedFrame = {
  type: 'attached'
  protocolVersion: number
  session: SessionInfo
  /** Events with seq > the client's `afterSeq` follow as `event` frames. */
  replayingFrom: number
}

/**
 * Ask the attached client to execute a tool call in its own sandbox (browser
 * bridge). The client answers with `tool_call_result` or `tool_call_error`
 * carrying the same `executionId`.
 *
 * Only sandbox-benefiting tools are ever bridged. Authenticated/authoritative
 * tools (MCP, secret-bearing APIs) execute server-side and never appear here.
 */
export type ToolCallRequestFrame = {
  type: 'tool_call_request'
  executionId: string
  toolName: string
  input: unknown
  /** Files to seed the client's scratch VFS with, path → contents. */
  vfsSeed?: Record<string, string>
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Epoch ms after which the server gives up and fails the execution. */
  expiresAt?: number
}

export type ServerFrame =
  | AttachedFrame
  | { type: 'event'; event: SessionEvent }
  | ToolCallRequestFrame
  /** A bridged execution no longer needs an answer (turn interrupted, timed out,
   * or the session closed) — the client should abandon it. */
  | { type: 'tool_call_canceled'; executionId: string; reason: string }
  | { type: 'protocol_error'; message: string }

export type ClientFrame = SessionCommand

// ---------------------------------------------------------------------------
// Profiles (named Claude Code config directories)
// ---------------------------------------------------------------------------

/** Per-profile fallbacks filled into session/job requests that leave the field
 * unset. Defaults, not enforced caps — an explicit request value always wins. */
export type ProfileDefaults = {
  model?: string
  permissionMode?: PermissionMode
}

/**
 * A named Claude Code config directory sessions can run under: the session's CLI
 * process gets it as CLAUDE_CONFIG_DIR, so the profile carries that directory's
 * settings, memory, skills, and whatever credentials the SDK/CLI resolves from it.
 * Profiles are declared in server options at startup (or a 'default' one is
 * auto-created from the operator's own config dir) — the API only reads them.
 */
/**
 * Which engine a profile runs on. A **closed union, deliberately**: both clients
 * switch exhaustively, the Swift mirror ships in lockstep, and a closed set is
 * what lets this package carry per-engine capability defaults
 * ({@link ENGINE_CAPABILITIES}) browser-safe, with no server round-trip. Adding a
 * member is a versioned protocol event.
 *
 * - `claude` (default) — Claude Code via the Agent SDK, configured by a config dir.
 * - `codex` — OpenAI Codex over the codex CLI binary's `app-server` JSON-RPC
 *   surface, configured by a CODEX_HOME (auth resolved by the binary itself,
 *   like claude).
 * - `provider` — a model-agnostic provider over the AI SDK, assembled by the
 *   host's `createEngineRunner` hook.
 */
export type ProfileEngine = 'claude' | 'codex' | 'provider'

/**
 * What an engine does and does not do — one axis per real difference, each field
 * answering a concrete UI or gateway question. Clients render from this record
 * instead of switching on the engine name: an absent capability means the
 * affordance is *hidden*, never a control that silently does nothing.
 *
 * Reaches clients in two places, same shape: `ProfileInfo.capabilities` (stamped
 * by the server; the create form's source) and `SessionInfo.capabilities`
 * (reported by the runner; the session surface's source). When the field is
 * absent — an older server — {@link ENGINE_CAPABILITIES} keyed by the engine
 * name is the browser-safe default.
 */
export type EngineCapabilities = {
  /** PermissionRequest / permission_resolved can occur; approval UI is live.
   * False: hide approval affordances entirely (and `questionBehavior` on jobs). */
  interactiveApprovals: boolean
  /** Modes this engine can honor. A stored choice outside the set is coerced to
   * {@link EngineCapabilities.defaultPermissionMode}, not submitted. */
  permissionModes: readonly PermissionMode[]
  /** Coercion target for a stored/unsupported mode choice (always ∈ permissionModes). */
  defaultPermissionMode: PermissionMode
  /** CreateSessionRequest.resume works (an engine session id continues). */
  resume: boolean
  /** Resume replays prior history into the transcript (Claude's backfill).
   * False + resume: show a "history predates this attach" notice instead of
   * treating an empty transcript as a bug. */
  resumeBackfill: boolean
  /** GET /sdk-sessions offers a resume picker for this engine. */
  listSessions: boolean
  /** context_usage events can occur. False: render nothing — never a 0% ring. */
  contextUsage: boolean
  /** rate_limit / plan_info events can occur. False: render nothing. */
  rateLimits: boolean
  /** GET /sessions/:id/mcp works (else 501) — the engine can *list* its MCP
   * servers. Gates the MCP panel's existence. */
  mcpStatus: boolean
  /**
   * POST /sessions/:id/mcp/:name works — the engine can reconnect, enable and
   * disable a server. Separate from {@link EngineCapabilities.mcpStatus}
   * because listing and acting are genuinely different powers: codex reports
   * rich status but exposes no per-server action on this transport, and a panel
   * that rendered the buttons anyway would present three controls that do
   * nothing and then report success. False: render the panel read-only.
   */
  mcpServerActions: boolean
  /** A session request may bring its own mcpServers. */
  sessionMcpServers: boolean
  /** capabilities events carry slash commands (composer popover). */
  slashCommands: boolean
  /** `skills` events can occur — the engine can enumerate its skills. False:
   * hide the skills panel entirely rather than showing an empty one. Orthogonal
   * to `slashCommands`: an engine can have skills and no commands (codex), or
   * commands and no skill listing (claude, whose skills reach clients only as
   * `system_init.skills` names). */
  skillsList: boolean
  /** settingSources / allowDangerouslySkipPermissions-style CLI options apply. */
  settingSources: boolean
  /** maxTurns / maxBudgetUsd are honored (else the gateway 400s them). */
  budgets: boolean
  /** Attachment kinds sendMessage can deliver to the model. Filter the attach
   * menu by kind; refuse locally before the server's 415. */
  attachments: ReadonlyArray<'image' | 'pdf' | 'text'>
  /** Efforts offerable at create time; absent = not settable (hide the control).
   * Open strings — Codex's own binary already outruns its SDK's union. */
  reasoningEfforts?: readonly string[]
  /** Sessions expose a scratch VFS (GET /sessions/:id/files, deliverables panel). */
  vfs: boolean
  /**
   * The engine runs against a host directory, so `CreateSessionRequest.cwd` is
   * required and meaningful (and a create form should ask for it). False: the
   * engine has no host filesystem — the gateway accepts a session with no
   * `cwd`, `SessionInfo.cwd` reports `''`, and there is no path to validate.
   *
   * Absent = true, so a wire copy from an older gateway keeps the old
   * always-required behaviour rather than silently relaxing it.
   */
  hostCwd?: boolean
  /** stream_delta granularity: per-token, coarse item updates (no typing
   * cursor), or none. */
  streaming: 'token' | 'item' | 'none'
}

/**
 * The static capability record of each engine — the browser-safe default for
 * `ProfileInfo.capabilities` / `SessionInfo.capabilities`, and the single place
 * the values are written down. Core's adapters *reference* this record and a
 * conformance test compares runner behaviour against it, so it cannot silently
 * diverge from the code. When both a wire copy and this default exist, the wire
 * copy wins.
 */
export const ENGINE_CAPABILITIES: Record<ProfileEngine, EngineCapabilities> = {
  claude: {
    interactiveApprovals: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
    defaultPermissionMode: 'default',
    resume: true,
    resumeBackfill: true,
    listSessions: true,
    contextUsage: true,
    rateLimits: true,
    mcpStatus: true,
    mcpServerActions: true,
    sessionMcpServers: true,
    slashCommands: true,
    // The CLI reports skill NAMES on `system_init` and nothing more — no
    // descriptions, no scope, no suggested prompt. That is not enough to fill a
    // picker honestly, and the SDK exposes no listing call, so the panel stays
    // off here rather than rendering a list of bare words.
    skillsList: false,
    settingSources: true,
    budgets: true,
    attachments: ['image', 'pdf', 'text'],
    // The engine-wide set (SDK Options.effort); per-model narrowing rides the
    // catalog rows, and the CLI silently downgrades an effort a model lacks.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    vfs: false,
    hostCwd: true,
    streaming: 'token',
  },
  codex: {
    // The app-server ask channels (server→client JSON-RPC requests: command
    // escalations, file changes, permission grants, tool questions, MCP
    // elicitations) are wired to the permission surface: they arrive as
    // `permission_requested` and are answered by `permission_decision`.
    // NOTE the semantic shift a client should not paper over: codex's command
    // approval is usually an ESCALATION after the sandbox already refused the
    // command ("command failed; retry without sandbox?"), not a gate before
    // execution — the runner authors `title`/`decisionReason` from codex's own
    // reason sentence, so render those rather than composing "wants to use X".
    interactiveApprovals: true,
    // 'default' = read-only sandbox + ask (a blocked action becomes a real
    // question instead of a silent refusal); acceptEdits = workspace-write +
    // ask (in-workspace writes sail through, escalations still ask); bypass =
    // full access, asking nothing. plan/dontAsk/auto name CLI workflows codex
    // cannot deliver.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    resume: true,
    // A resume replays the thread's prior turns from `thread/resume`'s
    // `thread.turns` (topped up via `thread/read {includeTurns: true}` when the
    // resume page is partial) as `replay: true` events — same contract as the
    // Claude engine's backfill.
    resumeBackfill: true,
    // `GET /sdk-sessions?profile=<codex profile>` lists CODEX_HOME's threads
    // over a short-lived `thread/list` connection; no live session required.
    listSessions: true,
    // From `thread/tokenUsage/updated.last` against `modelContextWindow`, after
    // each turn. Its `categories` is always empty — codex publishes no
    // breakdown — so a client must not draw an empty breakdown section.
    contextUsage: true,
    // From `account/rateLimits/updated`, which app-server pushes during a turn
    // (no poll needed). Windows are positional there and named here by their
    // measured duration — see `docs/GOTCHAS.md` §Codex.
    rateLimits: true,
    // `mcpServerStatus/list` answers with each server, its `serverInfo`, its
    // auth status and — unlike the Agent SDK — the full JSON Schema of every
    // tool. Live status rides the `mcpServer/startupStatus/updated`
    // notification rather than the list response, so the runner tracks it.
    mcpStatus: true,
    // …but nothing on this transport reconnects or toggles ONE server. The
    // reload RPC is server-wide, and enable/disable would mean writing the
    // operator's config.toml — a different act from Claude's session-scoped
    // switch. So the panel is read-only here instead of offering buttons that
    // would lie.
    mcpServerActions: false,
    // MCP belongs to CODEX_HOME's config.toml; a session request cannot add servers.
    sessionMcpServers: false,
    // There is no command-listing RPC in the app-server surface at all: codex's
    // own `/model`, `/approvals` etc. are TUI-local and never reach this
    // transport. This is settled, not pending.
    slashCommands: false,
    // …but `skills/list` does exist, and `skills/changed` says when to re-read
    // it. What comes back is metadata rich enough to render (description,
    // scope, and codex's own `defaultPrompt`) — see {@link SkillInfo} for why
    // that is still not a command.
    skillsList: true,
    settingSources: false,
    budgets: false,
    // Images travel as localImage host paths, text is inlined into the prompt
    // envelope; pdf has no representation and 415s at upload.
    attachments: ['image', 'text'],
    // The engine-wide floor; per-model supersets (max, ultra) ride
    // ModelOption.reasoningEfforts from the catalog.
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    vfs: false,
    hostCwd: true,
    // item/agentMessage/delta and the reasoning deltas arrive token-by-token.
    streaming: 'token',
  },
  provider: {
    interactiveApprovals: false,
    permissionModes: ['default', 'bypassPermissions', 'dontAsk'],
    defaultPermissionMode: 'default',
    resume: false,
    resumeBackfill: false,
    listSessions: false,
    contextUsage: false,
    rateLimits: false,
    // The one engine whose MCP is entirely host-wired, and so the one that can
    // always answer: `AiSdkRunner` reports what the host assembled the session
    // from (an empty list when that was nothing). Acting on a server is a
    // different power and stays absent — the host owns those connections and
    // this engine has no channel to renegotiate one.
    mcpStatus: true,
    mcpServerActions: false,
    sessionMcpServers: false,
    slashCommands: false,
    skillsList: false,
    settingSources: false,
    budgets: false,
    attachments: ['image', 'pdf', 'text'],
    vfs: true,
    // No host filesystem at all: the tools run against the in-memory VFS, and
    // the runner never opens a path. A required `cwd` here would be a field
    // nothing reads, and `allowedCwdRoots` would look like the sandbox boundary
    // when the capability wiring is what actually bounds this engine.
    hostCwd: false,
    streaming: 'token',
  },
}

/**
 * Permission modes the model-agnostic provider engine understands.
 * @deprecated Read `ENGINE_CAPABILITIES.provider.permissionModes` (this is an
 * alias of it, kept for protocol-5 consumers).
 */
export const PROVIDER_PERMISSION_MODES: readonly PermissionMode[] =
  ENGINE_CAPABILITIES.provider.permissionModes

/**
 * Whether a profile's engine can run a permission mode. The single source of
 * truth for the restriction: create forms filter what they offer with it, the
 * gateway rejects with it. An absent `engine` means 'claude' (every mode).
 */
export function supportsPermissionMode(
  engine: ProfileEngine | undefined,
  mode: PermissionMode,
): boolean {
  return ENGINE_CAPABILITIES[engine ?? 'claude'].permissionModes.includes(mode)
}

/**
 * A model provider a `provider` profile can run on. Credentials are ALWAYS
 * resolved from the operator's environment — never carried on the wire, never
 * stored here. `apiKeyEnv` names the variable to read, it does not hold a key.
 */
export type ProviderConfig = {
  /** Provider adapter to use, e.g. 'anthropic' | 'openai' | 'moonshotai' |
   * 'openai-compatible'. Kept as a string: the set is host-extensible. */
  id: string
  /** Default model id, e.g. 'kimi-k3'. Overridable per session. */
  model?: string
  /** Model ids this profile offers, for the dashboard's picker. Operator-declared
   * rather than discovered: provider engines have no equivalent of the CLI's
   * `supportedModels()`, and only the operator knows which ids their endpoint and
   * key actually serve. Unset → the picker offers {@link ProviderConfig.model} alone. */
  models?: string[]
  /** Base URL for OpenAI-compatible providers. */
  baseUrl?: string
  /** Environment variable the operator put the key in. Never the key itself. */
  apiKeyEnv?: string
}

/**
 * A grantable capability of the model-agnostic engine, named after the tool it
 * yields. The always-present tools (`fs_*`, `eval_script`) are not listed: they
 * are the engine's scratch filesystem and sandbox, not a grant.
 */
export type SessionCapability = 'web_search' | 'download' | 'web_fetch' | 'deliver_file'

/**
 * What sessions under a `provider` profile get, declared by the operator. Meaning-
 * less for `claude` profiles, whose equivalents live in the config directory.
 *
 * MCP servers are named, never configured, here: a server's transport config can
 * carry credentials in its headers, and this type is served by `GET /profiles`.
 * The names refer to servers the host connected in `createEngineRunner`, which is
 * where the configs (and the credentials) stay.
 */
export type ProfileSessionDefaults = {
  /** Capabilities granted to sessions under this profile. Absent = no
   * declaration, so a session gets whatever backends the host wired. A session
   * request may narrow this set, never widen it. */
  capabilities?: SessionCapability[]
  /** MCP servers, by name, whose tools sessions under this profile may use.
   * Absent = no declaration (every server the host connected). */
  mcpServers?: string[]
  /** Prepended to the session's system prompt. */
  instructions?: string
}

/**
 * One rate-limit window of a profile's plan, as the *gateway* last saw it — the
 * newest {@link RateLimitInfo} any session on the profile reported, across every
 * session, live or since closed. The profile is the account boundary (one config
 * dir / codex home / provider key = one plan), so this is the single usage state
 * per account, where a session's own transcript only knows what *it* was last
 * told.
 *
 * Two rules a client must keep:
 * - An absent window (or an absent {@link ProfileInfo.usage} entirely) is
 *   **unknown, not 0%** — render nothing, exactly as for session-level readings.
 *   The map is in-memory and starts empty on a cold server.
 * - `inferredReset` marks a reading the server zeroed at serve time because the
 *   reading's own `resetsAt` passed with nothing newer: the pre-reset number is
 *   then provably wrong, and 0 is the truthful *floor* (the account may have
 *   been used outside this gateway since). Distinguishable on the wire from an
 *   engine-reported 0, which carries no flag.
 */
export type ProfileUsageWindow = {
  /** The reading, exactly as the session event carried it — except after an
   * elapsed reset, when `utilization` is 0 and `resetsAt` is dropped (the old
   * one names the *previous* window; a countdown from it would be nonsense). */
  info: RateLimitInfo
  /** Epoch ms of the event that carried the reading — honest for "Updated …"
   * lines even when the served utilization is inferred. */
  updatedAt: number
  /** Present (true) only on the served-as-0 inference described above. */
  inferredReset?: boolean
}

/** Per-window plan usage, keyed by `rateLimitType` ('five_hour', 'seven_day',
 * ...) — the same keying as a transcript's rate-limit state. */
export type ProfileUsage = Record<string, ProfileUsageWindow>

export type ProfileInfo = {
  /** Unique name, used as {@link CreateSessionRequest.profile}. */
  name: string
  /** Engine this profile runs on. Defaults to 'claude' when absent, so profiles
   * written before provider support keep working unchanged. */
  engine?: ProfileEngine
  /** Absolute path set as CLAUDE_CONFIG_DIR for the session's CLI process.
   * Required for 'claude' profiles; meaningless for the other engines. */
  configDir?: string
  /** Codex profiles: absolute path set as CODEX_HOME for the session's codex
   * process (auth, config.toml, thread storage) — the `configDir` analogue,
   * request-writable like it. Unset = the binary's own `~/.codex`. */
  codexHome?: string
  /** Provider wiring for 'provider' profiles. */
  provider?: ProviderConfig
  description?: string
  defaults?: ProfileDefaults
  /** Provider-engine session grants (capabilities, MCP servers, instructions). */
  session?: ProfileSessionDefaults
  /** Response-only: the engine's model catalog, shipped with the release and
   * served from the first request (no process spawned, no warm-up session).
   * For provider profiles the ids come from `provider.models` instead. Never
   * contains a 'default' sentinel row — forms add their own "Profile default"
   * row mapping to an unset model. Ignored on the way in. */
  models?: ModelOption[]
  /** Response-only: what this profile's default model resolves to. For claude
   * profiles this is the operator's CLI config — unknowable statically — so it
   * is absent until a session on this profile reports it. */
  defaultModel?: string
  /** Response-only: the engine's capability record (see {@link EngineCapabilities}).
   * Absent = use ENGINE_CAPABILITIES[engine]. Ignored on the way in. */
  capabilities?: EngineCapabilities
  /** Response-only: whether the profile's credentials probe as usable right now.
   * Absent = unknown/unchecked — treat as available. **Display-only**: create
   * against an unavailable profile still proceeds and fails with the engine's
   * own error (the probe can be stale in both directions). */
  available?: boolean
  /** Response-only: one operator-actionable line, present only when
   * `available === false`. */
  unavailableReason?: string
  /** Response-only: the plan's rate-limit windows as last reported by any
   * session on this profile (see {@link ProfileUsageWindow}). Absent = unknown
   * — no session has reported yet (API-key sessions never do), or the server
   * restarted. **Display-only**, like `available`: never a gate. */
  usage?: ProfileUsage
  /** Response-only, computed by the server: this profile came from the profile
   * store and can be edited or deleted through the API. Profiles declared in
   * server options are absent/false — they are code. Ignored on the way in. */
  managed?: boolean
}

/**
 * Curated, read-only snapshot of what a profile's config directory contains —
 * the parts relevant to running worker sessions. Values that could carry secrets
 * (env var values) never leave the server; only names are listed.
 */
export type ProfileConfigSnapshot = {
  /** From the config dir's settings.json; absent when missing or unparseable. */
  settings?: {
    /** Configured default model. */
    model?: string
    /** permissions.defaultMode — the CLI's default permission mode. */
    defaultPermissionMode?: string
    /** Rule counts from permissions.allow / ask / deny. */
    permissionRules?: { allow: number; ask: number; deny: number }
    /** Env var NAMES declared in settings.json env (values never included). */
    envKeys?: string[]
    /** Hook event names with at least one hook configured. */
    hooks?: string[]
  }
  /** CLAUDE.md (user memory) present in the config dir. */
  hasUserMemory: boolean
  /** Skill names (skills/<name>/). */
  skills: string[]
  /** Agent names (agents/<name>.md). */
  agents: string[]
  /** Custom slash-command names (commands/<name>.md). */
  commands: string[]
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

export type McpServerConfigWire =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

/** One tool an MCP server exposes, as the session's engine reports it.
 * Parameters are deliberately absent: the CLI's status payload names and
 * describes each tool but does not carry its input schema. */
export type McpServerToolInfo = {
  name: string
  description?: string
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }
  /**
   * The tool's JSON Schema, where the engine reports one. **Engine-dependent,
   * and that is not an oversight**: the Agent SDK's `McpServerStatus` names and
   * describes each tool but carries no schema at all, while codex's
   * `mcpServerStatus/list` returns the full one. So a client renders parameters
   * where they exist and says they are unavailable where they don't — rather
   * than either leaving a silent gap or claiming the absence is universal.
   *
   * Opaque on purpose: this is a JSON Schema document, not a shape this
   * protocol models.
   */
  inputSchema?: unknown
}

/**
 * Live status of one MCP server on a session — what `GET
 * {basePath}/sessions/:id/mcp` answers with, and what the `/mcp` screens render.
 *
 * The connection *identity* is here (transport, command, url, scope) but never
 * its secrets: the engine's config carries `env` for stdio servers and `headers`
 * for HTTP/SSE ones, and both are dropped on the way out. A client that can read
 * this is not thereby entitled to the tokens the operator configured.
 */
export type McpServerStatusInfo = {
  name: string
  /** 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' — kept open,
   * the engine's set may grow. */
  status: string
  /** Where the server was configured: 'project' | 'user' | 'local' | 'dynamic' | … */
  scope?: string
  /** Present when `status` is 'failed'. */
  error?: string
  /** Name and version the server announced on connect. */
  serverInfo?: { name: string; version: string }
  transport?: 'stdio' | 'http' | 'sse' | 'sdk'
  /** stdio only. */
  command?: string
  /** stdio only. Secrets do occasionally ride argv; the operator's own client
   * shows them, and hiding them here would only mislead. `env` is not exposed. */
  args?: string[]
  /** http/sse only. */
  url?: string
  /** Present when connected. */
  tools?: McpServerToolInfo[]
}

export type McpServersResponse = { servers: McpServerStatusInfo[] }

/** `POST {basePath}/sessions/:id/mcp/:name` — answers with the refreshed status. */
export type McpServerActionRequest = { action: 'reconnect' | 'enable' | 'disable' }

/** `POST {basePath}/sessions/:id/attachments?name=<name>` — the body is the raw
 * file, the `content-type` header its media type. Answers with the reference to
 * name on the next `user_message`. */
export type UploadAttachmentResponse = { attachment: MessageAttachment }

export type CreateSessionRequest = {
  /** Directory the session is rooted at. Required for any engine whose
   * capability record declares {@link EngineCapabilities.hostCwd} — `cwd` is
   * per-query in the SDK and the server re-pins it on every call. Omittable for
   * an engine that has no host filesystem at all (the provider engine, whose
   * tools run against the in-memory VFS): there the field would be a required
   * lie, and `allowedCwdRoots` would look like a sandbox boundary it is not. */
  cwd?: string
  /** Profile (named Claude Code config dir) to run under. Required when the server
   * declares more than one profile; implicit when exactly one exists. */
  profile?: string
  /** Optional initial prompt (may be a skill invocation like "/verify-content 123"). */
  prompt?: string
  permissionMode?: PermissionMode
  /** Pre-authorize 'bypassPermissions' (the CLI's --dangerously-skip-permissions
   * capability) so the mode can be switched on mid-session. Without it the CLI
   * rejects `set_permission_mode: 'bypassPermissions'` on a running session.
   * Implied when `permissionMode` is already 'bypassPermissions'. */
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfigWire>
  /** Which filesystem settings the session loads. Include 'project' to pick up the
   * target repo's skills and CLAUDE.md ("close-to-real" fidelity). */
  settingSources?: Array<'user' | 'project' | 'local'>
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Resume an existing SDK session by id. */
  resume?: string
  /** With `resume`: fork to a new session id instead of continuing. */
  forkSession?: boolean
  /** Reasoning effort for the session's model (codex engine). Open string —
   * offerable values come from the profile's catalog/capability record. The
   * gateway 400s it when the engine's record declares no `reasoningEfforts`. */
  reasoningEffort?: string
  /** Emit `stream_delta` events for token-by-token rendering. Default true. */
  includePartialMessages?: boolean
  /** Per-session override of the server's permission-request timeout (ms). */
  approvalTimeoutMs?: number
  /** AskUserQuestion handling (see {@link QuestionBehavior}). Default 'ask'. */
  questionBehavior?: QuestionBehavior
  /** Provider engine only: run with fewer capabilities than the profile grants
   * (see {@link ProfileSessionDefaults.capabilities}). Narrowing only — naming a
   * capability the profile does not grant is a 400, not a silent upgrade. */
  capabilities?: SessionCapability[]
  /** Free-form metadata echoed back on SessionInfo (host app bookkeeping). */
  meta?: Record<string, unknown>
  /**
   * Opaque string tags naming what this session *belongs to* — the gateway's
   * only intra-deployment scoping primitive. Assigned at create, **immutable
   * afterwards** (no route writes it), echoed on {@link SessionInfo}, and
   * carried through parking/dormancy so a restart cannot un-scope a session.
   *
   * WorkerDeck never interprets a key: an embedder writes `{ space, user }` or
   * `{ tenant }` or nothing at all. What the tags *mean* is the host's
   * `authorizeSession` predicate; absent one, the default rule is that every
   * key the authenticated principal pins must match here (an unset principal
   * scope is unrestricted — the same "unset means all" rule `allowedProfiles`
   * uses, so an operator's dashboard keeps working unchanged).
   *
   * NOT `meta`: `meta` is free-form, client-settable and echoed, and an
   * enforcement rule whose input the caller supplies is not an enforcement
   * rule. Values are visible to any principal the policy admits a session to,
   * so use opaque ids rather than names you would not show that audience.
   */
  scope?: Record<string, string>
}

/**
 * One sub-agent (a `Task` call and the sidechain it spawned), as a *list* surface
 * sees it — without attaching.
 *
 * Sub-agent work is otherwise attach-only: it exists on the wire as
 * `parentToolUseId` on three event bodies, and is reconstructed into rows by the
 * react reducer and grouped per-Task by `terminalBlocks`. A sessions list never
 * attaches (one live attach per session, owned by the panel), so it reads
 * `SessionInfo` over REST and would otherwise have no way to know a session has
 * six agents running inside one turn.
 *
 * This is a **runner-owned rollup computed at read time**, exactly like
 * {@link SessionInfo.pendingPermissionCount}: it is not an event, it is not
 * persisted separately, and it therefore rides the REST list, the WS attach
 * snapshot and parking snapshots for free. Only the claude engine produces it —
 * codex and provider emit `parentToolUseId: null` on every event, so an empty
 * list there is the truth rather than a gap.
 *
 * It is deliberately **not** the input to `taskSummary`. That string is spelled
 * from the absorbed transcript items and must stay that way, so a transcript
 * replayed tomorrow spells the same line from the same items it holds today.
 */
export type SubagentInfo = {
  /** The `tool_use` id of the `Task` call that spawned it — the same id its
   * nested events carry as `parentToolUseId`, and therefore the handle a client
   * uses to jump to that Task's row. */
  toolUseId: string
  /** The Task input's `subagent_type` (e.g. "Explore"), when it named one. */
  agentType?: string
  /** The Task input's short `description`, clipped by the runner. Together with
   * `agentType` this is what makes two parallel sub-agents tell apart in a list;
   * a row reading only `Task` answers nothing. */
  description?: string
  /**
   * `running` until the Task's own `tool_result` arrives, then `done`/`failed`
   * from that result's `is_error`. A turn that ends without that result — an
   * interrupt, a session error, a turn or budget cap — settles what is still
   * running as `failed`: the report never came, which is the one thing `done`
   * could have claimed, and a `running` badge on an idle session would be a
   * lie a list re-renders at every poll.
   *
   * Deliberately **narrower than `taskFailed`** in `@workerdeck/ui`'s
   * `tool-run.ts`, which reddens a Task row when *any child call* failed. That is
   * right for a transcript row the reader can expand — the failure is one press
   * away and hiding it would be worse. It is wrong for a list: a grep that
   * matched nothing inside an otherwise successful Explore agent would put
   * `failed` beside the session's name with nothing to open. So this reports the
   * sub-agent's own outcome. If you are here to "fix" the inconsistency, this is
   * the reason it exists.
   */
  status: 'running' | 'done' | 'failed'
  /** Epoch ms the `Task` call was emitted. */
  startedAt: number
  /** Tool calls the sub-agent has made so far — its progress reading while
   * running, counted from nested `tool_use` blocks. */
  toolCount: number
}

/**
 * How many *settled* sub-agents {@link SessionInfo.subagents} keeps behind the
 * running ones. Small on purpose: the point of the tail is that a list row does
 * not go blank the instant a run finishes, not that it is a history.
 */
export const SUBAGENT_HISTORY = 8

export type SessionInfo = {
  /** Server-assigned id (stable across SDK session forks/resumes). */
  id: string
  /** Underlying Agent SDK session id, once known; use for `resume`. */
  sdkSessionId?: string
  status: SessionStatus
  /** Empty string for a session whose engine has no host filesystem (see
   * {@link CreateSessionRequest.cwd}). Deliberately not optional: every client
   * renders and searches it, and a synthetic path would send the workspace and
   * `@file` search probing a directory that does not exist. */
  cwd: string
  /** Profile the session runs under (resolved name, present even when implicit). */
  profile?: string
  /** Engine actually running this session, reported by the runner itself. Lets a
   * session surface gate CLI-only affordances (permission modes, context usage,
   * rate limits) without looking the profile back up. Absent = 'claude'. */
  engine?: ProfileEngine
  /** The engine's capability record, reported by the runner like `engine`. The
   * attach snapshot is the session-level source (no event carries it). Absent =
   * ENGINE_CAPABILITIES[engine]. */
  capabilities?: EngineCapabilities
  model?: string
  permissionMode?: PermissionMode
  /** Whether this session may be switched into `bypassPermissions`. The CLI only
   * allows it when the process was spawned for it, so it is decided at creation
   * and never changes: a session that did not ask for bypass up front cannot
   * gain it later. Lets a picker disable the mode instead of offering a switch
   * the engine will refuse. Absent = unknown (an older server). */
  canBypassPermissions?: boolean
  /** See the `system_init` event; 'oauth' = claude.ai subscription credentials. */
  apiKeySource?: string
  createdAt: number
  /** Highest event seq emitted so far; attach with `afterSeq` to catch up. */
  lastSeq: number
  pendingPermissionCount: number
  /**
   * Sub-agents this session has running, plus a short tail of settled ones — see
   * {@link SubagentInfo}. Absent on an engine that has no sidechains and on an
   * older server; **absent and empty mean the same thing to a client**, so render
   * nothing rather than "0 sub-agents".
   *
   * Bounded on purpose. This rides every row of `GET /sessions`, which a busy
   * client polls at 1.2s, and it is captured into parking snapshots — the same
   * attachment-bytes rule that keeps whole files off {@link FilePatch}. Every
   * *running* sub-agent is always present (they are the live reading and there
   * are never many at once); settled ones are kept newest-first to
   * {@link SUBAGENT_HISTORY} and then dropped, so a day-long session with two
   * hundred Tasks does not grow an unbounded field. A client must therefore not
   * treat this as the session's full Task history — the transcript is that.
   */
  subagents?: SubagentInfo[]
  meta?: Record<string, unknown>
  /** Display title: `meta.title` if the host set one, else derived (e.g. first prompt). */
  title?: string
  /** Cumulative cost across all turns so far (sum of turn_result totals). */
  totalCostUsd?: number
  /** Cumulative turn count across the session. */
  numTurns?: number
  /**
   * How many transcript rows this session has produced (see
   * {@link transcriptActivity}) — a monotonic counter a client can diff against
   * a remembered value to answer "how much happened while I wasn't looking",
   * without attaching.
   *
   * `numTurns` cannot answer it: five tool calls inside one turn are one turn.
   * `lastSeq` cannot either — it counts every event, and with token streaming on
   * that is hundreds per reply. Absent on an older server; a client should fall
   * back to `numTurns` rather than showing nothing.
   *
   * Monotonic for the session's whole life, **including across a
   * `conversation_reset`**: after a `/clear` this deliberately exceeds the
   * number of rows a fresh attach renders. It is an unread *cursor* diffed
   * against stored monotonic watermarks (see `watermarks.ts`) — resetting it to
   * the new row count would leave every stored mark above it, and that
   * session's badge dead until the count caught back up.
   */
  activityCount?: number
  /** Epoch ms of the most recent emitted event. */
  lastActivityAt?: number
  /** Opaque scope tags this session was created with — see
   * {@link CreateSessionRequest.scope}. Echoed by the runner, re-stamped by the
   * gateway, and never editable. */
  scope?: Record<string, string>
}

/**
 * How many transcript rows an event materializes — the unit behind
 * {@link SessionInfo.activityCount}.
 *
 * Deliberately the *reducer's* rule (`@workerdeck/react`'s `transcript.ts`), not
 * a server-side approximation: one row per content block of an assistant
 * message (a text, a thought, each tool call), one for a user message, one per
 * turn result, delivered file or error. Everything else — status changes, usage
 * readings, stream deltas, permission bookkeeping — is state, not a row, and
 * counts zero.
 *
 * It lives in `protocol` because both sides need it and neither may import the
 * other: the runners count with it, and any client compares the totals. If the
 * reducer's row rule changes, change this with it.
 */
export function transcriptActivity(body: SessionEventBody): number {
  // A subagent's own messages are not rows of *this* conversation: they render
  // inside the `Task` call that spawned them, which is itself a row and already
  // counted. Scoring them would make an unread badge announce dozens of rows a
  // reader cannot see without expanding a block — and the badge is a promise
  // about what is on screen. The claim is the same one `transcriptContent`
  // declines to make: nested items still *mutate* items, so they must still
  // replay; they merely do not add to the count.
  if ('parentToolUseId' in body && body.parentToolUseId != null) return 0
  switch (body.type) {
    case 'assistant_message': {
      const content = body.message.content
      // A string body is one text row. Blocks are one row each, except tool
      // results (which land inside the call's own row) and unknown blocks.
      if (typeof content === 'string') return content.trim() === '' ? 0 : 1
      const rows = content.filter(
        (block) => block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use',
      ).length
      return rows
    }
    case 'user_message':
      // Tool results arrive as synthetic user messages; they are not rows.
      return body.synthetic ? 0 : 1
    case 'turn_result':
    case 'file_delivered':
    case 'session_error':
      return 1
    default:
      return 0
  }
}

/**
 * Whether an event is **transcript content** — whether the reducer
 * (`@workerdeck/react`'s `transcript.ts`, and its Swift mirror) mutates
 * `items` when it applies it. The rule behind `conversation_reset`'s replay
 * semantics: the runner keeps its whole event log, but `subscribe()` skips
 * content below the latest reset so an attaching client does not resurrect a
 * cleared conversation — while every *state-bearing* event (`system_init`,
 * `capabilities`, `skills`, `status_changed`, usage and rate-limit readings,
 * `file_produced`, permission bookkeeping) still replays, because a fresh
 * attacher with no model list and no cwd is broken, not cleared.
 *
 * Deliberately **broader than `transcriptActivity() > 0`**: stream deltas,
 * tool results (synthetic user messages) and execution lifecycle events count
 * zero rows but still mutate items — replaying them across a reset would leave
 * orphaned deltas and results with no parent message.
 *
 * `conversation_reset` itself is content under this rule, and that is load-
 * bearing twice: a *superseded* reset (below a newer one) is skipped with the
 * conversation it cleared, while the latest reset always replays (the skip is
 * strictly-below), which is what clears a reconnecting client that still holds
 * pre-reset rows.
 *
 * Lives here beside {@link transcriptActivity} for the same reason: the
 * reducer owns the rule and the runners filter with it, and the two sides may
 * not import each other. If the reducer's items-mutating set changes, change
 * this with it. Unknown/future event types are NOT content — the safe failure
 * is replaying a stale row, never withholding state.
 */
export function transcriptContent(body: SessionEventBody): boolean {
  switch (body.type) {
    case 'user_message':
    case 'assistant_message':
    case 'stream_delta':
    case 'turn_result':
    case 'execution_dispatched':
    case 'execution_result':
    case 'execution_failed':
    case 'file_delivered':
    case 'session_error':
    case 'session_closed':
    case 'conversation_reset':
      return true
    default:
      return false
  }
}

/**
 * The dedupe key for an event that is **last-write-wins** on replay, or
 * `undefined` for one that must always be delivered.
 *
 * The problem: the runner polls context usage and the plan's rate limits after
 * every turn, so a fifty-turn session's log holds fifty context readings and
 * fifty per rate-limit window. Replaying all of them is not merely wasteful —
 * it is *visible*. A client applies each in turn, so opening a session shows
 * the usage meters counting up from the session's first reading to its last
 * over the length of the replay, announcing history as if it were news.
 *
 * The fix is a backwards scan over the buffered log keeping the first
 * occurrence of each key, which is `staleReplaySeqs` in `@workerdeck/core`.
 * The key is per *window* for rate limits, not per event type: the reducer
 * stores them keyed by window ("so five_hour and seven_day updates don't
 * clobber each other"), so a single key would keep only the most recently
 * polled window and silently drop the others.
 *
 * **This is a claim about the reducer**, which is why it lives here rather
 * than in core: only the server coalesces, but only `@workerdeck/react` can
 * prove the rule correct, and neither package may import the other. The
 * property that must hold is that coalescing is *unobservable* — folding the
 * full log and the coalesced log through `applyEvent` yields identical state.
 * `packages/react/test/replay-coalesce.test.ts` asserts exactly that, over
 * every event kind. Extend the rule only with a case that test still passes.
 *
 * Three kinds are deliberately **excluded** despite looking eligible:
 *
 * - `capabilities` — `defaultModel: event.defaultModel ?? base.defaultModel`
 *   is a fallback *merge*, so a later event without one would erase an earlier
 *   event's. (It is also emitted once per session, so there is nothing to win.)
 * - `model_changed` — `undefined` means "reset to the server default" and the
 *   reducer *keeps* the last known model, so the last event alone is not the
 *   same as the fold.
 * - `system_init` — pure replace for the reducer, but the server's
 *   `watchAuthSource` reads the **first** one to decide an auth policy, and
 *   parking treats each as a resume point.
 *
 * Coalescing never drops the highest-seq event, and that is load-bearing
 * rather than incidental: the globally-last event is by definition the last of
 * its own key, so it always survives. `useClaudeSession`'s replay hold waits
 * for `state.lastSeq` to reach the attach's `session.lastSeq`, and would hang
 * on a blank panel forever if a coalescer could swallow the final event.
 */
export function replayCoalesceKey(body: SessionEventBody): string | undefined {
  switch (body.type) {
    case 'context_usage':
      return 'context_usage'
    case 'rate_limit':
      // Per window. The reducer keys `rateLimits` by `rateLimitType`; an event
      // without one is dropped by the reducer, so it has no key here either.
      return body.info.rateLimitType ? `rate_limit:${body.info.rateLimitType}` : undefined
    case 'status_changed':
      // Pure replace in the reducer. Safe only because coalescing is opt-in at
      // the WS attach: `parking.ts` subscribes from seq 0 and *branches* on
      // this event (a `parked` status triggers a park), so a coalesced log
      // handed to every subscriber would silently skip that side effect.
      return 'status_changed'
    case 'sdk_event':
      // The CLI's own liveness chatter — `{ type: 'system', subtype: 'status' }`
      // saying "requesting" — and it is the single most numerous thing in a real
      // log: 1,363 of them over 388 KB in a measured session, a ninth of the
      // whole attach payload, for a field describing what the runner was doing
      // an hour ago. Last-write-wins is the *generous* reading: the honest one
      // is that a replayed status is never true, since the only status that can
      // be is the current one.
      //
      // Narrow on purpose. `sdk_event` is the escape hatch for SDK messages this
      // protocol version does not model, and the family's standing rule is that
      // the safe failure is replaying a stale row rather than withholding state
      // — so a compaction boundary or an auth notice keeps arriving in full, and
      // only the one payload that is *by nature* transient is folded.
      return body.payload.type === 'system' && body.payload.subtype === 'status'
        ? 'sdk_event:system:status'
        : undefined
    default:
      return undefined
  }
}

/**
 * Does a **replay** have to deliver this event, or may it be dropped outright?
 *
 * The fifth of the family, and the closest relative of {@link snapshotRetains} —
 * the same claim ("no client can tell") pointed at the wire instead of at a
 * store. The difference from {@link replayCoalesceKey} is that this is not
 * last-write-wins: there is nothing to keep. These are events the reducer reads
 * and *discards*, so a replay that sends them is spending the reader's network
 * on frames whose whole effect is `return base`.
 *
 * Today that is exactly one thing, and it is the second-largest item in a real
 * attach: the `stream_delta`s the reducer does not model. Measured over one
 * 1,270-row session, the delta run was 774 KB, and **~85% of it was frames the
 * reducer throws away** — `input_json_delta` (a tool call's arguments, streamed
 * character by character, 383 KB), `signature_delta` (encrypted-thinking
 * signatures, 153 KB) and the `message_start`/`content_block_start`/`_stop`
 * scaffolding (244 KB). The reducer models two delta kinds, `text_delta` and
 * `thinking_delta`; everything else falls through its switch untouched.
 *
 * What is deliberately **not** dropped, though the arithmetic would allow it:
 *
 * - `thinking_delta` — the Claude SDK delivers thinking blocks whose `thinking`
 *   is `''`, and the reducer backfills them from the accumulated streamed text
 *   (`streamedThinking`). Dropping these erases every thought from a replayed
 *   transcript. This is the same carve-out `snapshotRetains` documents, and it
 *   is the reason that rule is provider-engine-only.
 * - `text_delta` — superseded by the `assistant_message` that follows it, which
 *   filters the streaming id and rebuilds from the full content blocks. It could
 *   go, but only with a lookahead proving the message arrived, and at 24 KB in
 *   the measured session it is not worth a rule that has to be right about
 *   supersession. A merge is likewise not worth it: a *drop* needs no synthesized
 *   event and therefore no invented seq.
 *
 * A live event is never affected — this is about the buffered replay alone — and
 * the caller must never drop the log's highest-seq event whatever this says, for
 * the reason {@link replayCoalesceKey} gives: the replay hold waits for
 * `state.lastSeq` to reach the attach's `session.lastSeq` and would hang on a
 * blank panel forever.
 *
 * The property is the family's usual one and is a test rather than an argument:
 * folding the full log and the retained log through `applyEvent` yields
 * identical state (`packages/react/test/replay-retain.test.ts`).
 */
export function replayRetains(body: SessionEventBody): boolean {
  if (body.type !== 'stream_delta') return true
  const delta = body.event as { type?: string; delta?: { type?: string } }
  if (delta.type !== 'content_block_delta') return false
  return delta.delta?.type === 'text_delta' || delta.delta?.type === 'thinking_delta'
}

/**
 * Does a `RunnerSnapshot` keep this event in its persisted log?
 *
 * The fourth of the same family, and the same shape of claim as
 * {@link replayCoalesceKey}: which events a *store* may drop without any client
 * being able to tell. It exists because a snapshot embeds the whole event log,
 * and a log is mostly stream deltas — a four-character token rides a ~180-byte
 * JSON envelope, so the delta run is tens of times the size of the text it
 * spells, sitting on disk *beside* the `assistant_message` that respells it in
 * full. That was affordable while a snapshot was written once, at a park. It is
 * not affordable written after every turn, which is what restart-survival needs.
 *
 * So: everything is retained except `stream_delta`. The reason that is safe is
 * not that deltas are unimportant but that they are **superseded by
 * construction**. The reducer upserts them under one constant id and the
 * following `assistant_message` filters exactly that id out and rebuilds from
 * the full content blocks — and a snapshot may only be taken at a rest point,
 * where the stream loop has exited and flushed. Both exits flush, including the
 * error path: an interrupted turn pushes its half-finished buffers into a
 * durable `assistant_message` before it emits the failed `turn_result`. There is
 * no rest state in which a delta is the only record of anything.
 *
 * **Provider engine only**, and this is the carve-out that must not be lost:
 * against a *Claude* log the rule would be wrong. The Claude SDK delivers
 * thinking blocks whose text is `''`, with the human-readable summary existing
 * only in the delta stream, and the reducer carries the streamed text over to
 * fill them (`transcript.ts`, the `streamedThinking` backfill). Dropping deltas
 * there would silently erase every thought from a restored transcript. Today
 * that is unreachable rather than merely avoided — only the provider engine
 * implements `park()`/`snapshot()` at all, and `#restore` refuses a snapshot
 * from another engine — but an engine that gains one inherits this obligation.
 *
 * Two properties hold it up, both of which are tests rather than arguments:
 * folding the full log and the retained log through `applyEvent` yields
 * identical state (`packages/react/test/snapshot-retain.test.ts`, the same
 * property `replay-coalesce.test.ts` asserts), and the retained log's last event
 * still carries the snapshot's own `seq`. The second matters more than it looks:
 * `transcriptActivity(stream_delta)` is 0, so the count `#restore` recomputes
 * from the log is bit-identical — a client's unread cursor cannot move — and the
 * replay hold waits for `state.lastSeq` to reach the attach's `lastSeq`, which a
 * rule that could drop the final event would hang forever.
 */
export function snapshotRetains(body: SessionEventBody): boolean {
  return body.type !== 'stream_delta'
}

/**
 * A session in an engine's on-disk store (independent of this server's registry):
 * the Agent SDK's session files, or a codex profile's CODEX_HOME threads. Listed
 * so hosts can offer "resume" across server restarts: feed `sessionId` to
 * CreateSessionRequest.resume — under a profile of the SAME engine, since the id
 * only means something to the store it came from. `GET {basePath}/sdk-sessions`
 * takes an optional `profile` query parameter naming whose store to list; absent,
 * the profile is resolved implicitly when the server declares exactly one, else
 * the Claude engine's store is listed (the pre-engine-aware behavior). Mirrors
 * the SDK's SDKSessionInfo shape, kept browser-safe.
 */
export type SdkSessionSummary = {
  sessionId: string
  /** Custom title, auto summary, or first prompt — whichever the SDK has. */
  summary: string
  /** Epoch ms of last modification. */
  lastModified: number
  createdAt?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
}

/** One deliverable in the session's scratch filesystem (see the `file_delivered` event). */
export type SessionFileInfo = { path: string; bytes: number }
/** `GET {basePath}/sessions/:id/files` — every file currently in the session's VFS.
 * `GET {basePath}/sessions/:id/files/<path>` downloads one (attachment disposition).
 * 404 when the session's engine exposes no VFS (Claude-engine sessions). */
export type ListSessionFilesResponse = { files: SessionFileInfo[] }
export type ListSessionsResponse = { sessions: SessionInfo[] }
export type CreateSessionResponse = { session: SessionInfo }
export type GetSessionResponse = { session: SessionInfo }

/**
 * Body of `PATCH {basePath}/sessions/:id` — the host-facing edits to a live
 * session. Today that is only its display name: `title` writes `meta.title`,
 * which {@link SessionInfo.title} prefers over the derived one, and `null` (or
 * an empty string) clears the override so the derived title comes back. Nothing
 * here reaches the engine — renaming does not speak to the model.
 *
 * 409 when the session is parked: a parked session has no runner to carry the
 * change, and its snapshot is the host's to rewrite, not this route's.
 */
export type UpdateSessionRequest = { title?: string | null }
export type UpdateSessionResponse = { session: SessionInfo }

/** Body of `POST {basePath}/sessions/:id/permissions/:requestId` — the REST counterpart
 * of the WS `permission_decision` command, for remote controllers without a socket
 * (e.g. answering a job's AskUserQuestion from a webhook consumer). 404 = the request
 * is unknown, already resolved, or expired. */
export type ResolvePermissionRequest =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
export type ResolvePermissionResponse = { resolved: true }

/**
 * Body of `POST {basePath}/executions/:executionId/result` — the way a deferred
 * executor (a remote worker, a batch job, a human) delivers the outcome of an
 * execution the session parked on. The session is rehydrated if its runner was
 * torn down, and the result is folded back into the agent loop; a `failed` result
 * is ordinary tool output the agent adapts to, not a session error.
 *
 * Applied **idempotently by `executionId`**: a duplicate or late delivery (one
 * racing the execution watchdog) answers 200 with `applied: false` rather than
 * erroring or applying twice. 404 means no session is parked on that id.
 */
export type SubmitExecutionResultRequest =
  | { status: 'ok'; output: ToolExecutionOutput; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }
export type SubmitExecutionResultResponse = {
  /** False when the id was already settled — the delivery was a no-op. */
  applied: boolean
  /** Session the execution belonged to. */
  sessionId: string
}

export type ListSdkSessionsResponse = { sdkSessions: SdkSessionSummary[] }
/** `GET {basePath}/profiles` — filtered to the profiles the caller may use. */
export type ListProfilesResponse = {
  profiles: ProfileInfo[]
  /** Whether this caller may create profiles here — true only when the server has
   * a profile store AND the principal carries `canManageProfiles`. Lets a UI hide
   * controls that would always be refused. */
  canManage?: boolean
}

/**
 * `POST {basePath}/profiles` — create a managed profile. Available only when the
 * server was given a profile store, and only to a principal with
 * `canManageProfiles`. Profiles declared in server options are code, not data:
 * they cannot be created, edited, or deleted through these routes.
 */
export type CreateProfileRequest = ProfileInfo

/** `PATCH {basePath}/profiles/:name` — merge into a managed profile. The name is
 * the route, not the body; pass `null` to clear an optional field. */
export type UpdateProfileRequest = Omit<Partial<ProfileInfo>, 'name'>

// ---------------------------------------------------------------------------
// Host filesystem (`{basePath}/fs/*`)
// ---------------------------------------------------------------------------

/**
 * The **host's real project tree**, not a session's in-memory VFS — the two are
 * unrelated despite both being "files". {@link SessionFileInfo} is a deliverable
 * the agent produced inside a session; these routes read and write the operator's
 * actual disk.
 *
 * That makes them **operator-privileged**: they are authorized by the server's auth
 * key alone and deliberately sit outside the agent permission flow, because the
 * caller *is* the operator, not the model. A client holding the key can already
 * start a session with any allowed cwd; browsing that same tree grants it nothing
 * new. Writing does, which is why writes are separately enabled server-side.
 *
 * The whole surface is opt-in and root-scoped: with no roots configured every route
 * below 404s. There is no "unset means anything" default here — a phone on a tailnet
 * must never be one request away from `~/.ssh`.
 */
export type HostFileRoot = {
  /** Absolute, canonical (symlinks resolved) path of the root. */
  path: string
  /** Last path segment, for display — roots are not named by the operator. */
  name: string
}

/** `GET {basePath}/fs/roots` — where a client may start browsing. Empty `roots`
 * never happens: the routes are absent entirely when none are configured. */
export type ListHostRootsResponse = {
  roots: HostFileRoot[]
  /** Whether `PUT /fs/write` is enabled here; lets a UI hide an editor it can't save from. */
  canWrite: boolean
}

/** One entry in a host directory listing. Classified with `lstat` semantics, so a
 * `symlink` is reported as itself and never silently resolved — following it is the
 * *next* request's problem, and that request is refused if it escapes the roots. */
export type HostDirEntry = {
  name: string
  /** Absolute path, ready to pass back as `?path=`. */
  path: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  /** Regular files only. */
  bytes?: number
  /** Epoch ms mtime. */
  modifiedAt?: number
}

/** `GET {basePath}/fs/list?path=<abs>` — one directory, not recursive. */
export type ListHostDirResponse = {
  /** Canonical path actually listed (the request's path after symlink resolution). */
  path: string
  /** Directories first, then files, each alphabetical. */
  entries: HostDirEntry[]
  /** Set when the directory held more entries than the server will return. */
  truncated?: boolean
}

/** One hit from `GET {basePath}/fs/find`. */
export type HostFileMatch = {
  /** Absolute path, for a follow-up read. */
  path: string
  /** Path relative to the searched directory — what a picker shows and inserts. */
  relative: string
}

/**
 * `GET {basePath}/fs/find?path=<dir>&q=<query>&limit=<n>` — recursive fuzzy file
 * search under one directory, which is what an `@file` picker needs and
 * `/fs/list` is not: listing answers "what is in this directory", this answers
 * "which file in this tree did you mean".
 *
 * Subsequence matching (`seslist` finds `SessionListView.swift`), filename hits
 * ranked above path hits, shallow files above deep ones. An empty `q` returns the
 * shallowest files. Build directories (`.git`, `node_modules`, …) are skipped, as
 * is anything behind a symlink — so every path returned is one `/fs/read` will
 * accept.
 */
export type FindHostFilesResponse = {
  /** Canonical directory the search ran under; `relative` paths are relative to it. */
  base: string
  matches: HostFileMatch[]
  /** More matched, or the tree was larger than the server would walk. */
  truncated: boolean
}

/** `GET {basePath}/fs/read?path=<abs>` — one file's contents. Binary files come back
 * base64; 413 rather than a truncated read when the file exceeds the server's cap. */
export type ReadHostFileResponse = {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  bytes: number
  /** sha256 (hex) of the bytes on disk. Pass it back as `expectedHash` to write. */
  hash: string
  modifiedAt: number
}

/**
 * `PUT {basePath}/fs/write` — replace or create one file.
 *
 * The agent is editing this same tree, so a write is **conditional, always**:
 * `expectedHash` must be the hash from the read this edit is based on, and the
 * server 409s if the file has changed since. Omitting it means "create" and 409s
 * if the path already exists — there is no unconditional overwrite, by design.
 * Directories are never created implicitly: writing under a missing parent is a 404.
 */
export type WriteHostFileRequest = {
  path: string
  content: string
  /** Default 'utf8'. */
  encoding?: 'utf8' | 'base64'
  /** Required to overwrite; omit only to create a new file. */
  expectedHash?: string
}

export type WriteHostFileResponse = {
  path: string
  bytes: number
  /** Hash of what was just written — carry it into the next edit. */
  hash: string
  modifiedAt: number
}

export type SaveProfileResponse = { profile: ProfileInfo }
/** `GET {basePath}/profiles/:name` — the profile plus a fresh config snapshot. */
export type GetProfileResponse = { profile: ProfileInfo; config: ProfileConfigSnapshot }
export type ErrorResponse = { error: string }

// ---------------------------------------------------------------------------
// Session notifications (the out-of-band "something wants you" channel)
// ---------------------------------------------------------------------------

/**
 * The moments in an *interactive* session a person needs to hear about when they
 * are not watching it — the whole point being that a phone cannot hold a
 * WebSocket open in the background, so the server has to reach out.
 *
 * Deliberately four: this is a human-attention channel, not an event mirror. The
 * event log stays on the session WS (attach with `afterSeq` to catch up); if you
 * want every assistant message, subscribe there instead.
 */
export type SessionNotificationType =
  /** The agent is blocked on an approval — the one that matters most. */
  | 'permission_requested'
  /** A turn finished; the session is idle and waiting for the human. */
  | 'turn_completed'
  /** The session failed (`session_error`). */
  | 'session_error'
  /** The session ended (`session_closed`), whoever ended it. */
  | 'session_closed'

/** One delivery on the session-notification channel (JSON body of a webhook POST). */
export type SessionNotification = {
  type: SessionNotificationType
  sessionId: string
  /** Snapshot at notification time — status, title, cwd, cost, `lastSeq`. */
  session: SessionInfo
  /** Seq of the event behind this notification; attach with `afterSeq: seq - 1` to
   * land on it. */
  seq: number
  ts: number
  /** One line fit for a notification body: the permission title, the turn's final
   * text, the error message. */
  preview?: string
  /** `permission_requested` only: the full request, so a consumer can answer it via
   * `POST {basePath}/sessions/:id/permissions/:requestId` — which is what makes an
   * Approve/Deny action on a lock-screen notification possible. */
  request?: PermissionRequest
  /** `turn_completed` only. */
  result?: { isError: boolean; durationMs: number; numTurns: number; totalCostUsd: number }
  /** `session_closed` only. */
  reason?: 'client' | 'server' | 'error'
}

/** Where session notifications are POSTed (JSON body = {@link SessionNotification}).
 * Server-wide, not per session: the point is to hear about sessions you did not
 * create yourself and are not attached to. */
export type SessionWebhookConfig = {
  url: string
  /** Extra headers sent with every delivery (auth tokens etc.). */
  headers?: Record<string, string>
  /** Types to deliver. Default: all of them. */
  events?: SessionNotificationType[]
}

// ---------------------------------------------------------------------------
// Job queue (one-shot scheduled runs over the session runner)
// ---------------------------------------------------------------------------

/**
 * - `queued` — accepted, waiting for a concurrency slot (or the daily token budget)
 * - `running` — a session is executing the prompt
 * - `parked` — waiting on an external event (a deferred tool execution). Not
 *   terminal and not consuming a concurrency slot; resumes to `running` when the
 *   result arrives, or fails via the execution watchdog if it never does.
 * - `succeeded` / `failed` — terminal; `result` (and `error` on failure) are set
 * - `canceled` — terminal; canceled by a client before or during the run
 */
export type JobStatus = 'queued' | 'running' | 'parked' | 'succeeded' | 'failed' | 'canceled'

/** Where job progress/completion deliveries are POSTed (JSON body = {@link JobEvent}). */
export type WebhookConfig = {
  url: string
  /** Extra headers sent with every delivery (auth tokens etc.). */
  headers?: Record<string, string>
  /** Delivery granularity: 'messages' also POSTs job_progress per assistant message /
   * permission request; 'completion' only job_started + job_completed. Default 'messages'. */
  progress?: 'messages' | 'completion'
}

/**
 * Schedule a one-shot run: the session executes `prompt` unattended and the job
 * completes with that run's result. `session.prompt` is the task and is required;
 * `resume`/`forkSession` are not supported for queued jobs.
 */
export type CreateJobRequest = {
  session: CreateSessionRequest & { prompt: string }
  webhook?: WebhookConfig
  /** Per-job token cap; the effective cap is min(this, the server's sessionTokenLimit). */
  maxTokens?: number
  /** Per-job wall-clock cap; the effective cap is min(this, the server's maxJobDurationMs). */
  maxDurationMs?: number
  /** Total run attempts: failed (not canceled) runs re-queue until this many attempts
   * have been made. Default 1 (no retries). */
  attempts?: number
  /** Delay before the first retry, doubled for each subsequent one. Default 5000. */
  retryDelayMs?: number
  /** Host bookkeeping echoed back on JobInfo. */
  meta?: Record<string, unknown>
}

/** Cumulative resource usage of a job's run. `tokens` counts input + output +
 * cache-creation + cache-read tokens across all turns. */
export type JobUsage = {
  tokens: number
  totalCostUsd: number
  numTurns: number
}

/** Terminal outcome of the job's run (mirrors the final turn_result). */
export type JobResult = {
  subtype: string
  isError: boolean
  /** Final text of the run (success only). */
  result?: string
  errors?: string[]
  durationMs: number
}

export type JobInfo = {
  id: string
  status: JobStatus
  /** `''` when the run's engine has no host filesystem (see
   * {@link CreateSessionRequest.cwd}). */
  cwd: string
  /** Profile the run executes under (resolved name, present even when implicit). */
  profile?: string
  prompt: string
  /** Server session id once started — attach via the sessions WS to watch the run live. */
  sessionId?: string
  sdkSessionId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** 1-based run attempt this info reflects. */
  attempt?: number
  /** Total attempts configured on the request (see CreateJobRequest.attempts). */
  maxAttempts?: number
  /** For a job re-queued by retry backoff: earliest time the next attempt may start. */
  nextRunAt?: number
  /** Set while `status` is 'parked': when the run parked, and the execution it is
   * waiting on — the id to POST a result to. Cleared when it resumes. */
  parkedAt?: number
  parkedExecutionId?: string
  /** Cumulative across attempts. */
  usage: JobUsage
  result?: JobResult
  /** Failure or cancellation reason (for a queued retry: the previous attempt's error). */
  error?: string
  meta?: Record<string, unknown>
  /** Scope tags of the session this job runs (see
   * {@link CreateSessionRequest.scope}) — copied from the request at submit so
   * the job routes can be gated by the same rule as the session routes. Without
   * it the queue would be a side door into an unscoped session. */
  scope?: Record<string, string>
}

/** Latest mid-run activity, carried on job_progress deliveries. */
export type JobProgress = {
  kind: 'assistant_text' | 'tool_use' | 'permission_requested' | 'permission_resolved'
  /** Short human-readable preview (message excerpt, tool name, permission title). */
  preview?: string
  /** 'permission_requested' only: the full request (including AskUserQuestion input) so
   * webhook consumers can answer via POST /sessions/:sessionId/permissions/:requestId. */
  request?: PermissionRequest
}

/** Webhook delivery payload (also the queue's local event shape). `job_submitted` goes
 * to local observers and the queue WS only — the submitter already has the POST
 * response, so webhooks start at `job_started`. `job_retrying` marks a failed run that
 * was re-queued (`job.nextRunAt` says when); `job_completed` is always terminal. */
export type JobEvent =
  | { type: 'job_submitted'; job: JobInfo; ts: number }
  | { type: 'job_started'; job: JobInfo; ts: number }
  | { type: 'job_progress'; job: JobInfo; progress: JobProgress; ts: number }
  /** The run parked on a deferred execution; `executionId` says what it waits on —
   * the id to POST a result to. The *work itself* (tool name, input, VFS seed) went
   * to the executor's own dispatch hook, not over this channel: a webhook consumer
   * learns that a run is waiting, the worker learns what to do. */
  | { type: 'job_parked'; job: JobInfo; executionId: string; ts: number }
  /** A parked run resumed because its execution result arrived. */
  | { type: 'job_resumed'; job: JobInfo; executionId: string; ts: number }
  | { type: 'job_retrying'; job: JobInfo; ts: number }
  | { type: 'job_completed'; job: JobInfo; ts: number }

export type QueueStats = {
  maxConcurrency: number
  running: number
  queued: number
  /** Jobs waiting on a deferred execution. They hold no concurrency slot and
   * their wall-clock budget is not ticking. */
  parked: number
  sessionTokenLimit?: number
  dailyTokenLimit?: number
  /** Tokens consumed by queue jobs in the current UTC day. */
  dailyTokensUsed: number
  /** True when the daily budget is exhausted and queued jobs are being held. */
  paused: boolean
}

/** Frames sent on the queue WS (`{basePath}/queue/ws`). The stream is one-way
 * (server→client): every job's lifecycle as it happens, plus refreshed stats after
 * lifecycle changes. Clients send nothing; job mutations stay on REST. */
export type QueueServerFrame =
  | { type: 'queue_attached'; protocolVersion: number; stats: QueueStats }
  | { type: 'job_event'; event: JobEvent }
  | { type: 'queue_stats'; stats: QueueStats }

export type CreateJobResponse = { job: JobInfo }
export type GetJobResponse = { job: JobInfo }
export type ListJobsResponse = { jobs: JobInfo[] }
export type QueueStatsResponse = { stats: QueueStats }

export * from './session-list.ts'
export * from './usage.ts'
export * from './watermarks.ts'
