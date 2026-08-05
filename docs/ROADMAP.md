# Roadmap & open questions

What's shipped, what's next, and what's still undecided. Status as of 2026-08-05 (0.8.0 on
master; 0.7.0 is the latest published).

## Shipped

- **Runner + protocol + server + client + panel** — create/attach/interrupt a live session,
  approve/deny from the panel, resume after a reload, and a second consumer proving
  embeddability. One ordered stream of seq-numbered events; `PROTOCOL_VERSION` guards breaking
  changes.
- **Styled UI layer + web dashboard** — `@workerdeck/ui`, the dashboard, headless
  `@workerdeck/react` (hook + pure transcript reducer), resume backfill, `SessionInfo`
  rollups.
- **Model switching, slash commands, prompt-area composer.**
- **Job queue + hardening** — token budgets, retries with backoff, a wall-clock watchdog,
  retention, a live `/queue/ws` stream, and question prompts with `questionBehavior` policies.
- **Session telemetry** — `context_usage`, `rate_limit` and `permission_mode_changed` promoted to
  first-class events; usage rings in the status bar; model and permission-mode selects.
- **Permission-mode completeness** — `bypassPermissions` passthrough for live sessions, `dontAsk`,
  `protocol_error` frames surfaced as panel toasts, and the `disableBypassPermissions` server
  policy (403 on an explicit mode, capability stripped, WS switch refused).
- **Profiles** — named Claude Code config dirs applied as `CLAUDE_CONFIG_DIR` per session, with
  per-profile defaults, required-unless-single on create, an auto-detected `default` from
  `~/.claude`, `allowedProfiles` scoping on the auth principal, and a config-snapshot view.
  Later: profile *management* (`profileStore` seam with memory + JSON-file stores,
  `canManageProfiles` on the principal, `allowedConfigDirRoots` bounding managed Claude profiles,
  create/edit/delete in the dashboard). Startup-declared profiles stay immutable — they're code.
- **Model-agnostic runtime** — `AiSdkRunner` (AI SDK v7, streamed: per-token `stream_delta` plus
  per-step messages) behind the shared `Runner` interface; provider profiles built through
  `createEngineRunner`; the QuickJS sandbox package with browser-bridged execution;
  capability-scoped tools (`fs_*`, `eval_script`, `web_search`, `download`, `web_fetch` with an
  SSRF guard, `deliver_file` → `file_delivered` + `GET /sessions/:id/files`); live MCP over
  http/sse.
- **Dual-engine surfaces** — `SessionInfo.engine` reported by each runner and
  `supportsPermissionMode` as the single source of truth for the restriction (forms filter, the
  gateway 400s, startup refuses a bad profile default); operator-declared `provider.models`
  driving the model picker; CLI-only affordances hidden for provider profiles. Session grants live
  on the profile (`capabilities` / `mcpServers` / `instructions`), with a request able to narrow
  but never widen, and client-supplied MCP refused for provider sessions.
- **Deferred execution** — a session can park on work nothing here is doing: `DeferredExecutor`
  plus per-call `describe()` on the executor seam, `Runner.park()` → `RunnerSnapshot` → `restore`
  (same id, same event log, same seq numbering, mid-turn), `SessionParkManager` and the
  `SessionStore` seam in the server, `POST /executions/:id/result` applied idempotently by
  `executionId`, and a watchdog whose timeout reaches the agent as ordinary tool output. Parked
  job runs free their concurrency slot and stop their wall-clock budget (`job_parked` /
  `job_resumed`, `maxParkedDurationMs`); parked sessions stay readable and downloadable from their
  snapshot, and attaching wakes one.
- **Durable parks** — `createFileSessionStore()`: one JSON file per parked session, temp-file +
  rename writes, adopted by `hydrate()` inside `listen()` so a restart re-indexes the executions
  and re-arms their watchdogs (no sooner than `parking.expiredGraceMs`, since nothing could have
  been delivered while the process was down). The record deliberately excludes credentials,
  injected functions and SDK options. The other half of a safe restart is `workerdeck guard`,
  which exits non-zero while a session is mid-turn, awaiting an approval, or parked without
  durability behind it — a durable store still cannot preserve an in-flight turn.
- **Turnkey instance** — `npx workerdeck` runs the gateway *and* the dashboard on one port,
  durable parking on by default, a `workerdeck.config.mjs` for the options that are functions,
  and `workerdeck guard`. Single-origin is the load-bearing part: a tab cannot put a header on
  a WebSocket handshake, so a same-origin cookie is the only credential it can present on an
  attach — hence `--auth-key`, one secret over two transports, with an explicit `Origin` check
  (upgrades are exempt from CORS) and a Host allowlist against DNS rebinding on the
  unauthenticated loopback default. The dashboard is published as prebuilt static files with zero
  runtime deps. Off loopback the CLI generates and persists a key rather than refusing to start,
  and serving genuinely open requires naming the bind host (`--insecure-host` / `insecureHosts`),
  which doubles as the accepted Host header. Dev goes through the same binary — there is no
  separate dev entry point, only `examples/dev-server.config.mjs`.
- **Session notifications** — the out-of-band channel for a person who isn't watching:
  `permission_requested` / `turn_completed` / `session_error` / `session_closed` POSTed to a
  server-wide webhook and/or a local observer, ordered per session, retried with backoff, with the
  full `PermissionRequest` on board so a consumer can answer over REST. Subscribed through the
  registry's `onRegister`, so a session rebuilt after a park is covered too. Deliberately
  transport-agnostic: the server holds no push credentials, and turning a notification into an
  APNs push is a forwarder's job.
- **Host filesystem access** (0.7.0) — `/v1/fs/*`: roots, directory listing,
  recursive fuzzy search, file read, and conditional write. The first *operator-privileged*
  surface in the project, authorized by the auth key alone rather than through the agent
  permission flow. Reading follows `allowedCwdRoots` on the reasoning that a caller who may start
  a session in a tree can already read it through the agent; `hostFiles.roots` / `--fs-root`
  narrows, and writing opts in separately (`--fs-write`) because a `PUT` skips the permission flow
  an agent's edits go through. Containment is decided on realpath rather than string prefixes
  (`host-files.ts`), every filesystem refusal is one indistinguishable 404, and opens go through
  `O_NOFOLLOW` + an `fstat` gate: the trees on offer are written by the agent, so a planted
  symlink is the threat model, not an edge case. Writes carry the sha256 they replace. The iOS
  app browses and edits over it, scoped to the open session's cwd, and completes `@file` in the
  composer against `/fs/find`. Covered by tests on both halves; not yet exercised against a live
  gateway from a phone.
- **Message attachments + MCP screens** (`PROTOCOL_VERSION` 5) — a session can be sent photos,
  PDFs and text files. The bytes never ride the protocol: an upload
  (`POST /sessions/:id/attachments`) is held per session and the `user_message` command names it
  by id, so the replayed event log and every parking snapshot carry a `MessageAttachment`
  reference rather than base64 that would be paid for on every attach. The gateway turns the
  three supported kinds into image / document / inlined-text content blocks, refusing anything
  else at the door with a 415; `pnpm smoke:media` proves all three actually reach the model
  through the real CLI, which no fake harness can. Alongside it, `/sessions/:id/mcp` reports a
  session's MCP servers and tools and performs the CLI's own reconnect / enable / disable —
  with each server's `env` and HTTP `headers` stripped on the way out, so the route can never
  become a way to read the operator's tokens. The iOS app gained an Add Media sheet (camera /
  photos / files, HEIC transcoded and photos downscaled on device) and the four `/mcp` screens.

## Next

0. **APNs push for the iOS app — released in 0.7.0, not yet proven on a device.** The forwarder half is in
   (`packages/cli/src/apns/`: hand-rolled HTTP/2 client, device registry at `/apns/devices`,
   in-process hook onto the session notifications above) and so is the app half (entitlement,
   registration per gateway, Approve/Deny actions, deep link). Verified so far: the credential
   path end to end against real APNs (a bogus token gets `BadDeviceToken`, which only a valid JWT
   and topic can earn) and presentation on the simulator via `xcrun simctl push`. **Not** yet
   verified: a real device token, an actual push arriving from a running gateway, or the
   Approve/Deny buttons resolving a live permission request. It ships in 0.7.0 rather than waiting
   — the code is tested and the alternative was holding the host-filesystem release behind it —
   but it stays here rather than under Shipped until a push has actually reached a phone, and the
   README says as much. The same caveat covers the iOS file browser released alongside it.
1. **Bespoke provider adapters, and Codex as a first-class engine.** Today the second engine is a
   thin pass-through to whatever `@ai-sdk/*` package the *host* dynamically imports, which leaves
   nowhere to put per-provider behaviour, no way for a client to ask what a profile can do, and no
   difference between "misconfigured" and "working" until a session fails. The plan is adapters in
   this repo — each declaring its own capabilities and its own hard-coded model catalog, and each
   reporting itself unavailable when its credentials are absent — plus **Codex
   (`@openai/codex-sdk`, which drives a local binary exactly as the Agent SDK drives the Claude
   Code CLI) as a peer of the Claude engine**, streamlined behind one capability record so the two
   are interchangeable to a client. The `@ai-sdk` providers are temporarily disabled rather than
   removed. Two consequences worth stating up front: model lists stop being discovered at runtime
   (the `capabilities`-learned map goes away in favour of static catalogs shipped with releases),
   and whether a Codex turn can *ask* for approval and wait decides whether `PermissionRequest` is
   a Claude-only concept — verify that before designing around it. Credentials stay the official
   SDK/binary's business either way; WorkerDeck implements no login flow for Codex any more than
   it does for Anthropic.
2. **Shared-backend `QueueAdapter`** (BullMQ or plain redis) — the reason the adapter contract
   exists. `claimNext` must stay atomic (BullMQ free; raw redis needs LMOVE/Lua) and honor
   `nextRunAt` (BullMQ delayed jobs); daily counters map to `INCRBY` on a dated key with TTL.
   Caveat: `JobQueue` assumes the claiming process runs the job — multi-worker deployments need a
   claim-lease/heartbeat so a dead worker doesn't strand jobs in `running`, and webhook ordering
   is per-process.
3. **Promote the remaining `sdk_event` passthroughs** UIs care about: tool progress,
   task/subagent events, todo lists.
4. **Managed sandbox tier-2** — a hosted execution backend (Vercel/E2B) behind the existing
   `ToolExecutor` seam. Deliberately after deferred execution: if a third backend needs no
   runner-loop or protocol change, the seam held.
5. **Multi-host sessions** — the durable half landed (`createFileSessionStore`), but it is
   single-process by construction: two servers over one directory would both hydrate and both
   rebuild. What's left is a shared-backend store (redis/sqlite/a table) with a claim on rebuild
   and, for Claude-engine sessions, cross-host resume over the SDK's on-disk transcripts. Also
   unproven against a real provider: a live park → POST result → finish smoke.

## Non-goals

Settled, not open for relitigation: serverless hosting (the SDK spawns a long-running subprocess
with filesystem state), multi-tenant SaaS, and claude.ai authentication of any kind.

## Open questions

- **Compliance posture.** Legal/compliance review of the auth stance is in progress — see
  [Auth & Anthropic's terms](https://workerdeck.github.io/workerdeck/docs/guides/auth/).
  That section stays honest as things settle.
