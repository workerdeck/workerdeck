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
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { loadEngine } from '@workerdeck/sandbox'
import { createEngineSession, QuickJsExecutor } from '@workerdeck/core'

// Server-side, the WASM guest is loaded once for the process and shared by every
// session. The variant package is a peer dependency you install yourself — core
// does not pick one for you, because the browser build and the server build are
// different artifacts and only you know which side this is.
const executor = new QuickJsExecutor({ engine: await loadEngine(variant), defaultTimeoutMs: 15_000 })

const runner = createEngineSession({
  config: { ...createSessionRequest, languageModel: anthropic('claude-sonnet-5') },
  selectExecutor: () => executor,
  capabilities: { webFetch: {} },  // backends, not grants
  seedVfs: { '/README.md': 'scratch space' },
})
```

Three seams matter here:

- **Capabilities are grants, wired separately from backends.** `createToolContext` builds the tool
  set from what a profile grants (`fs_*`, `eval_script`, `web_search`, `download`, `web_fetch`,
  `deliver_file`) over what the host actually wired. There is no shell and no host filesystem: the
  files a session sees are an in-memory scratch VFS. Every tool is typed `sandboxed` or
  `authoritative`, and only sandboxed calls may leave the server.
- **Your own tools go in at a stated trust level.** `tools: { name: { tool, trust } }` is the seam
  for anything that is neither a built-in capability nor MCP. `authoritative` means it runs here
  with this process's authority and must declare `execute`; `sandboxed` means it rides the executor
  seam and must *not*. Both contradictions are refused at assembly rather than at runtime, because
  a sandboxed tool that quietly ran in-process would defeat the only thing sandboxing it was for.
- **`ToolExecutor` decides where code runs**, and that is a real architectural choice — see below.

### Which executor?

| | `QuickJsExecutor` (in-process) | `BrowserBridgeExecutor` (the tab) | `DeferredExecutor` |
|---|---|---|---|
| Runs where | this Node process, WASM guest | the attached client | wherever you send it |
| Needs a client attached | no | **yes** | no |
| Data locality | data must reach the server | client-held data never leaves the tab | n/a |
| Trust | you own both sides | results are **untrusted input** — the sandboxed party answers | depends |
| Latency | in-process | a WS round trip | unbounded (the session parks) |

The question to ask is **where the data the loop reasons over already lives**:

- In your database or on your disk → in-process. Pushing execution into the tab buys nothing and
  hands an executor to the party you are sandboxing against.
- In the user's browser — a document they are editing, a file they dropped, something you would
  rather not receive at all → the bridge. This is the case it exists for.
- Somewhere that answers in minutes or hours (a queue, a human, a build) → deferred, and let the
  session park.

Two constraints that decide it for you regardless: an **unattended job** has no attached client, so
the bridge is not available to it; and a bridged result is by definition produced by the sandboxed
party, so nothing authoritative may ever be routed there.

An executor is chosen per *call*, not per session (`selectExecutor` runs at assembly, but a routing
executor may keep `eval_script` in-process and defer a long-running tool), which is what lets one
session mix all three.

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

`snapshot()` is the same value **without** the teardown: the runner stays live, attached and warm.
That separation is what makes a provider session survive a process restart, since it has no
engine-side store to resume from the way claude and codex do — the host writes the snapshot through
after each turn and rebuilds from the last one. The gate differs from `park()`'s in one direction
only: it refuses a turn in flight and pending *in-process* executions (whose results die with the
process), and allows the idle case `park()` exists to refuse.

## Rules you cannot infer from the types

Things the compiler will not tell you, each of which has cost someone real time:

- **A declared MCP server that never connected is refused, not degraded.** If a profile's
  `session.mcpServers` names a server and it isn't there, `createEngineSession` throws. The old
  behaviour — start anyway, minus those tools — produced a session that reported perfectly healthy
  while the agent apologised its way through every request that needed it. Pass
  `connectMcpTools(servers, { required: true })` to fail at connect time instead, and hand the
  resulting connection over as `mcp` (not just `mcp.tools`) so the check is exact.
- **A stateless MCP server must answer `GET` with 405.** The client opens the SSE stream with a
  `GET` before it sends anything. Mounted under a framework's default 404, the whole connect fails
  with an error that names neither the method nor the route.
- **Never seed the VFS by hand on a restore.** Use `seedVfs`, which is ignored when
  `config.restore` is set. Building `config.vfs` yourself still works and still wins — and then
  overwriting the files the parked turn wrote is yours to avoid.
- **Forward the host's `id`.** `createEngineSession({ id })` is how a session comes back as
  *itself* across a gateway restart. Dropping it strands every client's route and unread mark, and
  the rebuild is refused.
- **`onClose` runs on park as well as close.** Parking releases the same resources; a disposer that
  assumes the session is over will close an MCP connection the woken session still needs to rebuild.
- **Authoritative tools are never bridged.** `withMcpTools` marks everything authoritative by
  construction. If you want a host tool the tab may run, declare it `sandboxed` in `tools` — and
  then treat its results as untrusted input, because the tab produced them.
- **Never make a tool's operation depend on a field being absent.** "Create when `id` is missing,
  overwrite when it is present" is the shape that breaks: models send `""` — and, observed live,
  `" "` — rather than omitting, and some providers mark every property required so the model
  *cannot* omit. `z.string().min(1).optional()` does not save it (a space has length 1). Split it
  into two tools with required arguments, and trim-and-blank-check optional strings inside `run`.

## Also exported

`InputQueue` (the push-based `AsyncIterable` bridging `sendMessage()` into the SDK's streaming
prompt), `normalizeSdkMessage`/`toApiMessage` (SDKMessage → protocol event normalization),
`connectMcpTools` for live MCP over http/sse, and `createWebFetch` with its SSRF guard
(`isPrivateAddress`). Tests inject a fake `queryFn` — no real CLI spawn needed.

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE)
