---
title: Protocol
description: The wire protocol — events, commands, REST shapes, queue frames, versioning, and forward compatibility.
order: 2
---

[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) is the wire
protocol shared by the server and every client: typed session events, commands, and REST shapes.
Dependency-free and browser-safe — it depends on nothing, and everything depends on it. Anthropic
API message content is modeled structurally (`ApiMessage`, `ContentBlock`) so browsers can render
transcripts without the Agent SDK.

Most of it is types. The runtime exports are the few things both sides must agree on rather than
each guess: `PROTOCOL_VERSION`, the per-engine `ENGINE_CAPABILITIES` records, and the shared
**rules** — `transcriptActivity`, the [sessions-list view model](#the-shared-view-models) and the
[unread model](#the-shared-view-models). They live here because a client that computed them
differently would disagree with the server about what it is showing.

## The model

One session = one ordered stream of `SessionEvent`s, each stamped with a monotonically
increasing `seq` (starting at 1) and an epoch-ms `ts`, plus a small `SessionCommand` set.
Clients attach over WebSocket, optionally replaying from a known `seq`, and drive the session
with commands.

## Versioning and skew detection

`PROTOCOL_VERSION` (currently `7`) is bumped on any breaking change to events, commands, or REST
shapes. The server reports it in the `attached` (and `queue_attached`) frame so clients can
detect skew:

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
| `status_changed` | `SessionStatus` transition (`starting`, `running`, `awaiting_approval`, `idle`, `parked`, `failed`, `closed`) with optional detail. `parked` means the session is waiting on a deferred execution — non-terminal, and the host's cue to snapshot it. |
| `capabilities` | Models (`ModelOption[]`) and slash commands (`SlashCommandInfo[]`) available to the session, fetched from the CLI after init, plus `defaultModel` — the wire id this session's default resolves to, which is how a client can name the running model before the first turn. The model list is shaped server-side: the CLI's own `default` row is dropped (it is a choice, not a model), each row is named from its resolved id, and `primary` marks the newest of each family so a picker can file the rest under "more models". |
| `model_changed` | Model switched via `set_model`; `model` undefined = back to default. |
| `permission_mode_changed` | Mode switched via `set_permission_mode`. |
| `context_usage` | Context-window snapshot (`ContextUsage`), polled after each turn. |
| `rate_limit` | Subscription rate-limit window update (`RateLimitInfo`). API-key sessions may never emit one — render nothing, not 0%, and treat an absent `utilization` as unknown. |
| `plan_info` | Which claude.ai plan those windows belong to (`subscriptionType`: 'pro', 'max', …). Emitted from the same poll as `rate_limit`, once per change, and never for an API-key session. |
| `assistant_message` / `user_message` | An `ApiMessage` (plain Anthropic content blocks) plus `parentToolUseId`, `replay` (resumed-history backfill), and for user messages `synthetic` (tool results) and `attachments`. The last is deliberately a list of **references** (`MessageAttachment`: id, name, media type, size) and never the bytes: this log is replayed to every attaching client and captured into parking snapshots, so an inlined photo would be paid for on every attach, forever. Fetch `GET /v1/sessions/:id/attachments/:id` to render one. |
| `stream_delta` | Raw Anthropic streaming event; emitted only with `includePartialMessages`. |
| `turn_result` | End of a turn: subtype, `isError`, `durationMs`, `numTurns`, `totalCostUsd` (both session-cumulative), `result` text, per-turn `usage`. |
| `permission_requested` / `permission_resolved` | The pending-approval flow — see [Permissions](/workerdeck/docs/guides/permissions/). |
| `execution_dispatched` / `execution_result` / `execution_failed` | Tool-execution lifecycle, correlated by `executionId`. `deferred: true` on dispatch means the execution may outlive the runner (the session parks); `expiresAt` is when the host's watchdog fires. A failure is fed back as tool output, not a session error. |
| `skills` | The skills this session can reach (`SkillInfo[]`), listed after init. Drives the `/` composer completion and the skills panel. |
| `file_delivered` | The agent handed over a file from its scratch filesystem (`deliver_file`); download it under `GET /sessions/:id/files/<path>`. |
| `file_produced` | The **engine** wrote a file on the *host* filesystem and reported the path — codex's `image_gen` saving a PNG is the case that motivated it. The host-filesystem sibling of `file_delivered`. Carries an opaque `fileId`, the absolute `path` as the engine reported it, and a media type where the runner could determine one; fetch it at `GET /sessions/:id/produced/:fileId`. This event **is** the allowlist for that route — nothing else can add a path to it. |
| `sdk_event` | Forward-compatible passthrough for any SDK message this protocol version doesn't model first-class (task progress, compaction boundaries, auth status, …). |
| `session_error` / `session_closed` | Terminal errors and closure (`reason: 'client' | 'server' | 'error'`). |

## Commands (client → server)

`SessionCommand` variants: `user_message` (`text`, plus optional `attachmentIds` naming files
uploaded ahead of it), `permission_decision` (`requestId`,
`behavior: 'allow' | 'deny'`, allow-only `updatedInput`, deny-only `message`/`interrupt`),
`interrupt`, `set_permission_mode`, `set_model` (omit `model` for the default), `close`, and the
two answers to a bridged tool call — `tool_call_result` / `tool_call_error`, each carrying the
`executionId` it is answering.

WebSocket framing: the server sends `attached` (protocol version + `SessionInfo` snapshot +
`replayingFrom`), then `event` frames, with `protocol_error` for bad input; the client sends
bare `SessionCommand`s. Two further server frames belong to the browser tool bridge:
`tool_call_request` (execute this tool in your own sandbox — `toolName`, `input`, an optional
`vfsSeed` and `limits`, and an `expiresAt` after which the server gives up) and
`tool_call_canceled` (abandon it; the turn was interrupted, it timed out, or the session closed).
Only sandbox-benefiting tools are ever bridged — authoritative ones (MCP, secret-bearing APIs)
execute server-side and never appear on this channel.

An attach is **full control, not a read level**: a client holding one can send `user_message`,
`permission_decision`, `interrupt` and `close`. Anything that decides who may watch a session
must decide it before the attach, not after.

## REST shapes

- `CreateSessionRequest` — `profile` (which engine and config this runs as), `cwd`, `prompt`,
  `permissionMode`, `allowDangerouslySkipPermissions`, `allowedTools`/`disallowedTools`,
  `mcpServers` (`McpServerConfigWire`: stdio/http/sse), `settingSources`, `model`,
  `reasoningEffort`, `maxTurns`, `maxBudgetUsd`, `resume`/`forkSession`, `capabilities`,
  `includePartialMessages`, `approvalTimeoutMs`, `questionBehavior`, `meta`, `scope`.
  `cwd` is **optional**, not required: an engine whose capability record clears `hostCwd` (the
  provider engine) has no host directory to name, and for it `allowedCwdRoots` is not the
  boundary. The gateway rejects fields the chosen engine's capability record forswears rather
  than accepting them into a silent no-op.
- `SessionInfo` — server id (≠ `sdkSessionId`), status, cwd, `profile`, `engine` and its
  `capabilities` record, model, permission mode, `canBypassPermissions` (fixed at creation: the
  CLI refuses to *switch into* bypass unless the process was spawned for it, so a picker can
  disable the mode rather than offer a refusal), `apiKeySource`, `lastSeq`,
  `pendingPermissionCount`, `title`, cumulative `totalCostUsd` / `numTurns`, `activityCount`,
  `lastActivityAt`, `scope`.
- `UpdateSessionRequest` — the `PATCH` body behind renaming. `title` is **three-state**: a string
  sets `meta.title`, an explicit `null` clears it so the derived title (the first prompt) comes
  back, and omitting it leaves the name alone. A rename never reaches the model.

### Session scope

`scope` is a bag of opaque string tags, assigned at create and immutable after. It is the only
intra-deployment scoping primitive in the protocol, and the split is deliberate: WorkerDeck
stores and *enforces* the tags, and the embedder's `authorizeSession(principal, session)` decides
what they mean — `{ user, space }` is one app's vocabulary and the next has tenants. A principal
that fails the check gets **404, never 403**: a 403 confirms the session exists.
`JobInfo.scope` carries the same tags through the queue. See
[Embed WorkerDeck in your app](/workerdeck/docs/guides/embed-in-your-app/) for the policy half.

### Capability records

`EngineCapabilities` is what a client renders from, and `ENGINE_CAPABILITIES` pins one record per
engine (`claude`, `codex`, `provider`) as a runtime constant, so an affordance an engine lacks is
*hidden* rather than shown as a control that silently does nothing. It is also the gateway's
request filter: a create request naming something the record forswears is a 400. Every
`SessionInfo` carries its session's record, and the server serves each profile's record, its
static model catalog and its credential-availability verdict from the first request — a real
model picker with no warm-up session needed.
- `ResolvePermissionRequest` — the REST counterpart of the `permission_decision` command.
- `SubmitExecutionResultRequest` / `SubmitExecutionResultResponse` — a deferred executor delivering
  its outcome (`{ status: 'ok', output } | { status: 'failed', reason, error }`). Applied
  idempotently by `executionId`; the response's `applied: false` means it was already settled.
- `ListSessionFilesResponse` / `SessionFileInfo` — the session's deliverables.
- `SdkSessionSummary` — the Agent SDK's on-disk sessions, listed to offer resume.
- Response wrappers: `ListSessionsResponse`, `CreateSessionResponse`, `GetSessionResponse`,
  `ResolvePermissionResponse`, `ListSdkSessionsResponse`, `ErrorResponse`.
- `SessionNotification` / `SessionNotificationType` / `SessionWebhookConfig` — the out-of-band
  channel for a person who isn't attached (`permission_requested`, `turn_completed`,
  `session_error`, `session_closed`), carrying the `SessionInfo` snapshot, the event's `seq`, a
  one-line `preview`, and — on a permission — the full request to answer over REST. See
  [Notifications](/workerdeck/docs/guides/notifications/).

## The shared view models

Three rules ship here as code rather than as prose each client re-implements, because a client
that computed them differently would announce work it is hiding — or hide work it is announcing.

**`transcriptActivity(event)`** is the row-count rule: how many transcript rows an event is worth.
The React reducer renders by it and the runners count with it (`SessionInfo.activityCount`).
Change one, change both.

**`session-list.ts`** is the sessions-list view model. Sessions bucket into four states —
`attention`, `working`, `idle`, `ended` (`sessionState`) — and the list is filtered, grouped and
sorted along three facets: gateway, adapter and state. `filterRows` / `groupRows` /
`subsetSummary` / `clearFilters` are the operations, `ViewConfig` is the persisted shape, and
`subsetSummary` is what lets a client say *"12 of 30"* and name the cause instead of silently
showing a short list. Workspace scope has one non-obvious containment rule: a scope root tagged
with a gateway scopes **only** that gateway, and an untagged one scopes **only** loopback —
because a remote gateway's identical-looking path is another machine's directory.

**`watermarks.ts`** is the unread model: monotonic marks behind a `WatermarkStore` seam (so a
host supplies `localStorage`, VS Code's `globalState`, or `UserDefaults`), and `unseenCount`'s
arithmetic in **rows, not turns** — five tool calls in one turn is one turn but many rows, and
`lastSeq` counts every stream delta. Monotonic matters: without it a context compaction
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
- Unmodeled SDK messages ride through as `sdk_event` rather than breaking older clients — the
  rule is to promote what UIs need to first-class events instead of parsing payloads
  client-side.
