---
title: Introduction
description: What WorkerDeck is, why it exists, and what it deliberately does not try to be.
order: 1
---

WorkerDeck runs a **close-to-real coding agent session** programmatically — Claude Code, OpenAI
Codex, or any model provider — and exposes it as something you can **watch, steer, and embed**.

It comes in two shapes. `npx workerdeck` is a
[turnkey instance](/workerdeck/docs/getting-started/run-an-instance/): gateway plus the full
dashboard on one port, nothing to clone. The `@workerdeck/*` packages are the libraries behind
it, for [embedding](/workerdeck/docs/guides/embedding/) the same machinery in your own product.
The [iOS app](https://github.com/workerdeck/workerdeck/tree/master/apps/ios) and the
[VS Code extension](https://github.com/workerdeck/workerdeck/tree/master/apps/vscode) are two
more clients of the same gateway, built from this repo.

## Why it exists

A coding agent is a terminal program. Its SDK — or its binary — lets you run the same engine from
Node, but it hands you a raw message stream with no hosting layer: no server your web app can
talk to, no wire protocol, no way to render a transcript or approve a tool call from a browser.
WorkerDeck adds exactly that missing layer:

- a **session server** your web app can talk to (HTTP + WebSocket),
- a **typed wire protocol** for the message stream, versioned from day one,
- **embeddable panel components** with approve/deny controls,
- and the clients built on them: a web dashboard, an iOS remote, a VS Code extension.

## What "close-to-real" means

A session created here behaves like the agent's own CLI launched in the same directory:

- the same skills,
- the same project instructions (`CLAUDE.md`, `AGENTS.md` — whatever that engine reads),
- the same MCP config surface,
- the same permission system.

For a Claude session, passing `settingSources: ['user', 'project']` at create time is what picks
up the target repo's skills and `CLAUDE.md` — a prompt can then be plain text or a skill
invocation like `/verify-content 42`.

## Three engines, one protocol

A [profile](/workerdeck/docs/guides/profiles/) decides what a session runs as, including which
**engine** it runs on:

- **`claude`** (the default) — Claude Code via the Agent SDK, everything described above: a real
  CLI process against a real checkout, with the full permission system.
- **`codex`** — OpenAI Codex, the local codex binary driven over its `app-server` JSON-RPC
  surface the same way the Agent SDK drives the Claude CLI, streaming token-by-token. The
  binary resolves its own auth (`codex login` in your terminal), and permission modes map onto
  codex's own sandbox. Its ask channels ride the **same permission surface** as Claude's, with one
  difference the request carries honestly: a codex command approval is usually an *escalation
  after the sandbox already refused*, not a gate before execution. Two things it has that a Claude
  session doesn't: **skills** (listed from `~/.codex/skills`, offered under `/` as a typing aid
  rather than as commands — codex has no slash commands, and a skill is something the model
  chooses from its description) and **generated images**, which the runner announces as produced
  files so the gateway can serve them without any host-filesystem grant.
- **`provider`** — a model-agnostic engine over the [AI SDK](https://ai-sdk.dev), for any provider
  it supports, assembled by your own server hook. No CLI process and no config directory, and no
  ambient authority either: tools are capability-scoped, the filesystem is an in-memory scratch
  VFS, and untrusted code runs in a QuickJS sandbox that can execute **in the user's own browser
  tab** instead of on the server.

Every engine declares a **capability record** (approvals, modes, resume, telemetry, attachments,
reasoning efforts) that clients render around, and ships a **model catalog** with each release,
so `GET /profiles` answers a create form from the first request — including whether the
profile's credentials currently probe as usable. All engines implement one `Runner` interface
and speak the same protocol, so the client, the React layer, the panel and the job queue are
unchanged either way. One worker can serve all three.

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

Ten libraries, one instance, one dependency rule:

| Package | What it is |
| --- | --- |
| `workerdeck` | The turnkey instance: gateway + dashboard on one port, shared-secret auth, durable parking, restart guard. |
| `@workerdeck/protocol` | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. The product boundary. |
| `@workerdeck/core` | The engines, as adapters — `SessionRunner` (Agent SDK), `CodexRunner` (the codex binary over JSON-RPC) and `AiSdkRunner` (any provider) behind one `Runner` interface. No transport. |
| `@workerdeck/sandbox` | The untrusted-code boundary: a QuickJS-NG WASM guest with interpreter-enforced limits. Runs server-side or in a tab. |
| `@workerdeck/queue` | Job queue: one-shot unattended runs with concurrency limits, token budgets, and webhooks. |
| `@workerdeck/server` | HTTP + WebSocket gateway: session registry, pluggable auth hook, profiles, optional job routes. |
| `@workerdeck/client` | Typed protocol client for browsers and Node. Zero runtime deps. |
| `@workerdeck/react` | Headless React layer: the session hook, attachment/host-file hooks, and pure reducers for the transcript and the sessions list. |
| `@workerdeck/ui` | Styled agent-control components: `SessionPanel` (transcript, permission prompts, composer with attachments and `@file`/`/command` completion, and the session detail panels). |
| `@workerdeck/web` | The dashboard as prebuilt static files, for serving from your own host. |

The browser side never imports the server side; the protocol is the only bridge. See
[Packages](/workerdeck/docs/reference/packages/) for the full map.

## Honest constraints

- **Hosting: no serverless.** A CLI engine is a long-running subprocess with filesystem state. Edge/serverless functions cannot host this. Realistic targets: a VM, a
  container with min-instances, any Node ≥22 host with a real filesystem.
- **Sessions are single-host.** Transcripts live on the server's local disk (the engine's own
  default); resume works across process restarts on the same host. Parked
  sessions survive a restart with the bundled file store, but one directory serves one process.
- **The server trusts its host app.** `CreateSessionRequest` accepts `mcpServers` and tool
  policy; gate session creation behind your own auth and use `allowedCwdRoots` +
  `buildRunnerConfig` to clamp what clients may request. See
  [Deployment](/workerdeck/docs/guides/deployment/).
- **No model-provider auth of its own.** Credentials are resolved by the official SDK/CLI from
  the operator's environment — see [Auth & the providers' terms](/workerdeck/docs/guides/auth/).

## Where to go next

- [Run an instance](/workerdeck/docs/getting-started/run-an-instance/) — `npx workerdeck`,
  the flags, and the config file.
- [Quickstart](/workerdeck/docs/getting-started/quickstart/) — the workspace from source, a
  first session, a minimal embed.
- [Embedding](/workerdeck/docs/guides/embedding/) — put the panel in your own app.
- [Permissions](/workerdeck/docs/guides/permissions/) — the sharp edge that makes it safe to
  point at a real checkout.
