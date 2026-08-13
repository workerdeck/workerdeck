---
title: Engines and executors
description: Which engine to run a session on, and where its sandboxed code should execute.
order: 4
---

Two independent choices, often confused. The **engine** decides what kind of agent this is; the
**executor** decides where its sandboxed tool calls run. Only the provider engine has the second
choice at all.

## Which engine?

| | `claude` | `codex` | `provider` |
|---|---|---|---|
| Runs | the Claude Code CLI, via the Agent SDK | the `@openai/codex` binary | any AI SDK model, in-process |
| Host filesystem | yes — a real `cwd` | yes — a real `cwd` | **none**; an in-memory scratch VFS |
| Interactive approvals | yes | yes (escalation after a sandbox refusal) | **no** |
| Survives a restart | dormancy: rebuilt lazily on first attach | dormancy | parking: full state snapshot |
| Credentials | the operator's `claude login` / API key | the operator's `codex login` | your provider key, resolved by your hook |
| Extra process | a CLI subprocess per session | one child per session | none |
| Best for | working on a real repo, close to real Claude Code | the same, on OpenAI's stack | an agent **inside your product** |

The dividing line is the filesystem. `claude` and `codex` are for an agent that works on a
checkout, with the operator's own credentials and the operator's own tooling — that is what makes
them "close to real". The provider engine has no shell and no host paths at all: its authority is
exactly the tools you grant it, which is what makes it the one you can put in front of end users.

Two consequences of `EngineCapabilities.hostCwd: false` on the provider engine that surprise
people: `cwd` is optional (a required field nothing reads is a lie), and `allowedCwdRoots` is
therefore **not** the sandbox boundary for it. The capability wiring is.

Whatever you render, read the capability record rather than the engine name —
`TranscriptState.capabilities` is always populated, and it is what makes one component correct for
all three.

## Which executor?

Only for the provider engine, and only for tools typed `sandboxed` (`eval_script`, plus any host
tool you declare that way). Authoritative tools — MCP, and anything holding your credentials —
always run in the gateway and may never be routed elsewhere.

| | `QuickJsExecutor` | `BrowserBridgeExecutor` | `DeferredExecutor` |
|---|---|---|---|
| Runs in | this Node process, WASM guest | the attached browser tab | wherever you dispatch it |
| Needs a client attached | no | **yes** | no |
| Latency | in-process | a WebSocket round trip | unbounded — the session parks |
| Data locality | data must reach the server | client-held data never leaves the tab | n/a |
| Result trust | untrusted (it is a sandbox) | untrusted, and produced by the sandboxed party | depends on the backend |

Ask where the data the loop reasons over already lives:

- **In your database or on your disk** → in-process. Pushing execution into the tab buys nothing
  and hands an executor to the party you are sandboxing against.
- **In the user's browser** — a document they are editing, a file they dropped, something you would
  rather not receive at all → the bridge. That is the case it exists for.
- **Somewhere that answers in minutes or hours** — a queue, a build, a human → deferred, and let
  the session park.

Two constraints decide it regardless of preference:

- An **unattended job** has no attached client, so the bridge is unavailable to it. A profile used
  by both interactive sessions and queued jobs needs an in-process executor as at least a fallback.
- A **bridged result is produced by the sandboxed party.** Never route anything authoritative
  there, and treat everything that comes back as input, not as fact.

The choice is per *call*, not per session — a routing executor can keep `eval_script` in-process
and defer a long-running tool, and only the deferred one parks the session.

### Setting up the in-process guest

The WASM variant is a peer dependency you install, because the browser build and the server build
are different artifacts and only the host knows which side it is on. Load it once per process and
share it across sessions:

```ts
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { loadEngine } from '@workerdeck/sandbox'
import { QuickJsExecutor } from '@workerdeck/core'

const executor = new QuickJsExecutor({
  engine: await loadEngine(variant),
  defaultTimeoutMs: 5_000,
  // No `allowedHosts` → the guest has no network at all. `web_fetch` is a
  // separate host-side tool with its own SSRF guard, and a script cannot reach it.
})
```

In a browser host the equivalent is `@jitl/quickjs-singlefile-browser-release-asyncify`, which
`useToolCallHost` loads lazily by default — a page that never bridges a call never pays for it.
