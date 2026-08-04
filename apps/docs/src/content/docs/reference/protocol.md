---
title: Protocol
description: The wire protocol — events, commands, REST shapes, queue frames, versioning, and forward compatibility.
order: 2
---

[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) is the wire
protocol shared by the server and every client: typed session events, commands, and REST shapes.
Dependency-free, browser-safe, and type-only for most consumers — the single runtime export is
`PROTOCOL_VERSION`. Anthropic API message content is modeled structurally (`ApiMessage`,
`ContentBlock`) so browsers can render transcripts without the Agent SDK.

## The model

One session = one ordered stream of `SessionEvent`s, each stamped with a monotonically
increasing `seq` (starting at 1) and an epoch-ms `ts`, plus a small `SessionCommand` set.
Clients attach over WebSocket, optionally replaying from a known `seq`, and drive the session
with commands.

## Versioning and skew detection

`PROTOCOL_VERSION` (currently `4`) is bumped on any breaking change to events, commands, or REST
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
| `capabilities` | Models (`ModelOption[]`) and slash commands (`SlashCommandInfo[]`) available to the session, fetched from the CLI after init. |
| `model_changed` | Model switched via `set_model`; `model` undefined = back to default. |
| `permission_mode_changed` | Mode switched via `set_permission_mode`. |
| `context_usage` | Context-window snapshot (`ContextUsage`), polled after each turn. |
| `rate_limit` | Subscription rate-limit window update (`RateLimitInfo`). API-key sessions may never emit one — render nothing, not 0%, and treat an absent `utilization` as unknown. |
| `assistant_message` / `user_message` | An `ApiMessage` (plain Anthropic content blocks) plus `parentToolUseId`, `replay` (resumed-history backfill), and for user messages `synthetic` (tool results). |
| `stream_delta` | Raw Anthropic streaming event; emitted only with `includePartialMessages`. |
| `turn_result` | End of a turn: subtype, `isError`, `durationMs`, `numTurns`, `totalCostUsd` (both session-cumulative), `result` text, per-turn `usage`. |
| `permission_requested` / `permission_resolved` | The pending-approval flow — see [Permissions](/workerdeck/docs/guides/permissions/). |
| `execution_dispatched` / `execution_result` / `execution_failed` | Tool-execution lifecycle, correlated by `executionId`. `deferred: true` on dispatch means the execution may outlive the runner (the session parks); `expiresAt` is when the host's watchdog fires. A failure is fed back as tool output, not a session error. |
| `file_delivered` | The agent handed over a file from its scratch filesystem (`deliver_file`); download it under `GET /sessions/:id/files/<path>`. |
| `sdk_event` | Forward-compatible passthrough for any SDK message this protocol version doesn't model first-class (task progress, compaction boundaries, auth status, …). |
| `session_error` / `session_closed` | Terminal errors and closure (`reason: 'client' | 'server' | 'error'`). |

## Commands (client → server)

`SessionCommand` variants: `user_message` (text), `permission_decision` (`requestId`,
`behavior: 'allow' | 'deny'`, allow-only `updatedInput`, deny-only `message`/`interrupt`),
`interrupt`, `set_permission_mode`, `set_model` (omit `model` for the default), `close`.

WebSocket framing: the server sends `attached` (protocol version + `SessionInfo` snapshot +
`replayingFrom`), then `event` frames, with `protocol_error` for bad input; the client sends
bare `SessionCommand`s.

## REST shapes

- `CreateSessionRequest` — `cwd` (required), `prompt`, `permissionMode`,
  `allowedTools`/`disallowedTools`, `mcpServers` (`McpServerConfigWire`: stdio/http/sse),
  `settingSources`, `model`, `maxTurns`, `maxBudgetUsd`, `resume`/`forkSession`,
  `includePartialMessages`, `approvalTimeoutMs`, `questionBehavior`, `meta`.
- `SessionInfo` — server id (≠ `sdkSessionId`), status, cwd, model, permission mode,
  `apiKeySource`, `lastSeq`, `pendingPermissionCount`, `title`, cumulative `totalCostUsd` /
  `numTurns`, `lastActivityAt`.
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
