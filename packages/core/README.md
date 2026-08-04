# @workerdeck/core

The WorkerDeck engines, behind one `Runner` interface: `SessionRunner` wraps the Agent SDK's
`query()` with a push-based input queue, promotes `canUseTool` calls into pending approvals,
normalizes SDK messages into wire-protocol events, and keeps a seq-numbered event log for
attach/replay; `AiSdkRunner` does the same for any provider the AI SDK supports. Pure library, no
transport.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). A `SessionRunner`
behaves like Claude Code launched in the session's directory — same skills, same `CLAUDE.md`, same
permission system — and both runners emit
[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) events.
[`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) bridges runners to
HTTP + WebSocket; use core directly when you want sessions in-process with no server.

## Install

```bash
npm install @workerdeck/core
```

Depends on `@anthropic-ai/claude-agent-sdk`, which spawns the official Claude Code CLI. Needs
Node ≥ 22 and a real filesystem. WorkerDeck implements no Anthropic auth: the SDK/CLI resolves
credentials from the operator's environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal
`claude login`).

The provider engine additionally wants `ai` (AI SDK v7), your provider package, and — for
`eval_script` — [`@workerdeck/sandbox`](https://www.npmjs.com/package/@workerdeck/sandbox);
all optional, and unused if you only run Claude sessions.

## Usage

`SessionRunnerConfig` is a protocol `CreateSessionRequest` plus host-side extras (`env`,
`extraOptions`, `defaultApprovalTimeoutMs`, injectable `queryFn`/`historyFn` for tests):

```ts
import { SessionRunner } from '@workerdeck/core'

const runner = new SessionRunner({
  cwd: '/srv/checkouts/my-repo',
  prompt: 'Summarize the failing tests', // or a skill invocation like '/verify-content 42'
  settingSources: ['user', 'project'],   // pick up the repo's skills + CLAUDE.md
  permissionMode: 'default',
})

const unsubscribe = runner.subscribe((event) => {
  switch (event.type) {
    case 'assistant_message':
      console.log(event.message)
      break
    case 'permission_requested':
      // Blocks the tool until resolved; denied on timeout (default 5 minutes).
      runner.resolvePermission(event.request.id, { behavior: 'allow' })
      break
  }
})

const done = runner.start()               // idempotent; resolves when the query ends
runner.sendMessage('Now fix the flakiest one') // queues the next turn
await done
```

Other controls: `interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `close(reason?)`,
`fail(message)` for host-enforced policy, and `info()` for a protocol `SessionInfo` snapshot
(status, cost, pending approval count, title). `runner.id` is the server-side id;
`runner.sdkSessionId` is the Agent SDK's — the one you pass back as `resume`.

## Approvals, event log, resume

- **Pending approvals** — the runner's `canUseTool` hook turns each uncovered tool call into a
  `permission_requested` event and a `PendingApproval` that blocks the tool until
  `resolvePermission()` (or the timeout) settles it. Allowing echoes the tool input back as
  `updatedInput` — the SDK requires a record even for an unmodified allow. `AskUserQuestion`
  rides the same path; `questionBehavior: 'auto' | 'deny'` policy-resolves it for unattended runs.
- **Event log** — every event gets a monotonic `seq`; `subscribe(listener, afterSeq)` replays the
  buffer past `afterSeq` before delivering live events, so late attachers always catch up.
- **Resume** — pass `resume: sdkSessionId` (optionally `forkSession`). The SDK only re-streams
  user messages, so the runner backfills the full prior transcript from the SDK's on-disk store
  as `replay: true` events before the query starts (`backfillHistory: false` to skip).
- **Capabilities + usage** — after init (and eagerly for promptless sessions) the runner fetches
  supported models/slash commands and a context-window snapshot, emitting `capabilities` and
  `context_usage` events; context usage is re-polled after every turn.

## The second engine

`AiSdkRunner` runs the same protocol against any provider the [AI SDK](https://ai-sdk.dev)
supports — no CLI process, no config directory. `createEngineSession()` assembles one: the model,
the capability-scoped tool set, and the executor that runs tool calls.

```ts
import { createEngineSession, QuickJsExecutor } from '@workerdeck/core'

const runner = createEngineSession({
  config: { ...createSessionRequest, languageModel: anthropic('claude-sonnet-5') },
  selectExecutor: () => new QuickJsExecutor({ timeoutMs: 15_000 }),
  capabilities: { webFetch: {} },  // backends, not grants
})
```

Two seams matter here:

- **Capabilities are grants, wired separately from backends.** `createToolContext` builds the tool
  set from what a profile grants (`fs_*`, `eval_script`, `web_search`, `download`, `web_fetch`,
  `deliver_file`) over what the host actually wired. There is no shell and no host filesystem: the
  files a session sees are an in-memory scratch VFS. Every tool is typed `sandboxed` or
  `authoritative`, and only sandboxed calls may leave the server.
- **`ToolExecutor` decides where code runs.** `QuickJsExecutor` runs it in-process in the
  [QuickJS guest](https://www.npmjs.com/package/@workerdeck/sandbox); `BrowserBridgeExecutor`
  ships it to the user's own tab, so client-held documents never reach the server; and
  `DeferredExecutor` hands the call off to something that will answer later.

## Work that outlives the runner

`DeferredExecutor` dispatches a call and doesn't wait. The runner then **parks**: `park()` returns
a `RunnerSnapshot`, the process can tear the runner down, and passing that snapshot back as
`restore` rebuilds the session as itself — same id, same event log, same seq numbering, mid-turn,
scratch filesystem included.

```ts
selectExecutor: () => new DeferredExecutor({
  timeoutMs: 86_400_000,                             // watchdog; a timeout reaches the agent as tool output
  onDispatch: (call) => enqueueForYourWorkers(call), // call.executionId is the callback address
})
```

[`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) drives both halves
for you — a `SessionStore` plus `POST /executions/:id/result` — but the mechanism is here, and works
with no server at all.

## Also exported

`InputQueue` (the push-based `AsyncIterable` bridging `sendMessage()` into the SDK's streaming
prompt), `normalizeSdkMessage`/`toApiMessage` (SDKMessage → protocol event normalization),
`connectMcpTools` for live MCP over http/sse, and `createWebFetch` with its SSRF guard
(`isPrivateAddress`). Tests inject a fake `queryFn` — no real CLI spawn needed.

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE)
