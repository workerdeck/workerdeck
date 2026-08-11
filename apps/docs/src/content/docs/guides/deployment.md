---
title: Deployment
description: Hosting realities — no serverless, single-host sessions, mandatory auth hook, and clamping client requests.
order: 6
---

## No serverless — and why

A CLI engine runs as a **long-running subprocess with filesystem state**.
Edge/serverless functions cannot host this. Realistic targets:

- a VM,
- a container with min-instances (so the process and its disk survive between requests),
- any Node ≥ 22 host with a real filesystem.

Node ≥ 22 also matters for the client side of the stack: `@workerdeck/client` relies on
platform `fetch` and `WebSocket` (global in Node ≥ 22), with `fetchImpl`/`WebSocketImpl`
injectable for older runtimes.

## Single-host sessions and resume

Sessions are single-host in V1. Transcripts live on the server's local disk (the SDK default),
and resume works across process restarts **on the same host**: pass `resume: sdkSessionId` on
`CreateSessionRequest`, and the server backfills the prior transcript as `replay: true` events.
`GET /v1/sdk-sessions?dir=…` lists an engine's on-disk sessions so hosts can offer "resume" after
a restart — pass `profile=…` to list a specific profile's store (a codex profile lists its
CODEX_HOME threads; codex resumes replay history the same way).
`dir` names **one** project directory (and its worktrees), not everything beneath it —
so a client with no directory in hand should omit it and let the server apply `allowedCwdRoots`. Note the two ids: `SessionInfo.id` is the server-assigned id; `sdkSessionId` is the
Agent SDK's — the one you feed back as `resume`.

Multi-host session storage is still on the roadmap: the bundled `SessionStore` implementations
are both single-process (see below). If you need the queue to span hosts, the `QueueAdapter` seam
is the supported path — see [Job queue](/workerdeck/docs/guides/job-queue/).

## Restarts, parked sessions, and the deploy guard

A session parked on a deferred execution lives in a `SessionStore`. The default one is in-memory:
the park survives a client disconnect, not a restart. Since a park can legitimately last days,
a deploy that restarts the process is how parked work actually gets lost — so point it at the
bundled file store:

```ts
import { createFileSessionStore, createWorkerServer } from '@workerdeck/server'

createWorkerServer({
  authenticate,
  parking: {
    store: createFileSessionStore({ dir: '/var/lib/workerdeck/parked' }),
    // Boot grace for a deadline that lapsed while the process was down (default 60s):
    // the watchdog must not fail every parked execution at t=0.
    expiredGraceMs: 60_000,
  },
})
```

`hydrate()` runs inside `listen()`, so the records are re-indexed and their watchdogs re-armed
before the server accepts a request. Three things to know:

- **The directory holds plaintext transcripts.** Each record is one parked session's whole event
  log and tool I/O. Protect it like the SDK's own `~/.claude/projects`.
- **Credentials never reach it.** The stored config keeps the wire request only: `env`,
  `extraOptions`, and injected functions are dropped, and a rebuilt provider session resolves
  credentials through `createEngineRunner` from the environment, exactly as the first build did.
- **One process per directory.** Two servers sharing it would both hydrate and both rebuild the
  same sessions.

Durability doesn't make a restart free. A turn actually in flight dies with the process, as does
a pending permission request, and a running job is left claimed. `workerdeck guard` asks a live
worker whether anything would be lost and exits non-zero while the answer is yes. It needs no
checkout and doesn't care what started the worker:

```bash
# 0 = safe to restart, 1 = still busy, 2 = could not tell (bad URL, auth, unexpected response)
npx workerdeck guard --url https://worker.internal/v1 --token "$TOKEN" \
  --wait 300 --allow-parked && systemctl restart workerdeck
```

`--token` is sent as `Authorization: Bearer`; for a host whose `authenticate` hook reads something
else, use `--header name=value` (repeatable).

It blocks on any session that is `starting`, `running`, or `awaiting_approval`, on any running
job, on parked sessions unless `--allow-parked` says a durable `SessionStore` is configured, and
on queued jobs unless `--allow-queued` says the same of the `QueueAdapter`. The two are separate
decisions: a durable session store under the bundled in-memory adapter still wakes a parked
session that no job is left waiting on, so the guard says so rather than pretending otherwise.

## The auth hook is mandatory

`createWorkerServer` **refuses to start** without an `authenticate` hook unless you explicitly
pass `allowUnauthenticated: true` — an opt-in for loopback dev only. Never expose an
unauthenticated worker: whoever reaches it can run tool-wielding sessions in your checkouts.

```ts
const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
})
```

Return a truthy principal to accept, null/undefined to reject with 401. The hook covers every
route, including WebSocket upgrades (sessions WS and queue WS). Browsers cannot set WS headers —
use a ticket query param (`buildWsUrl` on the client) or cookies for socket auth.

Anthropic credentials are a separate concern entirely: the server implements no Anthropic auth;
the SDK/CLI resolves credentials from the operator's environment. For services, set
`ANTHROPIC_API_KEY` and consider `requireApiKey: true` to fail closed on subscription
credentials — see [Auth & the providers' terms](/workerdeck/docs/guides/auth/).

## Clamp what clients may request

The server trusts its host app: `CreateSessionRequest` accepts `mcpServers`, tool policy, model,
and more. Three levers keep that safe:

- **`allowedCwdRoots`** — session `cwd` (and job `session.cwd`) must resolve inside one of these
  roots. `/sdk-sessions` follows the same policy: a `dir` must be inside the roots, and a listing
  without one is filtered down to the sessions whose `cwd` is. Strongly recommended.
- **`buildRunnerConfig`** — map/patch every incoming `CreateSessionRequest` (client sessions and
  queue jobs alike) into the actual runner config: inject `env`, strip or override
  `mcpServers`, force `allowedTools`/`disallowedTools`, pin `permissionMode`.
- **Your `authenticate` hook** — decide who may create sessions at all.

```ts
const worker = createWorkerServer({
  authenticate,
  allowedCwdRoots: ['/srv/checkouts'],
  buildRunnerConfig: (req) => ({
    ...req,
    mcpServers: undefined,            // clients don't get to bring their own MCP servers
    permissionMode: 'default',        // force interactive approvals
    env: { ...process.env },
  }),
  requireApiKey: true,
})
```

See the [server reference](/workerdeck/docs/reference/server/) for every option, and
[Permissions](/workerdeck/docs/guides/permissions/) for the approval flow those clamps feed
into.
