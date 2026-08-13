---
title: Server
description: createWorkerServer options, queue options, and the full route table.
order: 3
---

[`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) is the gateway:
HTTP + WebSocket over `node:http` + `ws`, a session registry, and optional job-queue routes.
Node ≥ 22, real filesystem, no serverless — see
[Deployment](/workerdeck/docs/guides/deployment/).

## createWorkerServer(options)

Returns a `WorkerServer`: `{ server, registry, queue?, listen(port, host?), close() }` —
`server` is the underlying `node:http` server, `queue` is set when queue options were provided.

### WorkerServerOptions

| Option | Default | Effect |
| --- | --- | --- |
| `authenticate` | — | `(req: IncomingMessage) => unknown \| Promise<unknown>`. Return a truthy principal to accept, null/undefined to reject with 401. Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. Covers every route including WS upgrades. A principal object may carry `allowedProfiles: string[]` to scope which profiles the caller can use, `canManageProfiles: true` to allow profile create/edit/delete (which also needs `profileStore`), and `scope: Record<string, string>` for session visibility (below). **This is the place to be expensive**: it is already async and already runs once per request, so a lookup — *which spaces is this user in?* — belongs here, landing its answer on the principal. |
| `authorizeSession` | every pinned key must match | `(principal, session: SessionInfo) => boolean` — may this caller see this session at all? Enforced at the `/sessions/:id/*` gate, the session list, the WS attach (*before* the wake — waking rebuilds a runner and reconnects MCP, which is not work to do for someone about to get a 404), `POST /executions/:id/result`, and the job routes via `JobInfo.scope`. A miss is **404, never 403**: a 403 confirms the session exists. The default rule needs no policy — every key the principal's `scope` pins must match the session's, and an unset principal scope is unrestricted, so an operator's dashboard is untouched. Deliberately **synchronous**: it runs per route and per row of every list. A principal carrying a scope is an embedded end user, not the operator, and is refused the operator-privileged surfaces outright (`/fs/*`, `/sdk-sessions`, `/queue`, `/queue/ws`) — those answer about the *gateway*, so there is nothing to filter. With a policy declared, operator principals must say `operator: true`. **True means full control, not read access**: an attach can send `user_message`, `permission_decision`, `interrupt` and `close`. A read-only-for-my-team policy is not expressible here — do not approximate it with the panel's `readOnly`, which removes affordances in a client and is not an authorization boundary. |
| `allowUnauthenticated` | `false` | Explicit opt-in to run without auth (local dev only). Without it and without `authenticate`, `createWorkerServer` throws. |
| `allowedCwdRoots` | off | Session `cwd` (and job `session.cwd`) must resolve inside one of these roots, else 403. Also constrains `/sdk-sessions`: a `dir` must be inside the roots, and a request without one lists the roots themselves rather than the whole host. Strongly recommended. |
| `profiles` | auto-detect | What sessions run as (`{ name, configDir?, engine?, provider?, description?, defaults? }[]`). A `claude` profile's `configDir` becomes the session's `CLAUDE_CONFIG_DIR`; an `engine: 'provider'` profile runs the model-agnostic engine instead and needs `createEngineRunner`. More than one declared → creates must name a `profile`; exactly one → implicit. Unset: a `default` profile is auto-created from `$CLAUDE_CONFIG_DIR`/`~/.claude` when present; `[]` disables. See [Profiles](/workerdeck/docs/guides/profiles/). |
| `profileStore` | — | Persistence for dashboard-managed profiles; setting it mounts `POST /profiles` and `PATCH`/`DELETE /profiles/:name`. `createMemoryProfileStore()` and `createFileProfileStore(path)` are bundled; the type is a three-method seam for anything else. Profiles declared in `profiles` are never stored and never editable over HTTP. |
| `allowedConfigDirRoots` | off | Config-dir roots a *managed* Claude profile may point at (mirrors `allowedCwdRoots`). Unset means the management routes create provider profiles only — naming a config directory is choosing which credential store a session runs on. |
| `hostFiles` | reads follow `allowedCwdRoots` | Tunes the host filesystem routes (`/v1/fs/*`): `{ roots?: string[], write?: boolean, maxFileBytes?: number, maxEntries?: number, ignore?: string[] }`. **Reading needs no grant of its own** — a caller who may start a session in a root can already read it through the agent, so `/fs` serves the same trees; `roots` *narrows* that (an explicit `[]` turns the routes off). With neither `roots` nor `allowedCwdRoots` set, the routes 404: "a session may run anywhere" is about paths the operator types, not a licence to serve `/`. `write` (default off) is its own switch because a `PUT` skips the permission flow an agent's edits go through. `ignore` is the directory names `/fs/find` won't descend into (default: `.git`, `node_modules`, build output…). Operator-privileged: authorized by the auth key alone. |
| `createEngineRunner` | — | `(ctx: { config, profile, bridge }) => Runner \| Promise<Runner>` — build the runner for an `engine: 'provider'` profile. Required if any is declared (the server refuses to start otherwise). Kept as a host hook so the server imports no model SDK and never resolves provider credentials itself; may be async for assembly that has to await (a per-session MCP connect). |
| `buildRunnerConfig` | identity | `(req: CreateSessionRequest) => SessionRunnerConfig` — map/patch the incoming request into the runner config (inject `env`, tool policy, per-skill constraints). Applied to client sessions and queue jobs alike. |
| `attachments` | 10 MiB / 64 MiB | Sizes the message-attachment hold: `{ maxFileBytes?: number, maxSessionBytes?: number }`. Always on and needs no grant — an upload lands in the session's own in-memory store and reaches the model as message content, which is what typing already does. What it *can* cost is memory, which is what these bound. |
| `basePath` | `'/v1'` | URL prefix for all routes. |
| `fallback` | 404 | `(req, res) => void \| Promise<void>` — handle requests *outside* `basePath` instead of 404ing them. This is how the turnkey CLI serves the dashboard and how an embedding app mounts its own routes on the gateway's port, and it exists for one reason: a browser cannot put a header on a WebSocket handshake, so the only credential a tab can present on a session attach is a cookie — and a cookie only rides requests to the origin that set it. One origin is not a convenience, it is what makes an authenticated browser client possible without a stamping proxy. It is a plain Node handler, which is exactly what an Express app is. |
| `cors` | off | `{ origins: string[] }` — let a dashboard on *another* origin call this gateway. **Sharing policy, not a credential**: preflights are answered before auth (browsers strip credentials from them, so they would otherwise 401), but every real request still goes through `authenticate`, and an allowlisted page without the key gets nothing. Exact origins only — no wildcards, no suffix matching — and `Access-Control-Allow-Credentials` is **never** sent, which is what stops an ambient cookie becoming cross-origin authority. WS upgrades are exempt from CORS entirely; their credential is whatever `authenticate` accepts on the handshake. |
| `maxBodyBytes` | 1 MiB | Max JSON body size. |
| `disableBypassPermissions` | `false` | Server-wide bypass policy: session/job creates requesting `permissionMode: 'bypassPermissions'` are rejected (403); the `allowDangerouslySkipPermissions` pre-authorization is stripped from requests, and the WS `set_permission_mode` command refuses the mode. Mirrors Claude Code's `permissions.disableBypassPermissionsMode`. |
| `requireApiKey` | `false` | Fail closed on subscription credentials: a session initializing with `apiKeySource: 'oauth'` is terminated with a `session_error`. Recommended for services and unattended use; off, the server logs a one-time notice instead. See [Auth](/workerdeck/docs/guides/auth/). |
| `checkCredentials` | `false` (CLI: `true`) | Launch-time credential sanity check: after `listen()` binds, each Claude profile's session environment is probed with the SDK-bundled CLI's `claude auth status` (concurrent, fire-and-forget) and a logged-out profile gets one console warning. Warn, never fail; a probe that can't run stays silent; only the logged-in/logged-out verdict is read. `boolean \| { probe?, timeoutMs? }`. See [Profiles](/workerdeck/docs/guides/profiles/#credentials). |
| `requireAvailableProfile` | `false` | Refuse to create a session or submit a job on a profile the credential probe reports **unavailable** — 503 carrying the probe's own reason — rather than letting the run start and die mid-turn on a raw provider error. Off is right for an operator's own gateway: the verdict goes stale in both directions, and turning a probe bug into an outage is worse than one confusing failure. It is wrong in front of an **end user**, who cannot read a provider stack trace and did not choose the deployment's credentials — which is why every embedder otherwise grows its own `available` flag in front of the create button. Requires `checkCredentials`, and only a definite `false` blocks: a profile never probed stays allowed, because "couldn't check" is not "not available". |
| `listSdkSessions` | claude adapter's lister | Injectable lister for `GET /sdk-sessions` (tests) — honored for the Claude engine only; other engines always answer through their adapter. |
| `parking` | in-memory store | Deferred execution: `{ store?, parkDelayMs?, expiredGraceMs?, onError? }`. A session that parks on an execution nothing here is running is snapshotted, its runner torn down, and its state kept in the `SessionStore`. Two ship: `MemorySessionStore` (default — a park survives a disconnect, not a restart) and `createFileSessionStore({ dir })` (one JSON file per park, adopted on `listen()`). `parkDelayMs` (2000) is the grace after the last client detaches; `expiredGraceMs` (60000) is the boot grace for a deadline that lapsed while the process was down. See [Deployment](/workerdeck/docs/guides/deployment/#restarts-parked-sessions-and-the-deploy-guard) and [Job queue](/workerdeck/docs/guides/job-queue/#deferred-execution). |
| `notifications` | off | Out-of-band notification for interactive sessions: `{ webhook?: { url, headers?, events? }, onNotification?, attempts?, retryDelayMs? }`. The four moments a person away from the screen needs — `permission_requested`, `turn_completed`, `session_error`, `session_closed` — POSTed as a `SessionNotification` and/or handed to a local observer. Server-wide, unlike the queue's per-job webhook, and it covers every registry session including job runs and sessions rebuilt after a park. See [Notifications](/workerdeck/docs/guides/notifications/). |
| `queue` | off | Enable the job queue routes — see below. |

### QueueServerOptions

All `JobQueue` options (minus `createRunner`/`buildRunnerConfig`, which the server wires
itself — job sessions are ordinary registry sessions and go through the same config hook and
auth-provenance watcher as client sessions):

| Option | Default | Effect |
| --- | --- | --- |
| `maxConcurrency` | 1 | Concurrent job sessions. |
| `sessionTokenLimit` | off | Token cap per job session (input+output+cache); exceeding it kills the run. |
| `dailyTokenLimit` | off | Global job-token budget per UTC day; queued jobs held once exhausted. |
| `maxJobDurationMs` | off | Wall-clock cap per run — the watchdog against stuck CLIs. Time parked on a deferred execution doesn't count: the run isn't stuck, it's waiting. |
| `maxParkedDurationMs` | off | Cap on time parked, across all parks of one run. The execution's own deadline usually fires first and lets the agent adapt; this one fails the job. |
| `killGraceMs` | 5000 | Grace between interrupting a killed run and force-closing it. |
| `retention` | keep forever | `{ maxAgeMs, sweepIntervalMs? }` — expire terminal jobs (the in-memory adapter otherwise grows unboundedly). |
| `adapter` | in-memory | `QueueAdapter` backend. The bundled adapter is single-process, non-persistent. |
| `webhookAttempts` | 3 | Delivery attempts per webhook event, exponential backoff. |
| `webhookRetryDelayMs` | 500 | Base delay between webhook delivery retries. |
| `onEvent` | — | Local observer for every `JobEvent`, in addition to per-job webhooks. |

See [Job queue](/workerdeck/docs/guides/job-queue/) for semantics.

## Routes

Default `basePath: '/v1'`; every route goes through `authenticate`.

| Route | What it does |
| --- | --- |
| `GET /v1/sessions` | List sessions (`SessionInfo[]`). |
| `POST /v1/sessions` | Create a session (`CreateSessionRequest`). `cwd` is required for engines that run against a host directory and 403s outside `allowedCwdRoots` — an engine whose capability record clears `hostCwd` (the provider engine) may omit it, and for that engine `allowedCwdRoots` is **not** the boundary. `profile` is required when several are declared, 403 outside the caller's `allowedProfiles`, and 503 when `requireAvailableProfile` is on and its credentials probe as unavailable. Fields the chosen engine's capability record forswears are a 400 rather than a silent no-op. `scope` tags are stamped here and are immutable afterwards. 201 with the `SessionInfo`. |
| `GET /v1/sessions/:id` | Session info. A parked session answers from its snapshot, with `status: 'parked'`. |
| `PATCH /v1/sessions/:id` | Rename the session (`UpdateSessionRequest`): `title` sets `meta.title`, which `SessionInfo.title` prefers over the derived one, and `null` clears it so the derived title (the first prompt) comes back. Answers with the updated `SessionInfo`. Nothing reaches the engine — a rename does not speak to the model. **409** while the session is parked: it has no runner to carry the change. |
| `DELETE /v1/sessions/:id` | Close and remove the session — including a parked one, whose stored state is dropped so a late execution result can no longer wake it. |
| `GET /v1/sessions/:id/files` / `…/files/<path>` | List the session's scratch-filesystem deliverables (`ListSessionFilesResponse`) / download one (attachment disposition, `nosniff`). 404 for engines without a VFS (Claude sessions). Served from the snapshot while parked. |
| `POST /v1/sessions/:id/attachments?name=…` | Upload one file to send with a message (`UploadAttachmentResponse`). The body is the **raw bytes** and `content-type` is its media type — no multipart, so a browser and a phone both upload in one plain request. Images (jpeg/png/gif/webp), PDFs and text types only — further narrowed to the kinds the session's engine capability record accepts (e.g. a codex session takes images and text, never PDFs); anything else is a 415, over the per-file cap a 413. The returned `id` goes in the `user_message` command's `attachmentIds`. |
| `GET /v1/sessions/:id/attachments/:attachmentId` | The uploaded bytes back, for rendering a thumbnail (attachment disposition, `nosniff`). Held in memory for the session's lifetime, like `/files` — a 404 after a restart is expected and does not affect the message, which the model already saw. |
| `GET /v1/sessions/:id/mcp` | The session's MCP servers, live from the engine (`McpServersResponse`): status, scope, transport/command/args or URL, and each connected server's tools — with each tool's **JSON Schema where the engine reports one** (codex does; the Agent SDK does not). Each server's `env` and HTTP `headers` are **stripped** — this route is not a way to read the operator's tokens. All three engines answer it: a provider session reports what the host actually assembled through `connectMcpTools`, which is an **empty list** when it wired none, never a 501. 501 only when an engine reports no MCP surface at all (`EngineCapabilities.mcpStatus: false`); 409 while the session is parked. |
| `GET /v1/sessions/:id/produced` / `…/produced/:fileId` | Files the session's **engine** wrote on the host — codex's generated images. List them, or download one (attachment disposition, `nosniff`). Unlike `/v1/fs/*` this needs no `hostFiles.roots` and applies no byte cap, because the allowlist is the exact set of paths this session's own runner announced in `file_produced` events, not a directory grant; a generated PNG is routinely megabytes. Held for the session's lifetime; a 404 means the file has left the disk. |
| `POST /v1/sessions/:id/mcp/:name` | `{ action: 'reconnect' \| 'enable' \| 'disable' }` — the CLI's own three `/mcp` actions, scoped to this session (no config file is written). Answers with the refreshed list. **501** when the engine lists its servers but cannot act on one (`EngineCapabilities.mcpServerActions: false`, which is codex) — clients hide the controls off that flag rather than discovering the refusal. |
| `POST /v1/executions/:executionId/result` | Deliver a deferred execution's result (`SubmitExecutionResultRequest`). Wakes the parked session, applies it to the agent loop, answers `{ applied, sessionId }`. Idempotent by `executionId` — a duplicate, or one racing the watchdog, answers `applied: false`. 404 = unknown id, or a session outside the caller's `allowedProfiles`. |
| `WS /v1/sessions/:id/ws?afterSeq=n` | Attach: `attached` frame (protocol version + snapshot), replay of events past `n`, then live events; accepts `SessionCommand` frames. |
| `POST /v1/sessions/:id/permissions/:requestId` | Resolve a pending approval over REST (`ResolvePermissionRequest`). 404 = unknown, already resolved, or expired. |
| `GET /v1/profiles` | List profiles (`ListProfilesResponse`), filtered to the caller's `allowedProfiles`. Store-backed ones carry `managed: true`; `canManage` says whether this caller may create more. |
| `POST /v1/profiles` | Create a managed profile (`CreateProfileRequest`). 404 without a `profileStore`, 403 without `canManageProfiles` on the principal, 409 if the name is taken, 400 if the profile is one startup would have refused. |
| `PATCH /v1/profiles/:name` | Merge into a managed profile (`UpdateProfileRequest`). The name is the route — profiles cannot be renamed, since sessions and jobs are pinned to it. 403 for a startup-declared profile. |
| `DELETE /v1/profiles/:name` | Delete a managed profile (204). 403 for a startup-declared one. |
| `GET /v1/profiles/:name` | One profile plus a fresh view-only config snapshot (`GetProfileResponse`: settings.json highlights, memory/skills/agents/commands — env var names only, never values). Same `allowedProfiles` scoping. |
| `GET /v1/sdk-sessions?profile=…&dir=…&limit=…&offset=…` | List an engine's on-disk resumable sessions. `profile` names whose store: a claude profile lists the Agent SDK's session files, a codex profile lists CODEX_HOME's threads (over a short-lived `thread/list` child — no live session involved). Absent, the profile is implicit when the server declares exactly one; with several, the Claude engine's store is listed (the pre-engine-aware behavior). With `allowedCwdRoots` set, a `dir` must be inside the roots; omit it and the server lists everything and filters to the roots, so a client with no directory to name still gets an answer inside the policy. |
| `GET /v1/fs/roots` | The host directories this server exposes, plus `canWrite` (`ListHostRootsResponse`). 404 unless `hostFiles.roots` is configured — as does every route below. |
| `GET /v1/fs/list?path=…` | One host directory, not recursive (`ListHostDirResponse`). Entries are classified with `lstat` semantics, so a symlink lists as a symlink and is never followed while rendering. |
| `GET /v1/fs/find?path=…&q=…&limit=…` | Recursive fuzzy file search under one directory (`FindHostFilesResponse`) — what an `@file` picker needs. Subsequence matching, filename hits ranked above path hits, shallowest first; empty `q` returns the shallowest files. Skips `hostFiles.ignore` directories and anything behind a symlink, and truncates rather than erroring. |
| `GET /v1/fs/read?path=…` | One host file (`ReadHostFileResponse`): content plus the sha256 a write will need. Non-UTF-8 content comes back base64; over `maxFileBytes` is a 413. |
| `PUT /v1/fs/write` | Replace or create one file (`WriteHostFileRequest`). Requires `hostFiles.write`, else 403. Always conditional: `expectedHash` must match what is on disk (409 otherwise), and omitting it means create (409 if the path exists). A missing parent directory is a 404 — directories are never created implicitly. |
| `GET /v1/jobs` / `POST /v1/jobs` | List jobs / schedule one (`CreateJobRequest`; `session.cwd` + `session.prompt` required; `session.profile` follows the same rules as session creation). Queue-configured servers only, else 404. |
| `GET /v1/jobs/:id` / `DELETE /v1/jobs/:id` | Job info / cancel. |
| `GET /v1/queue` | Queue stats (`QueueStats`). |
| `WS /v1/queue/ws` | One-way live stream: `queue_attached`, then `job_event` + refreshed `queue_stats` frames. No replay — re-list jobs on (re)connect. |

## Anthropic credentials

The server implements no Anthropic auth: the SDK/CLI resolves credentials from the operator's
environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal `claude login`). Each session's
provenance surfaces as `apiKeySource` on `SessionInfo` and the `system_init` event — the full
posture, including `requireApiKey` and the contributor red lines, is in
[Auth & the providers' terms](/workerdeck/docs/guides/auth/).
