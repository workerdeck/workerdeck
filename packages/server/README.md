# @workerdeck/server

The WorkerDeck gateway: HTTP + WebSocket session server over
[`@workerdeck/core`](https://www.npmjs.com/package/@workerdeck/core). Session registry
(create/list/attach/interrupt/kill), pluggable auth hook, replay-from-seq attach, profiles,
parked-session storage, optional job-queue routes. Runs anywhere Node runs — needs a real
filesystem (no serverless).

Want the whole thing running rather than embedded? [`workerdeck`](https://www.npmjs.com/package/workerdeck)
wraps this package and the dashboard into one command: `npx workerdeck`.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). It speaks the
[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) wire format;
pair it with [`@workerdeck/client`](https://www.npmjs.com/package/@workerdeck/client) in the
host app and [`@workerdeck/ui`](https://www.npmjs.com/package/@workerdeck/ui) for embeddable
panels. Job scheduling comes from
[`@workerdeck/queue`](https://www.npmjs.com/package/@workerdeck/queue), mounted via the
`queue` option.

## Install

```bash
npm install @workerdeck/server
```

Node ≥ 22. The Agent SDK spawns the Claude Code CLI as a long-running subprocess with filesystem
state — edge/serverless functions cannot host this; realistic targets are a VM or a container.
The server implements no Anthropic auth: the SDK/CLI resolves credentials from the operator's
environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal `claude login`).

## Usage

The host app supplies the authenticator — return a truthy principal to accept, null/undefined to
reject with 401. `createWorkerServer` refuses to start without `authenticate` unless you
explicitly pass `allowUnauthenticated: true` (loopback dev only — never expose that):

```ts
import { createWorkerServer } from '@workerdeck/server'

const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
  allowedCwdRoots: ['/srv/checkouts'],          // clamp where sessions may run
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env } }),
  requireApiKey: true,                          // fail closed on subscription credentials
})
const { port } = await worker.listen(8787)
// worker.server (node:http), worker.registry, worker.queue, worker.close()
```

Routes (default `basePath: '/v1'`):

| Route | What it does |
| --- | --- |
| `GET/POST /v1/sessions` | List sessions / create one (`CreateSessionRequest`, `cwd` required) |
| `GET/DELETE /v1/sessions/:id` | Session info / close and remove |
| `WS /v1/sessions/:id/ws?afterSeq=n` | Attach: `attached` frame, replay past `n`, then live events |
| `POST /v1/sessions/:id/permissions/:requestId` | Resolve a pending approval over REST |
| `GET /v1/sdk-sessions?dir=…` | List the Agent SDK's on-disk sessions to offer resume |
| `GET /v1/sessions/:id/files`, `…/files/<path>` | List and download a session's scratch-filesystem deliverables |
| `POST /v1/executions/:executionId/result` | Deliver a deferred execution's result, waking a parked session |
| `GET /v1/profiles`, `GET /v1/profiles/:name` | What sessions may run as (+ a view-only config snapshot) |
| `GET/POST /v1/jobs`, `GET/DELETE /v1/jobs/:id` | Job queue (when `queue` is configured) |
| `GET /v1/queue`, `WS /v1/queue/ws` | Queue stats / one-way live stream of job events + stats |

Requests outside `basePath` fall through to the optional `fallback` hook — which is how the
turnkey instance serves a dashboard from the same origin, so a browser's WebSocket attach can
present a cookie.

## Profiles and the second engine

A **profile** is what a session runs as, and which engine runs it. Declared at startup (or managed
over the API with a `profileStore`), each one names either a Claude Code config directory — applied
as that session's `CLAUDE_CONFIG_DIR` — or a model provider for the model-agnostic engine:

```ts
createWorkerServer({
  authenticate: async (req) => {
    const user = await verifyMyAppToken(req.headers.authorization)
    return user && { allowedProfiles: user.profiles, canManageProfiles: user.isAdmin }
  },
  profiles: [
    { name: 'ada', configDir: '/home/ada/.claude', defaults: { model: 'opus' } },
    {
      name: 'kimi',
      engine: 'provider',
      // A variable NAME — no credential is stored here or served by GET /profiles.
      provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
      session: { capabilities: ['web_fetch', 'deliver_file'] },
    },
  ],
  // The one place a model SDK and its credentials are resolved — this package imports neither.
  createEngineRunner: ({ config, profile, bridge }) => buildProviderRunner({ /* … */ }),
})
```

With more than one profile declared, every create must name its `profile`; with exactly one it is
implicit, and with the option unset a `default` is auto-detected from `~/.claude`.
`allowedProfiles` on the principal scopes who may run as what — the line between one worker serving
several people and account pooling. `SessionInfo.engine` and `supportsPermissionMode` let a UI hide
affordances the provider engine doesn't have; asking for one anyway is a 400 rather than a silent
coercion.

## Parked sessions

A session whose tool call can't answer in the next few seconds **parks**: the runner is torn down,
its snapshot goes to a `SessionStore`, and `POST /executions/:id/result` rebuilds it — same id,
same event log, same seq numbering, mid-turn. Results are idempotent by `executionId`. The default
store is in-memory (a park survives a client disconnect, not a restart); the bundled file store
survives both, on one host:

```ts
import { createFileSessionStore, createWorkerServer } from '@workerdeck/server'

createWorkerServer({
  authenticate,
  // Adopted by hydrate() inside listen(): executions re-indexed, watchdogs re-armed.
  parking: { store: createFileSessionStore({ dir: '/var/lib/workerdeck/parked' }) },
})
```

That directory holds each parked session's whole transcript in plaintext — protect it like the
SDK's own `~/.claude/projects`. Credentials never reach it. One process per directory.

## Job queue

Pass `queue` options to mount the job routes — one-shot unattended runs with bounded concurrency,
token budgets, retries, and webhook delivery:

```ts
const worker = createWorkerServer({
  authenticate,
  queue: {
    maxConcurrency: 2,
    sessionTokenLimit: 200_000,          // per job; exceeding kills the run
    dailyTokenLimit: 2_000_000,          // global UTC-day budget; queued jobs held once spent
    maxJobDurationMs: 1_800_000,         // wall-clock watchdog
    retention: { maxAgeMs: 86_400_000 }, // expire terminal jobs
    // adapter: myRedisAdapter,          // defaults to the bundled in-memory adapter
  },
})
```

Job sessions are ordinary registry sessions — attachable over the sessions WS — and go through
the same `buildRunnerConfig` hook and auth-provenance watcher as client sessions. The in-memory
adapter is single-process and non-persistent; implement `QueueAdapter` against a shared store for
anything beyond one trusted host.

## Session notifications

The live WebSocket only reaches someone who has one open. `notifications` is the outbound
channel for everyone else — the four moments a person acts on, POSTed to a URL you control:

```ts
const worker = createWorkerServer({
  authenticate,
  notifications: {
    webhook: { url: 'https://my-app.test/hooks/session', headers: { authorization: '…' } },
    // events: ['permission_requested'],       // default: all four
    onNotification: (n) => log(n.type, n.sessionId, n.preview), // unfiltered, in-process
  },
})
```

`permission_requested`, `turn_completed`, `session_error`, `session_closed` — delivered as a
`SessionNotification`, ordered per session, retried with exponential backoff. Server-wide, unlike
the queue's per-job `webhook`: the point is hearing about sessions you neither created nor are
attached to, and every registry session qualifies (job runs and rebuilt parked sessions included).

`permission_requested` carries the whole `PermissionRequest`, so a consumer can answer it with
`POST /sessions/:id/permissions/:requestId` — the mechanism behind an Approve button in a chat
message or on a phone's lock screen. The server holds no push credentials and knows nothing about
APNs, FCM or Slack; forwarding to one of those is a separate process's job.

## Auth posture

Each session's credential provenance surfaces as `apiKeySource` on `SessionInfo` and the
`system_init` event; `'oauth'` means claude.ai subscription credentials. With
`requireApiKey: true` such sessions are terminated with a `session_error` — recommended for
services and any unattended use. Without it the server logs a one-time notice instead
(appropriate only for personal single-user deployments). WorkerDeck never implements claude.ai
OAuth, never reads or forwards tokens — see the repo README's
["Auth & Anthropic's terms"](https://github.com/workerdeck/workerdeck#auth--anthropics-terms).

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE)
