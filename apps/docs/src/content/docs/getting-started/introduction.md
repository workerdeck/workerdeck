---
title: Introduction
description: What WorkerDeck is, why it exists, and what it deliberately does not try to be.
order: 1
---

WorkerDeck runs a **close-to-real Claude Code session** programmatically via the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk), and exposes it to a host
application as something it can **embed, watch, and control** — a side-panel that brings Claude
Code into your app.

It comes in two shapes. `npx workerdeck` is a
[turnkey instance](/workerdeck/docs/getting-started/run-an-instance/): gateway plus the full
dashboard on one port, nothing to clone. The `@workerdeck/*` packages are the libraries behind
it, for [embedding](/workerdeck/docs/guides/embedding/) the same machinery in your own product.

## Why it exists

Claude Code is a terminal program. The Agent SDK lets you run the same engine from Node, but it
hands you a raw message stream with no hosting layer: no server your web app can talk to, no wire
protocol, no way to render a transcript or approve a tool call from a browser. WorkerDeck adds
exactly that missing layer:

- a **session server** your web app can talk to (HTTP + WebSocket),
- a **typed wire protocol** for the message stream, versioned from day one,
- **embeddable panel components** with approve/deny controls.

## What "close-to-real" means

A session created here behaves like Claude Code launched in the same directory:

- same skills (`.claude/skills/`),
- same `CLAUDE.md`,
- same MCP config surface,
- same permission system.

Pass `settingSources: ['user', 'project']` when creating a session and it picks up the target
repo's skills and `CLAUDE.md` — a prompt can be plain text or a skill invocation like
`/verify-content 42`.

## Two engines, one protocol

A [profile](/workerdeck/docs/guides/profiles/) decides what a session runs as, including which
**engine** it runs on:

- **`claude`** (the default) — Claude Code via the Agent SDK, everything described above: a real
  CLI process against a real checkout, with the full permission system.
- **`provider`** — a model-agnostic engine over the [AI SDK](https://ai-sdk.dev), for any provider
  it supports. No CLI process and no config directory, and no ambient authority either: tools are
  capability-scoped, the filesystem is an in-memory scratch VFS, and untrusted code runs in a
  QuickJS sandbox that can execute **in the user's own browser tab** instead of on the server.

Both implement one `Runner` interface and speak the same protocol, so the client, the React layer,
the panel and the job queue are unchanged either way. One worker can serve both.

## Beyond the live session

- [**Permissions**](/workerdeck/docs/guides/permissions/) — a tool call the session's mode
  doesn't cover becomes a pending approval, and the tool blocks until a client decides.
- [**Job queue**](/workerdeck/docs/guides/job-queue/) — unattended one-shot runs with bounded
  concurrency, token budgets, retries, a watchdog, and webhooks.
- **Deferred execution** — a session can *park* on work nothing here is doing (a batch job, a
  human approving on Monday) and resume days later, mid-turn, as itself. See
  [job queue](/workerdeck/docs/guides/job-queue/#deferred-execution) and
  [deployment](/workerdeck/docs/guides/deployment/#restarts-parked-sessions-and-the-deploy-guard).

## The stack at a glance

Nine libraries, one instance, one dependency rule:

| Package | What it is |
| --- | --- |
| `workerdeck` | The turnkey instance: gateway + dashboard on one port, shared-secret auth, durable parking, restart guard. |
| `@workerdeck/protocol` | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. The product boundary. |
| `@workerdeck/core` | The engines — `SessionRunner` (Agent SDK) and `AiSdkRunner` (any provider) behind one `Runner` interface. No transport. |
| `@workerdeck/sandbox` | The untrusted-code boundary: a QuickJS-NG WASM guest with interpreter-enforced limits. Runs server-side or in a tab. |
| `@workerdeck/queue` | Job queue: one-shot unattended runs with concurrency limits, token budgets, and webhooks. |
| `@workerdeck/server` | HTTP + WebSocket gateway: session registry, pluggable auth hook, profiles, optional job routes. |
| `@workerdeck/client` | Typed protocol client for browsers and Node. Zero runtime deps. |
| `@workerdeck/react` | Headless React layer: `useClaudeSession` + a pure transcript reducer. |
| `@workerdeck/ui` | Styled agent-control components: `SessionPanel`, transcript, permission prompts, composer. |
| `@workerdeck/web` | The dashboard as prebuilt static files, for serving from your own host. |

The browser side never imports the server side; the protocol is the only bridge. See
[Packages](/workerdeck/docs/reference/packages/) for the full map.

## Honest constraints

- **Hosting: no serverless.** The SDK spawns the Claude Code CLI as a long-running subprocess
  with filesystem state. Edge/serverless functions cannot host this. Realistic targets: a VM, a
  container with min-instances, any Node ≥22 host with a real filesystem.
- **Sessions are single-host.** Transcripts live on the server's local disk (the SDK default);
  resume works across process restarts on the same host via `resume: sdkSessionId`. Parked
  sessions survive a restart with the bundled file store, but one directory serves one process.
- **The server trusts its host app.** `CreateSessionRequest` accepts `mcpServers` and tool
  policy; gate session creation behind your own auth and use `allowedCwdRoots` +
  `buildRunnerConfig` to clamp what clients may request. See
  [Deployment](/workerdeck/docs/guides/deployment/).
- **No Anthropic auth of its own.** Credentials are resolved by the official SDK/CLI from the
  operator's environment — see [Auth & Anthropic's terms](/workerdeck/docs/guides/auth/).

## Where to go next

- [Run an instance](/workerdeck/docs/getting-started/run-an-instance/) — `npx workerdeck`,
  the flags, and the config file.
- [Quickstart](/workerdeck/docs/getting-started/quickstart/) — the workspace from source, a
  first session, a minimal embed.
- [Embedding](/workerdeck/docs/guides/embedding/) — put the panel in your own app.
- [Permissions](/workerdeck/docs/guides/permissions/) — the sharp edge that makes it safe to
  point at a real checkout.
