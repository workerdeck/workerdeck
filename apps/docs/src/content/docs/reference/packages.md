---
title: Packages
description: The ten libraries, the instance you run, the apps built on them, and the one dependency rule that holds it together.
order: 1
---

## The libraries

| Package | What it is |
| --- | --- |
| [`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. **This is the product boundary** — versioned from day one. |
| [`@workerdeck/core`](https://www.npmjs.com/package/@workerdeck/core) | The engines, shipped as adapters — each with a capability record, a model catalog and a credential probe. `SessionRunner` wraps the Agent SDK's `query()`, owns the streaming input, promotes `canUseTool` calls into pending approvals, normalizes messages into protocol events and keeps a seq-numbered event log for attach/replay. `CodexRunner` drives the codex binary over its `app-server` JSON-RPC surface. `AiSdkRunner` is the model-agnostic engine over the AI SDK, with tool execution behind a swappable `ToolExecutor` seam (in-process sandbox, browser tab, or deferred) and `park()`/`restore` for work that outlives the runner. All three implement one `Runner` interface. Pure library, no transport. |
| [`@workerdeck/sandbox`](https://www.npmjs.com/package/@workerdeck/sandbox) | The untrusted-code boundary: a QuickJS-NG WASM guest with interpreter-enforced memory and time limits, an in-memory scratch VFS, and a by-value host bridge. A leaf like `protocol` — usable from the server or a browser tab, importing neither. |
| [`@workerdeck/queue`](https://www.npmjs.com/package/@workerdeck/queue) | The job queue: remote services schedule one-shot runs; jobs execute as ordinary sessions with bounded concurrency and token budgets, delivering progress + completion via webhooks. A run waiting on a deferred execution parks — no slot, no ticking clock — and resumes when the result lands. Pluggable `QueueAdapter` (in-memory bundled; redis/bullmq/pubsub can implement the same contract). |
| [`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) | The gateway: HTTP + WebSocket, session registry (create/list/attach/interrupt/kill), pluggable auth hook, profiles (which also pick the engine), optional job-queue routes, the browser tool-call bridge, and parked-session storage for deferred execution. Runs anywhere Node ≥22 runs. |
| [`@workerdeck/client`](https://www.npmjs.com/package/@workerdeck/client) | Typed protocol client for browsers and Node: REST + WebSocket attach with auto-reconnect and replay-from-last-seq. Zero runtime deps. |
| [`@workerdeck/react`](https://www.npmjs.com/package/@workerdeck/react) | The headless React layer: `useClaudeSession`, the attachment and host-file-search hooks a composer needs, and a pure transcript reducer. No styling opinion. |
| [`@workerdeck/ui`](https://www.npmjs.com/package/@workerdeck/ui) | The styled agent-control component library: session panel (status bar, streaming transcript, tool-call cards, permission prompts, composer with attachments and `@file`/`/command` completion, and the panels behind the status bar — session info, context, plan usage, MCP servers, project files), session list, and the underlying primitives. Tailwind v4 + Base UI + cva; light/dark via tokens. |
| [`@workerdeck/web`](https://www.npmjs.com/package/@workerdeck/web) | The dashboard as **prebuilt static files**, for serving from your own host: `dashboardDir` is a path to `index.html` + hashed assets. Zero runtime dependencies — React, the router and Tailwind are compiled in. Must be mounted at a domain root with the gateway same-origin under `/v1`. |

## The instance

Everything above is a library you embed. This one is a service you run.

| Package | What it is |
| --- | --- |
| [`workerdeck`](https://www.npmjs.com/package/workerdeck) | The turnkey instance: `npx workerdeck` serves the gateway and the full dashboard on one port, with shared-secret auth (login cookie for browsers, header for services), durable parking, and `workerdeck guard`. Config that can't fit on a command line goes in a `workerdeck.config.mjs` default-exporting the `createWorkerServer` options. |

## The apps

Three clients of the same gateway, plus this site. None is published to a store or registry —
each is built from the repo.

| App | What it is |
| --- | --- |
| [`apps/vscode`](https://github.com/workerdeck/workerdeck/tree/master/apps/vscode) | The VS Code extension: the session in the bottom panel, status in the window bar, gateways and sessions in the sidebar, approvals as native notifications, and a remote gateway's project as a virtual workspace. Imports `client`/`react`/`ui`/`protocol` and never the server side. Build the `.vsix` and side-load it. |
| [`apps/ios`](https://github.com/workerdeck/workerdeck/tree/master/apps/ios) | The native iOS remote (SwiftUI): one session list across every gateway you have configured, the full transcript, approve/deny, a host file browser, and APNs push. Zero third-party Swift dependencies — `WorkerDeckKit` is a hand-written mirror of `protocol` plus ports of the transcript and sessions-list reducers. |
| [`apps/docs`](https://github.com/workerdeck/workerdeck/tree/master/apps/docs) | This documentation site (Astro), deployed to GitHub Pages on push to `master`. |

The web dashboard is not here because it is a package rather than an app: it ships as
[`@workerdeck/web`](https://www.npmjs.com/package/@workerdeck/web) and the instance serves it.

## The dependency rule

```text
              protocol                sandbox
             /        \            (leaf: either side)
   (server side)    (browser side)
        core            client
          |               |
        queue           react
          |               |
       server             ui
          |               |
          |              web
          └───── cli ─────┘   (the instance: gateway + prebuilt dashboard)
```

`@workerdeck/protocol` depends on nothing and everything depends on it; `@workerdeck/sandbox`
is the same kind of leaf, usable from either side. The browser side (client / react / ui / web)
must never import core, server, the Agent SDK, or any model SDK — the wire protocol is the only
bridge. This rule is what keeps the protocol honest as the product
boundary: anything a client needs must be expressible as protocol events and commands.

`workerdeck` is where the two sides finally meet, and only because they don't have to touch: it
depends on `@workerdeck/server` for the gateway and on `@workerdeck/web` for *already-built*
static files. No browser code is imported, only served.

## Which package do I need?

- Just running it, on your machine or a box: nothing — `npx workerdeck`. See
  [Run an instance](/workerdeck/docs/getting-started/run-an-instance/).
- Embedding a panel in a web app: `@workerdeck/client` + `@workerdeck/ui` (which pulls in
  `react`), against a running `@workerdeck/server`. See
  [Embedding the UI](/workerdeck/docs/guides/embedding/).
- Custom rendering: `@workerdeck/client` + `@workerdeck/react` (headless).
- Sessions in-process with no server: `@workerdeck/core` directly.
- Scheduling unattended runs: the `queue` option on the server plus the client's job methods —
  or `@workerdeck/queue` directly to embed the queue in a custom host or write a
  shared-backend adapter. See [Job queue](/workerdeck/docs/guides/job-queue/).
- Speaking the wire format from another language or runtime: the shapes in
  [`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) — see
  [Protocol](/workerdeck/docs/reference/protocol/).
