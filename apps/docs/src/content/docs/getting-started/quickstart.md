---
title: Quickstart
description: Create a first session, run the workspace from source, then embed the panel in your own app.
order: 3
---

## Prerequisites

- Node ≥ 22 and pnpm.
- Anthropic credentials in your environment — WorkerDeck implements no auth of its own; the
  Agent SDK resolves whatever the operator's environment provides (`ANTHROPIC_API_KEY`,
  Bedrock/Vertex, or your own `claude login`). See
  [Auth & Anthropic's terms](/workerdeck/docs/guides/auth/).

If you only want WorkerDeck *running*, you don't need this page at all: `npx workerdeck`
serves the gateway and the dashboard together, covered in
[Run an instance](/workerdeck/docs/getting-started/run-an-instance/). What follows is for
developing against the source, or embedding the libraries in your own app.

## Run the workspace

To develop against the source, or to embed the libraries:

```bash
git clone https://github.com/tobiasstrebitzer/workerdeck
cd workerdeck
pnpm install
pnpm server   # gateway + dashboard on http://127.0.0.1:8787, no auth (loopback only!)
pnpm web      # optional: vite dashboard on :5191 with HMR, proxying /v1 to the gateway
```

`pnpm server` is the same `workerdeck` CLI as above, pointed at
`examples/dev-server.config.mjs` — there is no separate dev entry point, so the thing you develop
against and the thing you ship are one code path. Edit that config directly; flags still win
(`pnpm server --port 9000`). It runs without auth, which the CLI only permits on loopback: bind
a routable interface to reach it from another device (`pnpm server --host 0.0.0.0`) and the CLI
generates an auth key for you — printed once, reused across restarts.

## Create a first session

In the dashboard:

1. Point the session at a project directory.
2. Give it a prompt — plain text or a skill invocation like `/verify-content 42`.
3. Pick a permission mode, and watch the live transcript.

Tool calls not covered by the permission mode surface as approve/deny cards; the tool blocks
until you decide (deny-on-timeout after 5 minutes by default). Closed or restarted-away sessions
can be resumed from the SDK's on-disk store ("Resume a previous session") — the server backfills
the prior transcript as replay events.

## Minimal embed

Server side — the host app supplies the authenticator; the worker has no auth story of its own:

```ts
import { createWorkerServer } from '@workerdeck/server'

const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
  allowedCwdRoots: ['/srv/checkouts'],
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env } }),
})
await worker.listen(8787)
```

Client side:

```tsx
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel } from '@workerdeck/ui' // Tailwind v4 host: see the embedding guide

const client = new WorkerDeckClient({ baseUrl: 'https://my-app/worker/v1', headers: { ... } })
const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'], // pick up the repo's skills + CLAUDE.md
})
// then render:
<SessionPanel client={client} sessionId={session.id} />
```

`@workerdeck/ui` ships source styles that your app's Tailwind v4 build compiles — the wiring
(theme import, `@source` directives, theme attribute) is covered in
[Embedding](/workerdeck/docs/guides/embedding/).

## Next steps

- [Embedding](/workerdeck/docs/guides/embedding/) — the full options ladder, from styled
  panel down to in-process `SessionRunner`.
- [Permissions](/workerdeck/docs/guides/permissions/) — approvals, modes, tool allowlists.
- [Job queue](/workerdeck/docs/guides/job-queue/) — unattended one-shot runs with webhooks.
