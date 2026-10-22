---
title: Protocol
description: The wire protocol - events, commands, REST shapes, queue frames, versioning, and forward compatibility.
order: 2
---

[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) is the wire
protocol shared by the server and every client: typed session events, commands, and REST shapes.
Dependency-free and browser-safe - it depends on nothing, and everything depends on it. Anthropic
API message content is modeled structurally (`ApiMessage`, `ContentBlock`) so browsers can render
transcripts without the Agent SDK.

Most of it is types. The runtime exports are the few things both sides must agree on rather than
each guess: `PROTOCOL_VERSION`, the per-engine `ENGINE_CAPABILITIES` records, and the shared
**rules** - `transcriptActivity`, the [sessions-list view model](#the-shared-view-models) and the
[unread model](#the-shared-view-models). They live here because a client that computed them
differently would disagree with the server about what it is showing.

## The model

One session = one ordered stream of `SessionEvent`s, each stamped with a monotonically
increasing `seq` (starting at 1) and an epoch-ms `ts`, plus a small `SessionCommand` set.
Clients attach over WebSocket, optionally replaying from a known `seq`, and drive the session
with commands.

A session keeps one **stable id** for its whole life, and that id is the only address a client
needs. What changes under it is the **conversation**: `SessionInfo.conversation` counts from 1, and
*New conversation* (a typed `/clear`, the `clear_context` command, an agent's `context_reset`)
starts conversation n+1 under the same id. A number is never reused, not even after an erase. A
past conversation stays readable from the engine's own store (see [Conversations](#conversations)).

A session may be **named**: `SessionInfo.agent` (an `AgentRef`: name, avatar, team) is what every
client calls an agent. Naming and un-naming are a `PATCH` on the same id, so an agent is a session,
optionally named, and never a second record.

`SessionAddress` (`{ id, conversation? }`) is where a view points: absent `conversation` is the
current one, which a cut moves on under the same address; a number is a read-only past
conversation. `addressKey`, `sameAddress`, `addressOf` and `isHistorical` are the helpers.

## Versioning and skew detection

`PROTOCOL_VERSION` (currently `2`, since WorkerDeck 4.0.0) is bumped on any breaking change to
events, commands, or REST shapes. The server reports it in the `attached` (and `queue_attached`)
frame so clients can detect skew:

```ts
import { PROTOCOL_VERSION, type ServerFrame } from '@workerdeck/protocol'

ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data) as ServerFrame
  if (frame.type === 'attached' && frame.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('protocol mismatch')
  }
}
```

## Events (server → client)

`SessionEventBody` variants:

| Event | Meaning |
| --- | --- |
| `system_init` | SDK init handshake: `sdkSessionId`, `model`, `cwd`, `apiKeySource`, tools, skills, slash commands, `permissionMode`, CLI version, MCP servers. |
| `status_changed` | `SessionStatus` transition (`starting`, `running`, `awaiting_approval`, `idle`, `parked`, `failed`, `closed`) with optional detail. `parked` means the session is waiting on a deferred execution - non-terminal, and the host's cue to snapshot it. |
| `capabilities` | Models (`ModelOption[]`) and slash commands (`SlashCommandInfo[]`) available to the session, fetched from the CLI after init, plus `defaultModel` - the wire id this session's default resolves to, which is how a client can name the running model before the first turn. The model list is shaped server-side: the CLI's own `default` row is dropped (it is a choice, not a model), each row is named from its resolved id, and `primary` marks the newest of each family so a picker can file the rest under "more models". |
| `model_changed` | Model switched via `set_model`; `model` undefined = back to default. |
| `effort_changed` | `effort: string \| null` - the reasoning effort the engine sends on its next request, after the engine's own clamping and defaults; `null` means the current model takes none. Mirrors `SessionInfo.effort` (absent there = not known yet). Emitted at start, on `set_effort`, and when a model switch moves it. Coalesced to the latest on replay. |
| `permission_mode_changed` | Mode switched via `set_permission_mode`. |
| `context_usage` | Context-window snapshot (`ContextUsage`), polled after each turn. |
| `rate_limit` | Subscription rate-limit window update (`RateLimitInfo`). API-key sessions may never emit one - render nothing, not 0%, and treat an absent `utilization` as unknown. |
| `plan_info` | Which claude.ai plan those windows belong to (`subscriptionType`: 'pro', 'max', …). Emitted from the same poll as `rate_limit`, once per change, and never for an API-key session. |
| `engine_sleep` | `asleep: boolean` - the engine process was stopped (`true`) or started again for a message (`false`), while the session stayed live. Mirrors `SessionInfo.engineAsleep`. Coalesced to the latest on replay; not transcript activity. Offered where `EngineCapabilities.engineSleep` is true. |
| `assistant_message` / `user_message` | An `ApiMessage` (plain Anthropic content blocks) plus `parentToolUseId`, `replay` (resumed-history backfill), and for user messages `synthetic` (tool results), `attachments`, and `origin` (absent for the human; `{ kind: 'peer', sessionId, name?, engine?, hops? }` when another session sent it through `peers_send`). The last is deliberately a list of **references** (`MessageAttachment`: id, name, media type, size) and never the bytes: this log is replayed to every attaching client and captured into parking snapshots, so an inlined photo would be paid for on every attach, forever. Fetch `GET /v1/sessions/:id/attachments/:id` to render one. |
| `stream_delta` | Raw Anthropic streaming event; emitted only with `includePartialMessages`. |
| `turn_result` | End of a turn: subtype, `isError`, `durationMs`, `numTurns`, `totalCostUsd` (both session-cumulative), `result` text, per-turn `usage`. |
| `permission_requested` / `permission_resolved` | The pending-approval flow - see [Permissions](/workerdeck/docs/guides/permissions/). |
| `execution_dispatched` / `execution_result` / `execution_failed` | Tool-execution lifecycle, correlated by `executionId`. `deferred: true` on dispatch means the execution may outlive the runner (the session parks); `expiresAt` is when the host's watchdog fires. A failure is fed back as tool output, not a session error. |
| `skills` | The skills this session can reach (`SkillInfo[]`), listed after init. Drives the `/` composer completion and the skills panel. |
| `tool_titles` | Human-readable labels for tool calls, keyed by wire name: what the host declared and what each MCP server calls its own tools. Built-in capability names resolve client-side; a tool with no title anywhere keeps its wire name. |
| `file_delivered` | The agent handed over a file from its scratch filesystem (`deliver_file`); download it under `GET /sessions/:id/files/<path>`. |
| `file_produced` | The **engine** wrote a file on the *host* filesystem and reported the path - codex's `image_gen` saving a PNG is the case that motivated it. The host-filesystem sibling of `file_delivered`. Carries an opaque `fileId`, the absolute `path` as the engine reported it, and a media type where the runner could determine one; fetch it at `GET /sessions/:id/produced/:fileId`. This event **is** the allowlist for that route - nothing else can add a path to it. |
| `sdk_event` | Forward-compatible passthrough for any SDK message this protocol version doesn't model first-class (task progress, compaction boundaries, auth status, …). |
| `conversation_reset` | A runner used **without a gateway** cleared its conversation in place: same session id, empty context, carrying the engine session id the fresh conversation runs under when the engine reported one. A re-attach skips transcript *content* strictly below the latest reset while every state-bearing event still replays. On a gateway every clear is a cut to a new conversation instead (see [Conversations](#conversations)), announced by the `conversation_started` frame, not by this event. |
| `session_error` / `session_closed` | Terminal errors and closure (`reason: 'client' | 'server' | 'error'`). |

## Commands (client → server)

`SessionCommand` variants: `user_message` (`text`, plus optional `attachmentIds` naming files
uploaded ahead of it), `permission_decision` (`requestId`,
`behavior: 'allow' | 'deny'`, allow-only `updatedInput`, deny-only `message`/`interrupt`),
`interrupt`, `set_permission_mode`, `set_model` (omit `model` for the default),
`set_effort` (omit `effort` for the model's default; a level the model does not offer is a
`protocol_error`; claude and codex only, from the next request on),
`clear_context`, `sleep` (stop the engine process, keep the session; refused with a
`protocol_error` unless it is idle, see `POST /v1/sessions/:id/sleep`), `close`, and the two answers to a bridged tool call - `tool_call_result` /
`tool_call_error`, each carrying the `executionId` it is answering.

`clear_context` asks for a new conversation. On a gateway it is the same cut as *New
conversation*, and so is a `user_message` whose whole text is `/clear` with nothing attached
(anything longer is ordinary text for the engine). Sent while a turn is running it **queues**
behind that turn rather than cutting it short: a clear is not an interrupt. A gateway offers it on
every session that is not closed or failed (`clearContextOffered`), whatever the engine;
`EngineCapabilities.clearContext` describes a runner used without a gateway, which keeps each
engine's own clear (Claude's `/clear`, a fresh codex thread, the provider engine dropping its message array) and
answers with `conversation_reset`.

### WebSocket framing

The server sends `attached` (protocol version + `SessionInfo` snapshot + `replayingFrom`), then
`event` frames, with `protocol_error` for bad input. The client sends `ClientFrame`s: a
`SessionCommand` plus **`generation`**, the conversation the sender meant (the `conversation` of
the snapshot it attached to). A command without one, or for a conversation that has ended, is
refused with a `protocol_error` and never applied to the next conversation. `shell_attach` and
`shell_detach` are the only commands that need no `generation`. `@workerdeck/client` stamps it for
you.

- **`ack`.** Every gateway answers a `user_message` that carries a `clientId` with
  `{ type: 'ack', clientId }` once the prompt was handled, and runs a repeated `clientId` once, so a
  client may resend an unacked prompt after a reconnect. `notDelivered: true` means it was refused
  before the engine saw it (its conversation ended, a cut was in flight, a refusal): the text is
  the sender's to resubmit. `uncertain: true` means this resend was refused and whether an earlier
  attempt ran is no longer known; the sender decides.
- **`conversation_started`** (`{ conversation, epoch }`) is sent on the old conversation's socket
  once a cut has committed; the server then closes that socket with code `4011`
  (`CONVERSATION_ENDED_CLOSE_CODE`). Reattach to the same id to follow the new conversation. A
  client that missed the frame reads the current number from the next `attached` or list.
- **`?conversation=n`** on the attach URL opens a **read-only** socket on past conversation n: an
  `attached` frame and that conversation's events, read from the engine's store, and no commands.
  It never falls through to the current conversation.

Two further server frames belong to the browser tool bridge:
`tool_call_request` (execute this tool in your own sandbox - `toolName`, `input`, an optional
`vfsSeed` and `limits`, and an `expiresAt` after which the server gives up) and
`tool_call_canceled` (abandon it; the turn was interrupted, it timed out, or the session closed).
Only sandbox-benefiting tools are ever bridged - authoritative ones (MCP, secret-bearing APIs)
execute server-side and never appear on this channel.

An attach to the current conversation is **full control, not a read level**: a client holding
one can send `user_message`, `permission_decision`, `interrupt` and `close`. Anything that decides
who may watch a session must decide it before the attach, not after. Only the `?conversation=n`
history socket is read-only.

## REST shapes

- `CreateSessionRequest` - `profile` (which engine and config this runs as), `cwd`, `prompt`,
  `permissionMode`, `allowDangerouslySkipPermissions`, `allowedTools`/`disallowedTools`,
  `mcpServers` (`McpServerConfigWire`: stdio/http/sse), `settingSources`, `model`,
  `reasoningEffort`, `maxTurns`, `maxBudgetUsd`, `resume`/`forkSession`, `capabilities`,
  `includePartialMessages`, `approvalTimeoutMs`, `questionBehavior`, `meta`, `scope`.
  `cwd` is **optional**, not required: an engine whose capability record clears `hostCwd` (the
  provider engine) has no host directory to name, and for it `allowedCwdRoots` is not the
  boundary. The gateway rejects fields the chosen engine's capability record forswears rather
  than accepting them into a silent no-op; `forkSession` is honoured only where
  `EngineCapabilities.forkSession` is true (the claude engine). `mcpServers` is accepted where
  `sessionMcpServers` is true (claude, and codex for stdio and `http`, never `sse`), and
  `allowedTools`/`disallowedTools` as far as `toolFilters` says: `'all'` (claude), `'mcp'` (codex,
  `mcp__<server>__<tool>` or `mcp__<server>` only) or `'none'` (provider, refused).
- `SessionInfo` - server id (≠ `sdkSessionId`), status, cwd, `profile`, `engine` and its
  `capabilities` record, model, permission mode, `canBypassPermissions` (fixed at creation: the
  CLI refuses to *switch into* bypass unless the process was spawned for it, so a picker can
  disable the mode rather than offer a refusal), `apiKeySource`, `lastSeq`,
  `pendingPermissionCount`, `title`, cumulative `totalCostUsd` / `numTurns`, `activityCount`,
  `lastActivityAt`, `scope`, `owner`, `subagents`, `conversation` (the current conversation's
  number, the token every mutation names), `agent` (present on a named session), and `project` - the `.workerdeck.json` name/root/icon
  the *gateway* resolved by an ancestor walk from the session's realpath'd cwd, since no client
  can see that filesystem. Its icon is an **address** (a glyph name, or a media type plus a
  content hash whose bytes come from `GET /sessions/:id/project/icon`), never bytes: this record
  rides every row of a 1.2s poll. Absent means no project; see the
  [Project identity](../../guides/projects/) guide.
- `UpdateSessionRequest` - the `PATCH /sessions/:id` body. `title` is **three-state**: a string
  sets `meta.title`, an explicit `null` clears it so the derived title (the first prompt) comes
  back, and omitting it leaves the name alone. A rename never reaches the model. `statusLabel`
  sets or clears the one-line status. `agent` (`SessionAgentRequest`: name, brief, lead, owner,
  sharing, ...) names the session or updates a named one's identity, and `agent: null` un-names it
  (operator only; refused while it leads or belongs to a team). `config` (`SessionSettingsPatch`:
  `cwd`, `profile`, `model`, `reasoningEffort`, `permissionMode`, `agentContextReset`) sets what the
  **next** conversation starts from, never the running one; the response then carries `settings`.

## Conversations

Every mutation names the conversation it was meant for, so a call that raced a cut is refused
rather than landing on the next conversation (409 `the session moved on to conversation n`):

- **Ordinary session mutations** (every `PATCH`, `DELETE` and `POST` under `/sessions/:id/`
  outside `/conversations`: permission answers, uploads, sleep, shells, tasks, MCP actions) carry
  the `x-workerdeck-generation` header (`GENERATION_HEADER`) set to the session's current
  `conversation`. Missing or stale: 409.
- **The conversation POSTs** (`/sessions/:id/conversations`, `…/discard`, `…/retry`, `…/pending`)
  require `expectedGeneration` in the body instead (missing: 400, stale: 409), and so does
  `DELETE /agents/:id`.
- **`DELETE /sessions/:id/conversations/:n`** names its conversation by the path `n` and needs
  neither.
- **WebSocket:** `generation` on every command (above).

`WorkerDeckClient` tracks the last conversation it saw for each session (`conversationOf`) and
sends the header and the WebSocket `generation` for you. It does not infer `expectedGeneration`:
pass it explicitly to `newConversation`, `discardAndCut`, `retryConversationStart`,
`settlePendingPrompt` and the agent methods.

| Route | Body / answer |
| --- | --- |
| `GET /sessions/:id/conversations` | `ConversationsResponse`: the current `conversation`, `history` (one `ConversationSummary` per past conversation: `n`, engine, profile, cwd, title, cost, times, `transcript: 'unavailable'` on an entry already marked so, by an erase or an earlier failed read; a transcript the engine has since pruned shows only when the entry is opened), `closed`, a `pendingPrompt` or `startFailed` waiting on a person, and the `settings` the next conversation starts from. |
| `GET /sessions/:id/conversations/:n` | `ConversationHistoryResponse`: that conversation's `info` and `events`, read from the engine's own store. |
| `POST /sessions/:id/conversations` | `NewConversationRequest` (`expectedGeneration`, optional first `prompt`, optional `target`: profile, cwd, model, scope) starts conversation n+1; answers `NewConversationResponse` (`session`, `conversation`). 409 while the session is busy or still starting, and on a job run. |
| `POST /sessions/:id/conversations/discard` | `DiscardAndCutRequest` (`expectedGeneration`, `inputRevision`, `prompt?`): the same cut after a person accepted losing pending input. |
| `POST /sessions/:id/conversations/retry` | `{ expectedGeneration }`: start a conversation that was committed but did not start (`startFailed`). |
| `POST /sessions/:id/conversations/pending` | `SettlePendingPromptRequest` (`expectedGeneration`, `send`): Send again or Dismiss a first message whose delivery is uncertain. |
| `DELETE /sessions/:id/conversations/:n` | Operator only: forget the gateway's copy of a past conversation (`EraseConversationResponse`). n stays, marked unavailable; the engine's store is never touched. |

Two 409 refusals carry a body a client acts on:

- **`unconfirmed_input`** (`UnconfirmedInputRefusal`): the engine cannot confirm that input queued
  for it was consumed. The body names the `conversation`, an `inputRevision`, how many messages are
  pending (`pendingInput`) and whether some may come from peer agents (`mayIncludePeer`). Show that
  to a person; if they accept losing it, send `discard` with the same `inputRevision`. Input that
  arrived since answers `input_changed` and must be confirmed again. `unconfirmedInputOf(error)` in
  `@workerdeck/client` reads it from a `WorkerDeckError`.
- **`uncertain_prompt`** (`UncertainPromptRefusal`): a first message may not have reached the
  session; settle it with `pending` before starting another conversation.

`(sessionId, conversation)` is the key to correlate audit and usage records: the `SessionInfo` on
every `attached` frame, list row, notification and webhook carries both.

### Session scope

`scope` is a bag of opaque string tags, assigned at create and immutable within one conversation:
an operator's *New conversation* may set a new scope (`target.scope`) for the conversation it
starts, and every past conversation keeps the scope frozen at its cut. It is the only
intra-deployment scoping primitive in the protocol, and the split is deliberate: WorkerDeck
stores and *enforces* the tags, and the embedder's `authorizeSession(principal, session)` decides
what they mean - `{ user, space }` is one app's vocabulary and the next has tenants. A principal
that fails the check gets **404, never 403**: a 403 confirms the session exists.
`JobInfo.scope` carries the same tags through the queue. See
[Embed WorkerDeck in your app](/workerdeck/docs/guides/embed-in-your-app/) for the policy half.

### Capability records

`EngineCapabilities` is what a client renders from, and `ENGINE_CAPABILITIES` pins one record per
engine (`claude`, `codex`, `provider`) as a runtime constant, so an affordance an engine lacks is
*hidden* rather than shown as a control that silently does nothing. It is also the gateway's
request filter: a create request naming something the record forswears is a 400. Every
`SessionInfo` carries its session's record, and the server serves each profile's record, its
static model catalog and its credential-availability verdict from the first request - a real
model picker with no warm-up session needed.
- `ResolvePermissionRequest` - the REST counterpart of the `permission_decision` command.
- `SubmitExecutionResultRequest` / `SubmitExecutionResultResponse` - a deferred executor delivering
  its outcome (`{ status: 'ok', output } | { status: 'failed', reason, error }`). Applied
  idempotently by `executionId`; the response's `applied: false` means it was already settled.
- `ListSessionFilesResponse` / `SessionFileInfo` - the session's deliverables.
- `SdkSessionSummary` - the Agent SDK's on-disk sessions, listed to offer resume.
- Response wrappers: `ListSessionsResponse`, `CreateSessionResponse`, `GetSessionResponse`,
  `ResolvePermissionResponse`, `ListSdkSessionsResponse`, `ErrorResponse`.
- `SessionNotification` / `SessionNotificationType` / `SessionWebhookConfig` - the out-of-band
  channel for a person who isn't attached (`permission_requested`, `turn_completed`,
  `session_error`, `session_closed`), carrying the `SessionInfo` snapshot, the event's `seq`, a
  one-line `preview`, and - on a permission - the full request to answer over REST. See
  [Notifications](/workerdeck/docs/guides/notifications/).

## The shared view models

Three rules ship here as code rather than as prose each client re-implements, because a client
that computed them differently would announce work it is hiding - or hide work it is announcing.

**`transcriptActivity(event)`** is the row-count rule: how many transcript rows an event is worth.
The React reducer renders by it and the runners count with it (`SessionInfo.activityCount`).
Change one, change both.

**`session-list.ts`** is the sessions-list view model. Sessions bucket into four states -
`attention`, `working`, `idle`, `ended` (`sessionState`) - and the list is filtered, grouped and
sorted along three facets: gateway, adapter and state. `filterRows` / `groupRows` /
`subsetSummary` / `clearFilters` are the operations, `ViewConfig` is the persisted shape, and
`subsetSummary` is what lets a client say *"12 of 30"* and name the cause instead of silently
showing a short list. Workspace scope has one non-obvious containment rule: a scope root tagged
with a gateway scopes **only** that gateway, and an untagged one scopes **only** loopback -
because a remote gateway's identical-looking path is another machine's directory.

**`watermarks.ts`** is the unread model: monotonic marks behind a `WatermarkStore` seam (so a
host supplies `localStorage`, VS Code's `globalState`, or `UserDefaults`), and `unseenCount`'s
arithmetic in **prose** (`SessionInfo.proseCount`): a session that runs forty tools and says
nothing badges zero. Monotonic matters: without it a context compaction
resurrects rows the reader already read.

The dashboard, the VS Code extension and the iOS app all render from these; the Swift mirrors are
`SessionList.swift` and `Watermarks.swift` in `WorkerDeckKit`.

## Queue frames

Used when the server mounts the [`@workerdeck/queue`](https://www.npmjs.com/package/@workerdeck/queue)
routes: `CreateJobRequest` / `JobInfo` (with `JobStatus`, `JobUsage`, `JobResult`) /
`JobEvent` (`job_submitted`, `job_started`, `job_progress` + `JobProgress`, `job_parked`,
`job_resumed`, `job_retrying`, `job_completed`) / `QueueStats`, and the `QueueServerFrame` union for the one-way queue
WebSocket (`queue_attached`, `job_event`, `queue_stats`). Details in
[Job queue](/workerdeck/docs/guides/job-queue/).

## Forward compatibility

Deliberate patterns so older clients keep working as the SDK grows:

- Unknown content blocks fall back to `UnknownBlock` (`{ type: string, … }`).
- Unions the SDK may grow (`apiKeySource`, rate-limit `status`/`rateLimitType`) stay `string`.
- Unmodeled SDK messages ride through as `sdk_event` rather than breaking older clients - the
  rule is to promote what UIs need to first-class events instead of parsing payloads
  client-side.
