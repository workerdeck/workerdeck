# Architecture

How WorkerDeck is put together: ten packages, four apps (iOS, VS Code, the docs site, and
`apps/embedded` — the reference embedding), one dependency rule. Scope guards behind this shape:
no serverless hosting, no multi-tenant SaaS, no claude.ai auth. For what's deliberately not built
yet, see the [roadmap](./ROADMAP.md).

## The dependency rule

```
              protocol            sandbox
             /        \          (leaf; either side)
   (server side)    (browser side)
        core           client
         |               |
       queue           react
         |               |
       server            ui
         |               |
        cli ──────────> web
              (depends on it for the
               prebuilt dashboard)
```

`@workerdeck/protocol` depends on nothing and everything depends on it. The browser side
(client / react / ui / apps) must never import core, server, or the Agent SDK — the wire
protocol is the only bridge. This rule is what keeps the protocol honest as the product
boundary: anything a client needs must be expressible as protocol events and commands.

## Packages

- **`packages/protocol`** — wire protocol types: session events, commands, REST request/response
  shapes, `JobInfo`/queue frames. Dependency-free and browser-safe. Breaking changes bump
  `PROTOCOL_VERSION`. SDK unions the protocol mirrors (e.g. `PermissionMode`) must stay
  assignable both directions: SDK→protocol for events, protocol→SDK for options. It also holds
  the few *rules* both sides must agree on rather than each reimplementing:
  `transcriptActivity(event)` counts the transcript rows an event materializes — the react
  reducer renders by that rule and the runners count `SessionInfo.activityCount` with it, so a
  client can diff "how much happened while I wasn't looking" without attaching.
  `src/session-list.ts` and `src/watermarks.ts` are two more such rules, lifted out of the VS
  Code extension when the dashboard needed them: the sessions-list view model (state buckets,
  facets, filter/group/sort, the subset summary, workspace-scope containment) and the unread
  model (monotonic marks behind a storage seam, plus `unseenCount`'s rows-not-turns
  arithmetic). Every client must agree on them — the extension's unread status-bar item counts
  the same rows its list shows, so a client filtering differently would announce hidden work.
  `src/usage.ts` is a third of the same species: `mergeUsage` decides which plan-usage reading a
  client renders (the gateway's per-profile state wins every window it holds, the session's
  transcript fills the rest — deliberately not a timestamp comparison, see gotchas) and
  `orderUsageWindows` is the ordering-and-drop-the-unknown rule beside it, because the panel
  renders windows off a merged transcript while the dashboard's profile page renders them off
  `ProfileInfo.usage` with no session in sight.
  Their tests live in `packages/react/test/`, which is where the vitest setup is.
- **`packages/core`** — the engines. `SessionRunner` (Claude) wraps the Agent SDK's `query()`
  with: a push-based async input queue (`sendMessage` feeds the SDK's streaming-input iterable),
  promotion of `canUseTool` callbacks into pending approvals that block the tool until resolved
  (deny-on-timeout), normalization of every SDKMessage into typed protocol events, and a
  seq-numbered event log enabling attach/replay. No transport. Both engines implement the
  engine-independent `Runner` interface (`src/runner-interface.ts`) that server and queue type
  against. `AiSdkRunner` is the model-agnostic engine over the AI SDK's `ToolLoopAgent`: its
  durable state is a `ModelMessage[]` history, and because that loop *terminates* (never
  suspends) on a tool without a local `execute`, continuation is message-state replay —
  `resolveToolCall()` appends the result and re-invokes. Tool execution goes through the
  `ToolExecutor` seam, whose dispatch either settles inline or returns `pending` keyed by
  `executionId`, so a deferred or remote backend drops in without touching the runner or the
  protocol. `QuickJsExecutor` is the in-process backend over `packages/sandbox`;
  `BrowserBridgeExecutor` relays to an attached tab; `DeferredExecutor` hands work to something
  that will answer long after this process stopped waiting. Each executor `describe()`s a call
  before dispatch (backend, deferredness, deadline), so a routing executor can keep one tool
  in-process and defer another. Once a turn comes to rest on nothing but deferred calls — and
  only once every one of them has been handed over — the runner announces `status_changed:
  'parked'`. `park()` then returns a `RunnerSnapshot` (id, event log, seq, VFS, plus the engine's
  own continuation state, opaque to everyone else) and the instance goes inert *without* emitting
  `session_closed`. Feeding that snapshot back as `restore` rebuilds the session as itself: same
  id, same seq numbering, mid-turn. `createToolContext` builds a session's
  capability-scoped tools — the agent's authority is exactly what is granted, there are no
  built-in fs/shell tools, and `fs_*` operate on an in-memory scratch VFS rather than the host
  disk. Each tool carries a trust level: `sandboxed` (no ambient authority, safe to execute
  anywhere, results untrusted) or `authoritative` (server-side with server credentials — MCP and
  secret-bearing APIs, never bridged, since bridging would let a browser forge authoritative
  results). `createEngineSession` assembles provider model + tools + executor into a session.
  **Engines ship as adapters** (`src/engines/`): one `EngineAdapter` per engine — its
  `EngineCapabilities` record (pinned by identity to protocol's `ENGINE_CAPABILITIES`), a model
  catalog versioned with the release, a credential-availability probe, and a runner factory —
  looked up via `getEngineAdapter`. `claude/` wraps `SessionRunner` unchanged; `codex/` owns
  `CodexRunner` over the codex binary's `app-server` JSON-RPC surface (`@openai/codex` as an
  optional peer carrying the binary — one child per *session*, held across turns, a hand-rolled
  newline-delimited client with zero new deps, token-level `stream_delta`s; the retired first
  transport was one `codex exec --experimental-json` spawn per turn, whose JSONL could not
  stream at all);
  `provider/` is a pseudo-adapter whose runners the host's `createEngineRunner` hook builds.
  Adapters live here and not in a new package because the dependency stance was never "server
  touches no engine" — `server` already constructs `SessionRunner` from core. The real
  invariants are: `server` imports no model SDK, the gateway process holds no credential
  material, and provider credential resolution stays in host code. Codex violates none of them
  (the binary resolves its own auth from the session env, exactly like the Claude CLI); a
  separate `packages/adapters` would split the claude engine across two packages and buy nothing
  until an adapter needs a dependency core must not carry — and even codex's doesn't (optional
  peer). Routing codex through a CLI-supplied hook was considered and rejected: it would mean
  the bare library cannot run a codex profile without host wiring, the exact "assembled outside
  the repo" property this layer exists to remove.
- **`packages/sandbox`** — the untrusted-code boundary: a QuickJS-NG WASM guest for
  LLM-generated scripts, an in-memory map-backed scratch VFS (browser-safe by construction —
  no node-fs emulation, no `Buffer`), and a by-value host bridge (values
  cross as strings/JSON; a host object is never handed over by reference — the bridge, not the
  WASM boundary, is where sandboxes like Terrarium/CVE-2026-5752 actually failed). Limits are
  interpreter-enforced: `setMemoryLimit` for the allocator, an interrupt handler between
  bytecode ops for the wall-clock deadline (so infinite loops are preempted in-thread, no worker
  or cross-origin isolation needed). Note the deadline cannot preempt time inside a host
  function — every granted capability carries its own timeout. The engine variant is injected,
  so the server (Node asyncify) and a browser tab (singlefile asyncify) share one guest engine.
  A leaf package like `protocol`: it imports neither core/server nor any model SDK.
- **`packages/queue`** — `JobQueue` over the runner: one-shot unattended runs with bounded
  concurrency, per-session and daily token budgets, ordered webhook delivery, retries with
  exponential backoff, a wall-clock watchdog (`maxJobDurationMs` + force-close grace), and
  terminal-job retention pruning. The `QueueAdapter` contract is the seam for shared backends
  (redis/bullmq): `claimNext` must be atomic and must skip jobs whose `nextRunAt` is in the
  future; daily token counters are adapter-held. Only the in-memory adapter is bundled.
  One-shot means "first `turn_result` completes it", not "one process residency": a run that
  parks on a deferred execution goes `parked` at the same single finalize chokepoint —
  surrendering its concurrency slot, stopping its wall-clock budget, emitting `job_parked` — and
  resumes against the rebuilt runner (`onSessionParking` / `onSessionResumed`, called by whoever
  owns the parking). Parked runs are bounded by `maxParkedDurationMs` rather than
  `maxJobDurationMs`: waiting is not being stuck.
- **`packages/server`** — the gateway: `node:http` + `ws`. `server.ts` is assembly and dispatch
  only; the shape is `routes/` (one module per route family, each a function over the one
  `ServerContext` record in `context.ts`), `services/` (the stateful pieces: registry, parking,
  bridge, the stores, plus `profiles.ts`/`availability.ts`/`session-factory.ts`/`auth.ts` —
  the create pipeline and the one `canSee` predicate), `lib/` (the pure rules: http helpers,
  scope, the profile/env policy, the route parser), and `options.ts` for the public option
  types. Functionally: a session registry
  (create/list/attach/interrupt/kill), resume from the SDK's on-disk sessions, a pluggable
  `authenticate` hook (refuses to start without one unless `allowUnauthenticated: true`), and —
  when the `queue` option is set — `/jobs` + `/queue` routes plus a `/queue/ws` stream of job
  events and stats. Job sessions are ordinary registry sessions, so dashboards can watch them.
  `SessionNotifier` is the outbound half of the same idea for *interactive* sessions: the four
  moments a person acts on (`permission_requested`, `turn_completed`, `session_error`,
  `session_closed`) POSTed to a server-wide webhook and/or a local observer, ordered per session
  and retried with backoff. It subscribes through `SessionRegistry`'s `onRegister` hook — the one
  chokepoint every path funnels into, the rebuild of a parked session included — and stays
  transport-agnostic, so the gateway holds no push credentials.
  Profiles (`profiles` option) bind names to Claude Code config dirs: creation resolves the
  request's profile (required when several are declared, implicit with one, auto-detected from
  `~/.claude` when unset), applies its defaults, and pins `CLAUDE_CONFIG_DIR` after the
  `buildRunnerConfig` hook — except when the session env already lands the CLI in the profile's
  dir, where the pin is skipped because setting the variable at all would change the CLI's
  credential source (see gotchas); the principal's `allowedProfiles` scopes creation and
  `GET /profiles`. With the `profileStore` option (a small seam, memory and JSON-file
  implementations bundled) the dashboard can also create, edit, and delete profiles — gated by
  `canManageProfiles` on the principal, and never touching the ones declared in server options,
  which are code. The gateway also keeps **one plan-usage state per profile**
  (`profile-usage.ts` → `ProfileUsageTracker`, served as `ProfileInfo.usage` on `GET /profiles`):
  a session's own reading is refreshed by nothing but a turn, so one idle since yesterday replays
  yesterday's number as current, and a sibling on the same account never sees what another spent
  — the profile is the account boundary, so the newest reading across its sessions is the state
  worth serving. Fed from `runner.subscribe` in `onRegister`, last-write-wins by the event's own
  `ts` (never arrival order — a rebuilt runner replays from seq 0), with the 0%-after-reset
  inference computed at serve time and marked `inferredReset` (see gotchas).
  A profile also picks the **engine**: `engine: 'provider'` routes creation to
  the `createEngineRunner` hook (which may be async, for assembly that has to await) instead of
  the SDK runner, so this package imports no model SDK and never resolves provider credentials.
  Because the two engines answer to different vocabularies, the gateway rejects a permission mode
  the resolved profile's engine cannot run rather than letting the engine coerce it. A provider
  profile also declares what its sessions get (`session.capabilities` / `mcpServers` /
  `instructions`); a request may narrow that set but never widen it, and may not bring MCP
  servers of its own — MCP tools are authoritative, so a client-named one would be an
  authoritative tool pointed wherever the caller liked.
  `BridgeHub` (always on, exposed as `server.bridge`) routes tool executions
  between a session and the tabs attached to it: it asks the first attached client and fails
  dispatch immediately when none is attached, which is what makes autonomous jobs simply never
  bridge. `SessionParkManager` (`server.parking`) owns the other end of the timescale: when an
  unwatched session parks it snapshots, evicts the runner from the registry, and persists to a
  `SessionStore` (`session-store.ts`: memory by default, `createFileSessionStore()` for one JSON
  file per park under a directory `hydrate()` adopts on `listen()`; the record holds the whole
  transcript, so a shared backend is the operator's call). Parked sessions still list, read, and
  serve their files — from the snapshot, with no runner. `POST /executions/:executionId/result` rebuilds the session under the
  same id and folds the result into its loop, idempotently by `executionId`; an execution
  watchdog does the same with a `timeout` failure when no result ever comes, which the agent
  adapts to like any other tool failure. A session someone is watching stays live and parks
  shortly after the last client leaves; attaching to a parked one wakes it, so a reconnect after
  a network blip finds its session rather than a 404.
  The gateway also serves the **host filesystem** — `GET /fs/roots`, `/fs/list`, `/fs/find`,
  `/fs/read` and (behind the `hostFiles.write` flag) `PUT /fs/write` — so a remote client can
  browse and edit the operator's real project tree instead of only a session's in-memory VFS.
  Reading follows `allowedCwdRoots`, on the reasoning that a caller who may start a session in a
  tree can already read that tree through the agent; `hostFiles.roots` narrows it, and writing is
  a separate opt-in because a `PUT` skips the permission flow an agent's edits go through. These
  are *operator-privileged*: authorized by the auth key alone. The trees they expose are written
  by the agent, so containment cannot be the lexical prefix check `cwdAllowed` uses for cwds:
  `host-files.ts` canonicalizes both roots and targets and decides on the realpath, opens through
  `O_NOFOLLOW` + an `fstat` gate, and answers every filesystem refusal with one indistinguishable
  404 so a planted symlink can't become an existence oracle. Writes carry the hash they replace,
  which is what keeps a phone edit from clobbering the agent mid-run.
  Two smaller session routes round it out. **Attachments**
  (`POST/GET /sessions/:id/attachments`) hold the photos and files a client sends with a message:
  the upload is a plain raw-body request (no multipart, so a phone and a browser both manage it in
  one call), the bytes live in a per-session in-memory `AttachmentStore`, and the `user_message`
  command names them by id — which is what keeps base64 out of the replayed event log and out of
  parking snapshots. **MCP** (`GET /sessions/:id/mcp`, `POST /sessions/:id/mcp/:name`) reports the
  session's servers and their tools straight from the engine and performs the CLI's own three
  actions on one (reconnect, enable, disable); `mcpStatusInfo` in `core` strips each server's
  `env` and `headers` on the way out, so reading it is never a way to read the operator's tokens.
  **Produced files** (`GET /sessions/:id/produced[/:fileId]`) serve host files the *engine* wrote
  — codex's generated images, which arrive as a path and never as bytes. It is the host-filesystem
  sibling of `/files`, and the only route with neither a root allowlist nor a byte cap: its
  allowlist is built solely from `file_produced` events, so it is the exact set of paths this
  session's own runner announced producing rather than a guess about a directory. A path the
  *agent* merely read is not a produced file and stays behind `/fs/*` — see `docs/GOTCHAS.md`.
- **`packages/client`** — typed protocol client on platform `fetch`/`WebSocket`: REST session
  and job management, WS attach with auto-reconnect and replay-from-last-seq, `attachQueue()`
  for the live queue stream. Zero runtime deps; browser and Node. `src/host-url.ts` normalizes
  what an operator types into a `baseUrl` (`apiUrl`) and decides local-vs-remote from that URL
  alone (`isLoopbackHost`) — never by probing paths, which two checkouts of one repo would
  answer wrongly.
- **`packages/react`** — the headless React layer: `useClaudeSession` plus `src/lib/transcript.ts`,
  a pure framework-free reducer folding protocol events into transcript state (messages, tool
  calls, approvals, session meta). Rendering logic stays out of it; it is the unit-test surface.
  `src/lib/recap.ts` is the same shape for "what happened while you were away" —
  `summarizeSince`/`recapLine`, counted from the transcript and never written by the model.
  Also the browser tool host (`createToolCallHost`, wrapped by `useToolCallHost`): it answers
  server-bridged tool calls by running them in the tab's own QuickJS guest, seeded from the
  request's VFS snapshot, so client-held documents can be evaluated without reaching the server.
  The guest engine loads on the first bridged call rather than at import, and the client refuses
  any tool it wasn't configured for — a server cannot talk a tab into running something it never
  opted into.
- **`packages/ui`** — the styled layer: shadcn-style primitives (`src/components/ui`) and agent
  components (`src/components/agent`: SessionPanel, Transcript, ToolCallCard, PermissionPrompt,
  QuestionPrompt, Composer, SessionList, SessionItem, SessionBrowser, StatusBar, ModelSelect;
  `SessionItem` is the session **card** and the only drawing of it in the product — the dashboard's
  list and the VS Code sidebar are two thin hosts over it, where they used to be two hand-kept
  copies of one design — and `SessionBrowser` is the list *around* it: search, facets, grouping,
  the subset line, rendering protocol's view model rather than a second copy of it).
  `src/components/terminal/` is the **terminal theme** (`transcriptVariant: 'terminal'`) — a
  renderer, not a set of branches: it draws every row itself on a character grid (`ch` columns,
  whole multiples of `--term-line`), with computed-not-estimated row heights (`height.ts`
  feeding the virtualizer's `estimateSize`), the scrubber overview ruler, the sticky prompt and
  the terminal composer. `'cards'` is the chat-convention variant; density and font are
  cards-only seams. Geometry and palette live in `src/styles/terminal.css`, and the theme's
  invariants are in `docs/PACKAGES.md`'s `packages/ui` section and gotchas §Terminal theme.
  `@workerdeck/ui/format` is a React-free entry carrying both the formatters and
  `lib/status.ts`'s presentation rules (status severity, meter thresholds, the binding
  rate-limit window, the lenient model match), so a non-React host spells them identically. Tailwind v4 + Base UI + cva;
  design tokens with light/dark on `<html data-theme>`. Ships source styles that the consumer's
  Tailwind build compiles (`@source` scanning — wiring in the package README). The composer's
  input is a vendored copy of just-marketing/prompt-area (MIT) under `src/components/prompt-area`.
  `SessionWorkspace` is the optional VS Code-shaped layout *around* `SessionPanel` (FileTree,
  EditorTabs, the Monaco-backed FileViewer, a hand-rolled `Splitter` — Base UI ships none), and is
  strictly additive: the panel is untouched and an embedder picks either. Two invariants inside
  it: the editor region is **absent** from the layout when no file is open rather than
  zero-height, and `SessionPanel` keeps its child index across that transition, because
  remounting it would drop the WebSocket attach and the whole rendered transcript. The embedder's
  `header` render-prop is portalled from inside the panel up to the top of the workspace — only
  the panel can build the `⋯` menu it is handed, but app chrome belongs above everything.
- **`packages/web`** — the full session-control dashboard (TanStack Router, hash history), shaped
  as **four sections and a dialog**: Sessions, Gateways, Jobs and Profiles are each a
  list-on-the-left/detail-beside-it pair (multi-gateway — routes carry the gateway, since a
  session id is unique only within one), every `+` opens a modal, and Settings is a dialog at the
  foot of the nav rather than a fifth section. Published as prebuilt
  static files with zero runtime deps (`dashboardDir` is a path, not a component tree) — it is an
  application, so everything it builds with is a devDependency. The create forms and the session
  panel render from the profile's **capability record** (`ProfileInfo.capabilities`, falling back
  to protocol's `ENGINE_CAPABILITIES`) and its served model catalog — never from the engine name:
  modes, the effort control, the resume browser, setting sources, and the questions/bypass
  options each appear exactly when the record declares them, and unavailable profiles are greyed
  with their reason (never hidden — availability is display-only).
- **`packages/cli`** — published as the unscoped **`workerdeck`**: the turnkey instance, the
  one package that is a service rather than a library. It runs `createWorkerServer` and serves the
  dashboard — `@workerdeck/web`'s exported `dashboardDir`, a runtime dependency rather than a
  vendored copy — from the *same* `node:http` server via the server's `fallback` option. Single-origin is not a convenience here: a browser cannot set a header on a
  WebSocket handshake, so the only credential a tab can present on a session attach is a cookie,
  and a cookie only rides requests to the origin that set it. That is why the dashboard and `/v1`
  share a port, and why `--auth-key` can protect both with one shared secret — a login page trades
  it for an `HttpOnly` cookie for browsers, while services keep sending it as a header. Also hosts
  `workerdeck guard`, the restart guard.
- (A minimal second consumer, `apps/demo`, proved `client` + `ui` portability for the V1
  acceptance scope; it was removed once that was established — see git history.)

## Session lifecycle

1. `POST /v1/sessions` → registry creates a `SessionRunner`; the runner starts `query()` with a
   streaming-input iterable and re-pins `cwd` every call (the SDK treats it as per-query).
2. Every SDKMessage is normalized into a protocol event, stamped with a monotonic `seq`, logged,
   and fanned out to attached WebSockets. Unmodeled SDK messages pass through as `sdk_event` —
   the rule is to promote what UIs need to first-class events rather than parse payloads
   client-side.
3. Clients attach via `GET /v1/sessions/:id/ws?afterSeq=n` — the server replays logged events
   after `n`, then streams live. The client reconnects automatically and resumes from its last
   seen seq.
4. `canUseTool` promotes a tool call into a pending approval event; the tool blocks until a
   client resolves it via `POST /v1/sessions/:id/permissions/:requestId` (deny-on-timeout, 5
   minutes by default). Allowing must echo the tool input as `updatedInput` — the SDK requires
   it. `AskUserQuestion` rides the same path; `questionBehavior` policy-resolves it for
   unattended runs.
5. Resume: the SDK re-streams only user messages, so the runner backfills full history from the
   SDK's on-disk store as `replay: true` events; the transcript reducer dedupes doubled user
   messages by uuid. `SessionInfo.id` (server id) ≠ `sdkSessionId` (Agent SDK id used for
   `resume`). Backfill strips structure (`getSessionMessages` carries no `isMeta`/`origin`), so
   the runner stamps harness-injected rows synthetic by text (`isSyntheticUserText` in
   `core/normalize.ts`, applied on the live path too — in the runner, not the reducer, so
   `transcriptActivity` never counts an unread row for work nobody typed). Session titles rank
   three-deep in `SessionRunner#title()`: host rename > the CLI's own generated title (polled
   off `getSessionInfo`, never while a rename stands) > the first prompt truncated.

## Embedding: sandboxed sessions and session scope

A gateway embedded in someone else's app — a loop running in the host's own backend, driven from
that app's UI by its end users rather than by an operator at a terminal — is not the multi-tenant
SaaS the non-goals rule out. It is **one gateway, one trust domain, one operator**, with sessions
belonging to something narrower than the gateway. Two mechanisms, deliberately separate:

**What a session can reach** is the `provider` engine plus the capability wiring. A profile built
by `sandboxedProviderProfile()` (`packages/server`) grants `capabilities: []` and
`mcpServers: []`, so a session under it gets the QuickJS guest and the in-memory VFS and nothing
else: no host path, no process, no egress, no MCP. The empty arrays are load-bearing — *absent*
means "no declaration", which grants whatever the host wired. `EngineCapabilities.hostCwd` is
`false` for that engine, so a create needs no `cwd` at all and `SessionInfo.cwd` reports `''`;
`allowedCwdRoots` is not the boundary here and must not be mistaken for one.

**Who can reach a session** is `CreateSessionRequest.scope`: opaque string tags, assigned at
create, immutable afterwards, echoed on `SessionInfo`, and carried through parking and dormancy
(both records embed `info` and `config`, so a restart cannot un-scope anything). WorkerDeck never
interprets a key — one embedder writes `{space, user}`, the next writes `{tenant}`. What the tags
*mean* is the host's `authorizeSession(principal, session)` predicate: synchronous by design,
because it runs per route and per row of every list, so an expensive lookup belongs in
`authenticate` and lands on the principal. Unset, the default rule is that every key the principal
pins must match, and an unset principal scope is unrestricted — the "unset means all" rule
`allowedProfiles` already uses, so an operator's dashboard is unaffected.

Enforcement is at every door, not just the list: the `/sessions/:id/*` gate (which covers GET,
PATCH, DELETE, files, produced, attachments, mcp, and the permission decision), the WS attach
(checked *before* the wake, so a refused caller cannot spend a session's resources rebuilding it),
`POST /executions/:id/result`, and the job routes via `JobInfo.scope`. Every miss answers **404**,
byte-identical to an unknown id. The operator-privileged surfaces — `/fs/*`, `/sdk-sessions`,
`/queue`, `/queue/ws` — are refused outright to anyone who is not the operator: they answer about
the gateway rather than about one session, so there is nothing to filter. "Operator" is
`scope === undefined` **and** no `authorizeSession` declared; a host that writes a policy over its
own principal shape marks its operator principals with `operator: true`, because reading "no scope
field" as "the operator" is how a locked-down gateway ends up serving its filesystem to end users.

**Visibility is full control.** An attach can send `user_message`, `permission_decision`,
`interrupt` and `close`, and a bridged client can settle a tool call — so the predicate is one
boolean over "may drive this session", not a read level. A read-only-for-my-team policy is not
expressible yet, and `readOnly` is not it (that is affordance removal in a client; the gateway
enforces).

## Job lifecycle

`POST /v1/jobs` → adapter enqueues → `JobQueue` claims (`claimNext`) when a concurrency slot
frees and budgets allow → the job runs as an ordinary registry session → webhooks deliver
`job_started` / `job_progress` (per assistant message and permission request) / `job_retrying` /
`job_completed` in order → first turn result completes the job and closes the session. Token
accounting sums per-turn `usage` (input + output + cache_creation + cache_read);
`total_cost_usd`/`num_turns` are session-cumulative and rolled up last-seen, never summed.

## Deferred execution

A tool call whose backend can't answer within the turn — a remote worker, a batch window, a
human — parks the session instead of blocking it:

1. The runner dispatches every deferred call, then announces `status_changed: 'parked'`. Waiting
   for the whole batch is what stops a park from stranding a call still being dispatched.
2. `SessionParkManager` snapshots the session, evicts the runner (releasing its model client, MCP
   connections, and memory), and persists the record. A job at this point surrenders its
   concurrency slot and stops its wall-clock budget → `job_parked`.
3. `POST /v1/executions/:executionId/result` (or `parking.submitResult` in-process, or the
   watchdog's `timeout` failure) rebuilds the session under its own id from the snapshot,
   re-subscribes the queue past the replayed log, and hands the result to the agent loop →
   `job_resumed`. The turn continues as if it had never stopped; its `durationMs` excludes the
   parked stretch.

Results are applied idempotently by `executionId`: a duplicate, or one racing the watchdog,
answers `applied: false` rather than applying twice. Because the park is only a persistence
boundary, `parked` is not terminal anywhere — `claimNext` never claims one, retention never
prunes one, and `DELETE /v1/sessions/:id` is what actually ends one.

With `createFileSessionStore()` the boundary survives the process too: `hydrate()` runs inside
`listen()`, re-indexes every stored record's executions, and re-arms their watchdogs — with a
floor (`parking.expiredGraceMs`, default 60s) under any deadline that passed during the outage,
since nothing could have been delivered while the process was down. What durability does *not*
cover is a turn in flight at the moment of the restart; `workerdeck guard` (`packages/cli`) is
the other half, refusing the restart while any session is mid-turn, awaiting an approval, or
(unless `--allow-parked`) parked without a durable store behind it.

## Tooling conventions

pnpm workspace + turbo; TS 7 native preview (`tsgo`) for typecheck; oxlint; tsdown builds
`build/` only on `prepack`/CI. Dev never builds: every package exposes a
`@workerdeck/source` export condition pointing at `src/index.ts` — Node entrypoints run with
`node --conditions=@workerdeck/source --import @swc-node/register/esm-register`, Vite and
vitest set `resolve.conditions` (vitest configs additionally alias workspace deps to source).
Imports within a package use explicit `.ts` extensions.

## Testing

- `pnpm test`: core against a fake `queryFn` harness (no CLI spawn); server as real HTTP+WS
  integration against the fake harness (including job routes and a webhook receiver); queue
  against a fake runner; react as pure reducer unit tests.
- Real-SDK smoke (spawns actual Claude Code, costs tokens) is deliberately outside `pnpm test`:
  a `SessionRunner` with a trivial one-turn prompt. Anything touching the permission path or CLI
  control requests (`supportedModels`, `getContextUsage`) needs a smoke — the fake harness
  cannot validate those payload shapes.
