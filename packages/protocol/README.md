# @workerdeck/protocol

The WorkerDeck wire protocol: typed session events, commands, and REST shapes shared by the
server and every client. Dependency-free, browser-safe. This protocol is the product boundary —
versioned from day one.

Part of [WorkerDeck](https://github.com/tobiasstrebitzer/workerdeck), the web-controlled
Agent SDK session runner. Everything else in the stack depends on this package; it depends on
nothing. [`@workerdeck/core`](https://www.npmjs.com/package/@workerdeck/core) produces these
events, [`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) puts them
on the wire, and [`@workerdeck/client`](https://www.npmjs.com/package/@workerdeck/client)
consumes them. Anthropic API message content is modeled structurally (`ApiMessage`,
`ContentBlock`) so browsers can render transcripts without the Agent SDK.

## Install

```bash
npm install @workerdeck/protocol
```

Type-only for most consumers; the runtime exports are `PROTOCOL_VERSION` and
`supportsPermissionMode()`.

## Usage

One session = one ordered stream of `SessionEvent`s, each stamped with a monotonically increasing
`seq`, plus a small `SessionCommand` set. Clients attach over WebSocket, optionally replaying from
a known `seq`, and drive the session with commands:

```ts
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionCommand,
} from '@workerdeck/protocol'

ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data) as ServerFrame
  if (frame.type === 'attached' && frame.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('protocol mismatch')
  }
  if (frame.type === 'event' && frame.event.type === 'assistant_message') {
    render(frame.event.message) // ApiMessage — plain Anthropic content blocks
  }
}

const approve: SessionCommand = { type: 'permission_decision', requestId, behavior: 'allow' }
ws.send(JSON.stringify(approve))
```

`PROTOCOL_VERSION` is bumped on any breaking change to events, commands, or REST shapes; the
server reports it in the `attached` (and `queue_attached`) frame so clients can detect skew.

## At a glance

**Events (server → client)** — `system_init`, `status_changed`, `capabilities`, `model_changed`,
`permission_mode_changed`, `context_usage`, `rate_limit`, `assistant_message`, `user_message`,
`stream_delta`, `turn_result`, `permission_requested`, `permission_resolved`,
`execution_dispatched` / `execution_result` / `execution_failed` (tool-execution lifecycle,
correlated by `executionId`), `file_delivered`, `sdk_event` (forward-compatible passthrough for
unmodeled SDK messages), `session_error`, `session_closed`.

**Commands (client → server)** — `user_message`, `permission_decision`, `interrupt`,
`set_permission_mode`, `set_model`, `tool_call_result` (answering a bridged execution), `close`.

**Other server frames** — `attached`, `event`, `tool_call_request` / `tool_call_canceled` (the
browser tool bridge: the server asks an attached client to run a *sandboxed* tool call), and
`protocol_error`.

**REST shapes** — `CreateSessionRequest` / `SessionInfo` and their response wrappers,
`ResolvePermissionRequest` (the REST counterpart of `permission_decision`),
`SdkSessionSummary` for listing the Agent SDK's on-disk sessions to offer resume,
`ProfileInfo` for what a session may run as, `ListSessionFilesResponse` for a session's
deliverables, and `SubmitExecutionResultRequest` for delivering a deferred execution's result.

**Job queue** — `CreateJobRequest` / `JobInfo` / `JobEvent` (including `job_parked` /
`job_resumed`) / `QueueStats` and the `QueueServerFrame` union for the one-way queue WebSocket,
used when the server mounts the
[`@workerdeck/queue`](https://www.npmjs.com/package/@workerdeck/queue) routes.

Two engines ride this one protocol: `SessionInfo.engine` says which (`claude` or `provider`), and
`supportsPermissionMode(engine, mode)` — a real runtime export, the single source of truth for the
restriction — is what create forms filter with and the gateway rejects with.

Forward compatibility is deliberate: unknown content blocks fall back to `UnknownBlock`, unions
the SDK may grow (`apiKeySource`, rate-limit fields) stay `string`, and unmodeled SDK messages
ride through as `sdk_event` rather than breaking older clients.

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/tobiasstrebitzer/workerdeck/blob/master/LICENSE)
