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

### Codex only: project trust gates `.codex/config.toml`

If a repo carries its own `.codex/config.toml` — MCP servers, a model pin — codex reads it **only
when that project is trusted**, meaning `$CODEX_HOME/config.toml` (usually `~/.codex/config.toml`)
holds an entry like:

```toml
[projects."/abs/path/to/your/repo"]
trust_level = "trusted"
```

The interactive codex CLI asks you the first time you run it somewhere ("do you trust this
folder?") and writes that entry for you. The `app-server` surface WorkerDeck drives cannot ask.

What happens next depends on the permission mode, because the gate is tied to the sandbox:

| Mode | Codex sandbox | Untrusted project |
|---|---|---|
| Manual (`default`) | `read-only` | `.codex/config.toml` is **ignored**; WorkerDeck says so in the transcript |
| Accept edits, Auto | `workspace-write` | codex **writes the trust entry itself**, then loads the config |
| Bypass | `danger-full-access` | same — trusted on start |

So the silent case is exactly the safest mode. In Manual, WorkerDeck detects it and posts a notice
rather than leaving you to wonder where your MCP server went; the fix is to run `codex` once in
that directory and accept the prompt, or add the entry by hand. WorkerDeck never writes it for
you — the same reason it never touches your codex credentials.

Trust resolves per directory layer, from the cwd up to and including the nearest one containing
`.git`. In the ordinary case — a `.codex/config.toml` at your repo root, trust on that root — a
session started in any subdirectory is covered. Note that switching a running session to a wider
mode does not retroactively load the config; start a new session instead.

### Network access

Codex's sandbox has a third axis that neither the permission mode nor the approval policy
controls: in `workspace-write`, **outbound network is off by default**. A command that needs it
does not raise an approval request — it just fails, typically with `Could not resolve host`,
because a DNS failure is not a sandbox denial.

WorkerDeck does not decide this for you. Turn it on the way codex documents, in your
`~/.codex/config.toml` (or a project `.codex/config.toml`, subject to the trust rules above):

```toml
[sandbox_workspace_write]
network_access = true
```

WorkerDeck reads your effective setting for the session's directory and restates it on every
turn, so a session honours exactly what you configured — including `writable_roots`. Manual mode
is unaffected: the setting is scoped to workspace-write, and a read-only sandbox has no network
either way.

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
