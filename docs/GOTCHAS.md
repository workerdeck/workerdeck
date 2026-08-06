# Gotchas & invariants

Things that cost someone a debugging session. Each one is load-bearing: the obvious-looking
change is the wrong one. Grouped by where they bite. Architecture lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); this is the list of ways to get it wrong.

## Claude engine (Agent SDK / CLI)

- `cwd` is per-query in the SDK; the runner re-pins it every call. `SessionInfo.id` (server id) ≠
  `sdkSessionId` (SDK session id used for `resume`).
- The SDK version floats (`^0.3.x`) and its unions grow; protocol mirrors must stay assignable
  BOTH ways (SDK→protocol for events, protocol→SDK for options). Unmodeled SDK messages pass
  through as `sdk_event` — extend the protocol first-class, don't parse payloads client-side.
- `total_cost_usd`/`num_turns` on result messages are session-cumulative — roll up last-seen,
  never sum. `usage` is per-turn — token accounting sums input+output+cache_creation+cache_read.
- On `resume` the SDK re-streams only user messages; the runner backfills full history as
  `replay: true` events and the reducer dedupes doubled user messages by uuid. The SDK never
  echoes streamed-input user messages — the runner emits `user_message` itself in `sendMessage()`.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately — the runner fetches capabilities/context eagerly; `useClaudeSession`
  seeds mode/model/status from the `attached` frame's SessionInfo.
- CLI telemetry quirks (smoke-verified, SDK 0.3.221): `getContextUsage().categories[].color`
  holds CLI theme token names, not CSS; rate_limit events can omit `utilization` — render
  unknown, never 0%.
- **The model list needs shaping, and it happens once, in `core/src/normalize.ts`**
  (`modelOptionsFromSdk`) so no client invents its own. Three traps, all live:
  `supportedModels()` leads with a `value: 'default'` sentinel that is a *choice*, not a model —
  a session running on it reports something else, so a picker row for it can never be checked and
  a status bar naming it says "Default" for a session answering as Opus. It is dropped, and its
  `resolvedModel` is forwarded as `capabilities.defaultModel` instead, which is the only way to
  name a promptless session's model before its first turn. `displayName` is the family alone
  ("Opus") or carries a variant instead of a version ("Opus (1M context)"), so rows are renamed
  from their resolved id. And the list is flat: `primary` (newest of each family) is derived here,
  because the CLI reports no grouping and every UI would otherwise guess differently.
- The model list is **only ever current models** — the older versions Claude Code's own picker
  files under "more models" are in neither `supportedModels()` nor `initializationResult()`
  (checked directly against the SDK). Which model names you get is a function of the pinned SDK
  version, nothing else: 0.3.217 reported Opus 4.8, 0.3.221 reports Opus 5.
- **Two model-list truths coexist; keep both.** The live `capabilities` event is the in-session
  truth for the model *switcher* (and the only carrier of slash commands, and of what the
  profile's default resolves to). The static catalog (`core/src/engines/*/catalog.ts`, served on
  `ProfileInfo.models` from the first request) is the *create-form* truth — it is what fixed the
  cold-start free-text picker, and it may list older models the CLI no longer reports. Someone
  will eventually try to "simplify" one of them away; both sentences are load-bearing.
  `defaultModel` cannot be static (it is the operator's CLI config), so it alone is still learned
  from sessions and stays absent on a cold server.
- `supportedModels()` reports **per-model reasoning efforts** (`supportedEffortLevels`, 0.3.221+),
  forwarded as `ModelOption.reasoningEfforts`; `CreateSessionRequest.reasoningEffort` maps to the
  SDK's `Options.effort`. Effort is an *open string* end to end — the CLI's vocabulary outruns
  typed unions (its own list includes `max`), and the CLI silently downgrades an effort the
  selected model lacks, so over-offering is safe and under-typing is not.
- The CLI **pushes** a `rate_limit_event` only when a window *changes*, so a session that is
  watched rather than driven would show no plan usage at all. The runner therefore polls the
  structured `/usage` control request after init and after every turn and re-emits the windows as
  ordinary `rate_limit` events (`rateLimitEventsFromUsage` in `core/src/normalize.ts`) — clients
  need nothing new, and replay covers late attachers. That control request is marked experimental
  in the SDK, method name included, so it is probed for by name and every failure is silent: if
  it disappears, usage goes back to change-only, and nothing else breaks.

## Permissions

- Allowing a permission MUST echo the tool input as `updatedInput` (undefined → ZodError → tool
  errors). The fake harness can't catch this class of bug — permission changes need a smoke.
- Switching a live session into `bypassPermissions` needs `allowDangerouslySkipPermissions` at
  spawn (smoke-verified CLI refusal otherwise), which is fixed for the session's lifetime and so
  is reported as `SessionInfo.canBypassPermissions` — a picker disables the mode instead of
  offering a switch the engine will refuse; `auto` mode is gated CLI-side (model/plan
  support, settings opt-out). Rejected `set_permission_mode` = `protocol_error` frame —
  `useClaudeSession` exposes it via `onProtocolError`; SessionPanel toasts it.
- `AskUserQuestion` rides canUseTool; answers = allow with `updatedInput.answers` (question →
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- `PermissionMode`'s vocabulary is Claude Code's; the other engines honor subsets and throw
  otherwise (surfacing as `protocol_error`). **`ENGINE_CAPABILITIES` in protocol is the ONE
  source of truth** for per-engine restrictions — `supportsPermissionMode(engine, mode)` is now a
  lookup into it, create forms filter what they offer from the record, the gateway 400s a
  session/job create with it, startup refuses a profile whose `defaults.permissionMode` fails it.
  Don't re-encode any per-engine list anywhere; a core test pins each adapter's `capabilities` to
  the protocol record *by identity*, so drift is impossible rather than merely tested-for.

## Provider engine (AI SDK v7)

- v7 inverts two conventions this repo had baked in: `result.usage` is **already cumulative**
  across steps (summing per-step usage on top double-counts — `AiSdkRunner` maps it once per
  turn), and a tool without a local `execute` **terminates** the loop rather than pausing it.
  Continuation is therefore message-state replay (persist `responseMessages`, append a
  `ToolResultPart`, re-invoke), not resuming a suspended loop. Approvals map to v7's separate
  `toolApproval` mechanism, not to execute-less tools. v7 is ESM-only and needs Node ≥ 22.
- `AiSdkRunner` STREAMS every leg (`agent.stream`, never `generate`): `stream_delta` per token
  (suppressed by `includePartialMessages: false`) and assistant/tool messages flushed per step —
  so tests must mock `doStream` (model-level parts incl. a `finish` with usage), not
  `doGenerate`; only `generateDigest` still consumes `doGenerate`.
- A third v7 trap (hit live: a deepwiki MCP transport failure hung a session): a thrown `execute`
  yields a `tool-error` part that is **absent from `result.toolResults`** even though the SDK
  already fed the error back and kept looping. Deriving "which calls parked" from `toolResults`
  parks forever on an already-answered call — `AiSdkRunner` derives settled ids from
  `responseMessages` tool parts instead. Related invariants: tool results are spliced BEFORE user
  messages typed mid-park (providers reject non-adjacent results), `interrupt()` rescues a parked
  turn by failing its calls, and a turn whose history already ends with the assistant is skipped
  (double-scheduled turns must not double-generate).
- Provider engines have no `supportedModels()`: the model picker offers `provider.models` as the
  operator declared it on the profile, falling back to `provider.model` alone. Don't ship a
  static model table *for this engine* — it goes stale and lies outright for openai-compatible
  endpoints (the claude/codex catalogs are the deliberate exception: those engines' model sets
  are properties of a pinned binary, not of an operator's endpoint). `SessionInfo.engine` — and
  now `SessionInfo.capabilities` — is reported by each runner itself (not looked up from the
  profile) so any session surface can gate engine-specific affordances; no event carries them,
  the attach snapshot is the only source.
- The `'provider'` engine remains the **host-assembled escape hatch** behind `createEngineRunner`
  — its adapter in core is a pseudo-adapter (capabilities, an `apiKeyEnv` presence probe, an
  empty catalog) whose `createRunner` throws; the server routes provider creates to the hook.
  The `@ai-sdk` provider profiles (openai, moonshotai) are not offered by default anywhere any
  more, but `AiSdkRunner`, its tests, `smoke:live`/`smoke:sdk`, and `examples/provider-server.ts`
  all stay green — they are the proof the path still works, and the route back if those providers
  return as bespoke adapters.

## Codex engine (`codex app-server` / the `@openai/codex` binary)

- **The process model explains everything else**: ONE `codex app-server` JSON-RPC child per
  *session* — spawned lazily, held across turns — with the conversation as a *thread* the binary
  persists in CODEX_HOME. Mid-turn mutability is still off (`setModel`/`setPermissionMode` throw
  mid-turn: the running turn's settings are fixed), but between turns everything is a `turn/start`
  parameter. History: the first codex transport was `codex exec --experimental-json`, one child
  per turn — retired (never released) because its JSONL carries no partial messages at all, so a
  turn could not stream; token streaming is the reason this engine speaks app-server.
- **The wire framing is NDJSON with a bare envelope** (verified 2026-08-05 against 0.146.0 by
  driving the binary): one JSON object per line, `{id, method, params}` / `{id, result|error}` —
  **no `jsonrpc: "2.0"` field** — and notifications carry a top-level `emittedAtMs`. Handshake is
  `initialize` → `initialized` (a client *notification*), then `thread/start`/`thread/resume` →
  `turn/start`. The schema is regenerable from the binary itself:
  `codex app-server generate-json-schema --out <dir>`.
- **The v2 vocabulary is camelCase; the snake_case JSONL you'll find in OpenAI's docs (and our
  pre-0.9.0 history) is exec's, and NOT this protocol**: `agentMessage`/`aggregatedOutput`/
  `exitCode`/`localImage`, `fileChange.changes[].kind` an *object* (`{type: 'update', …}`) where
  the JSONL's was a string, reasoning items carrying `summary[]` (what streams by default) and
  `content[]` (raw CoT, only under an operator config) instead of `text`. The lookalike shapes
  are the trap — don't paste exec-era mappings.
- **Item ids are namespaced per turn, unconditionally** (`<nonce>:<itemId>`): both transcript
  reducers upsert by id, and exec's per-child ids restarting at `item_0` made turn N's answer
  overwrite turn 1's bubble in place (b026e70, reproduced live). Whether app-server item ids are
  unique per thread is unverified, and a respawned child would reset any per-process counter — so
  the discipline stays: a random per-turn nonce (a counter would restart with the process), and
  any new item-derived id goes on the same nonce.
- **Streaming is real tokens** (`streaming: 'token'`): `item/agentMessage/delta` and the
  reasoning summary/text deltas arrive token-by-token, `item/completed` supersedes the stream
  with the final text. The paid `smoke:codex` asserts deltas actually arrive and agree with the
  completed message — the record must never quietly go back to being a lie in either direction.
- **Interactive approvals stay `false`, by policy not by transport**: the protocol HAS the ask
  channel (server→client JSON-RPC requests), but this increment pins `approvalPolicy: 'never'`
  on both `thread/start` and `turn/start` and auto-declines anything that arrives anyway —
  visibly (a `codex.approval_auto_declined` sdk_event), never silently, and unknown server
  requests get a JSON-RPC -32601 rather than a hang (an unanswered request wedges the turn).
  Flip `ENGINE_CAPABILITIES.codex.interactiveApprovals` only when the channel is actually wired
  to the permission surface.
- **The spawn env replaces, never merges**: a `spawn(..., { env })` child inherits nothing, so
  the runner always passes a *complete* environment (a delta silently strands HOME/PATH — and
  the auth chain with them). The profile's `codexHome` pin rides this env (`CODEX_HOME`), which
  is also why `buildRunnerConfig` does NOT pin it the way claude profiles pin
  `CLAUDE_CONFIG_DIR`.
- **Auth is the CODEX_HOME store, full stop** (verified 2026-08-05 against 0.146.0 by driving
  the raw binary): the app-server surface reads **neither** `CODEX_API_KEY` — that env key is
  honored only by `codex exec`, which we no longer ship — **nor** `OPENAI_API_KEY`; with either
  set, a turn goes out with no credential at all ("Missing bearer"). What works is
  `codex login` / `codex login --with-api-key` persisting into `$CODEX_HOME` (file or, under
  `auth_credentials_store_mode`, the OS keyring), which makes `codex login status` exit 0. The
  availability probe therefore trusts `login status` alone, with exact remedies when a stranded
  env key explains the misconfiguration, and anything unparseable maps to 'unknown'. The free
  `smoke:codex --canary` run is the drift alarm for all three facts. Two probe details that
  bite: the "Not logged in" verdict prints on **stderr**, and the success line includes a masked
  key fragment — surface exit codes and fixed strings only.
- **The Keychain trap does not transfer, but not for the reason you'd guess**: codex auth is NOT
  always file-based (`auth_credentials_store_mode` can move it to the OS keyring — a home with no
  `auth.json` can still be logged in). The trap still doesn't transfer because the store is
  chosen by config *inside* the home, not by whether the CODEX_HOME env var is set — so pinning
  the default home is harmless and there is no analogue of the `claudeSessionEnv` skip. Whether a
  keyring-stored login is scoped per home or per user is unverified; multi-`codexHome` profiles
  are verified for file-mode only.
- `@openai/codex` — the npm package carrying the binary — is pinned to an exact minor
  (`~0.146.0`): pre-1.0, and the JSON-RPC schema regenerates per release. It is an **optional
  peer** of core (absent → profiles report unavailable, creates throw the install message; no
  consumer downloads a ~40 MB per-platform binary it never uses) and a real dependency of the
  CLI so the turnkey instance has codex out of the box. The runner drives the binary directly —
  there is no SDK in between (`@openai/codex-sdk` left with exec; it has no app-server client) —
  resolved two hops through the wrapper package to `vendor/<triple>/bin/codex`, the same file
  the wrapper's own `bin/codex.js` execs. Any change to `CodexRunner`'s spawn options,
  handshake, or event mapping requires a `smoke:codex` run — the scripted peer cannot validate
  the real vocabulary.
- **`turn/completed` carries NO usage.** Usage rides `thread/tokenUsage/updated`, whose `last`
  is one model *request*, not the turn — a tool-looping turn updates several times, so per-turn
  usage is the sum of the `last` values seen during the turn, re-mapped to the Anthropic
  convention the whole stack assumes: `inputTokens` minus the cached share (else queue token
  budgets double-count cache-heavy runs), reasoning tokens folded into output, `totalCostUsd: 0`
  = unknown (the AiSdkRunner precedent). `total` is thread-cumulative and unused (its baseline
  after a resume is unknowable). The relation behind the subtraction is asserted in
  `smoke:codex`.
- **Context usage takes the OPPOSITE half of that same notification, and mixing them up is
  silent.** Occupancy is `last.totalTokens` (overwritten, never summed) against
  `tokenUsage.modelContextWindow`, emitted as a `context_usage` event after each turn — because a
  request's input *already contains the whole conversation*, so the newest request IS the current
  window occupancy. Sizing the meter off `total` instead would climb toward 100% on an
  almost-empty thread: measured against 0.146.0, two trivial turns moved `total` 13931 → 27878
  while `last` stayed ~13.9k of a 258400 window (5.1% both times, correctly). So one notification
  feeds two numbers with opposite rules — summed for billing, latest for occupancy — and a core
  test pins both against the same fixture. Two further constraints: the event is emitted only when
  the window is present (a reading without its window is not a reading, and the protocol says
  render nothing rather than 0%), and its `categories` is always empty because codex publishes no
  breakdown — `contextUsage: true` with an empty breakdown is a valid combination, so clients must
  not draw an empty "Breakdown" section (iOS's `ContextSheet` hides it).
- Sandbox mapping is the honest degradation: `default` → read-only ("would have asked" becomes
  "cannot act" — commands still run, writes are refused by the OS sandbox), `acceptEdits` →
  workspace-write, `bypassPermissions` → danger-full-access. `plan`/`dontAsk`/`auto` are not
  offered — they name CLI workflows codex cannot deliver, and a control that silently does
  nothing is exactly what the capability record exists to prevent. The same policy is stated
  twice on the wire — `thread/start` takes a `sandbox` string, `turn/start` a `sandboxPolicy`
  object — keep them in lockstep.
- **Model/effort overrides persist "for this turn and subsequent turns"**, so the runner names
  the model and effort explicitly on every `turn/start`, remembering the resolved defaults from
  the `thread/start` response — that is the only way `setModel(undefined)` can mean "back to the
  profile default" again.
- **A dead child is a failed turn, not a failed session**: the thread lives on disk in
  CODEX_HOME, so the runner drops the connection, fails the in-flight turn with the exit +
  stderr tail, and the next message spawns a fresh child that `thread/resume`s the same thread
  id. `turn/completed(status: failed)` and a rejected `turn/start` land the same way —
  `turn_result: error_during_execution`, session back to idle. Codex has no instructions surface
  (`session.instructions` on a codex profile is refused at startup; codex reads the cwd's
  AGENTS.md), no per-session MCP (CODEX_HOME's config.toml owns servers; `/mcp` 501s), and
  image + text attachments only (images as `localImage` host temp-file paths, text inlined into
  the prompt envelope; a PDF has no representation, and the upload route 415s any kind a
  session's capability record forswears).

## Engine adapters & capability records

- One engine = one `EngineAdapter` in `core/src/engines/` (capabilities, shipped model catalog,
  availability probe, runner factory), looked up via `getEngineAdapter`. The server consumes
  adapters directly — the invariant was never "server touches no engine"; it is (a) `server`
  imports no model SDK, (b) the gateway process holds no credential material, (c) provider
  credential resolution stays in host code. Codex satisfies all three the same way claude does:
  the binary resolves its own auth from the session env.
- `ProfileEngine` stays a **closed union** on purpose: both clients switch exhaustively, the
  Swift mirror ships in lockstep, and a closed set is what lets protocol carry browser-safe
  per-engine defaults. Adding an engine is a versioned protocol event, not a string.
- The capability record is deliberately dual-sourced: `ENGINE_CAPABILITIES` in protocol
  (browser-safe default) and the server-stamped `ProfileInfo.capabilities` /
  `SessionInfo.capabilities` (wire truth — it wins when both exist). The conformance test pins
  the adapters to the protocol record by identity; if per-profile variance ever arrives, the wire
  copy is already authoritative by construction. (A `capabilitiesFor(profile)` seam existed
  briefly while codex had two transports and was removed with the second transport — one record
  per engine again, and a seam that varies nothing must not outlive its variance.)
- Catalogs are versioned with releases; the release checklist re-runs each catalog's extraction
  (documented in the catalog file headers) and diffs. Availability probing is gated on
  `checkCredentials` (a library must spawn nothing in tests), cached ~60s, refreshed lazily on
  `GET /profiles`, and **display-only**: create against an unavailable profile still proceeds and
  fails with the engine's own error — a stale probe must never become an outage. The `engines`
  server option overrides adapters *for tests only*; it is not an extension point.
- `createEngineRunner` may return a promise, so per-session assembly (an MCP connect, a
  credential lookup) can be awaited there, disposed via `AiSdkRunnerConfig.onClose`; a rejection
  fails the create (session POST 500s with the message, a job goes straight to `failed`). The
  example and the SDK smoke still share ONE process-wide MCP client (sessions must not close it)
  — right for one public endpoint, not a constraint any more.

## Tool trust & the sandbox

- Tool trust is load-bearing, not decorative: only `sandboxed` tools may leave the server, and
  they're the ones declared WITHOUT `execute` (the AI SDK halting on those IS the seam). MCP and
  any secret-bearing tool is `authoritative` — bridging one would let a browser forge
  authoritative results. `withMcpTools` throws on a name collision for that reason.
- Sandbox guest limits are interpreter-enforced, but the interrupt deadline **cannot preempt time
  inside a host function** — give every granted capability its own timeout (see
  `QuickJsExecutor#fetchText`). Host↔guest values cross **by value only**; never hand the guest a
  host object by reference (that prototype-chain leak is the CVE-2026-5752 failure shape, covered
  by a red-team test).
- AI SDK MCP lives in `@ai-sdk/mcp` (not `ai`) as of v7, is imported lazily, and supports
  **http/sse only** — stdio is local-only upstream and is rejected explicitly. Claude-engine
  sessions still do stdio, since the CLI spawns those itself.
- `web_fetch` is layered: `createWebFetch` (core) does the SSRF-guarded fetch (DNS-resolved,
  private/link-local denied per redirect hop; cross-host redirects surface a notice instead of
  following; 15-min page cache by URL) and the digest pass runs on the **session's own model**
  via `AiSdkRunner.generateDigest`, which adds its tokens into `#turnAccum` — any extra model
  call made outside that method loses tokens from the turn's accounting. The digest is never
  cached (it's per-prompt).
- `deliver_file` exists only when `onFileDelivered` is wired; `createEngineSession` grants it by
  default (`capabilities.deliverFiles: false` withholds it). Delivered files are downloadable
  only while the session lives — in-memory VFS; durability is the persistence tier.

## Parking & bridged execution

- Parking is a persistence boundary, not an ending, and its invariants are load-bearing:
  `park()` emits `status_changed: 'parked'` and NEVER `session_closed`, snapshots *after* that
  emit and keeps the seq counter (a rehydrated runner continuing at a reused seq is silently
  dropped by the reducer's and client's `seq <= lastSeq` dedupe), and refuses while a leg is in
  flight or any pending call is non-deferred. The runner announces the park only once **every**
  call of the batch has been dispatched — parking on the first `execution_dispatched` would
  snapshot a session whose remaining calls then dispatch into a discarded runner.
- The engine's `state` inside a snapshot is opaque on purpose: typing it would drag `ai`'s
  `ModelMessage` into `packages/server`, which must not resolve a model SDK at all.
  `registry.evict()` (not `remove()`) drops a parked runner — `remove()` closes it. A rebuild
  that ignores `EngineRunnerContext.restore` produces a fresh id and is refused with a loud
  error, because the silent version is a session that quietly forgot its task.
- A durable `SessionStore` persists the record's config, and `toDurableRecord` (what
  `createFileSessionStore` applies) drops four fields from it: `queryFn`, `historyFn`,
  `extraOptions`, `env`. Two are functions JSON would eat silently, and `env` is credentials —
  no store may ever hold those. Nothing is lost, because all four belong to the Claude engine and
  the Claude engine cannot park; a rebuilt provider session resolves credentials through
  `createEngineRunner` from the live environment on every build. A host that smuggles live values
  into `config` for its factory to read back is the one thing this breaks — resolve them in the
  factory instead.
- Store operations are serialized per session (`SessionParkManager#queue`), and that ordering is
  load-bearing the moment writes are real I/O. `#park` MUST evict before the save completes (an
  attach in between binds a client to an inert runner), so there is a window where the session is
  in neither the registry nor the store — a delivery reading past it 404s the caller, files the
  execution as settled, and leaves a record nothing alive can wake; a `discard` reading past it
  deletes nothing and lets the save resurrect a closed session. Read paths (`get`, `listInfo`)
  queue behind the write for the same reason.
- Re-arming a watchdog at `hydrate()` uses `max(expiresAt, now + expiredGraceMs)` (default 60s):
  a deadline that lapsed during a restart must not fire at t=0, or the boot fails every parked
  execution before the delivery that was retrying against a down server can land. Storage-side,
  a file store is single-process (two servers over one directory both hydrate and both rebuild),
  its `list()` reads every transcript into memory, and its directory is plaintext transcripts
  (written 0600 under a 0700 dir). Two things a restart does NOT carry over: `#settled` is
  in-memory, so a duplicate delivery after a restart is a 404 rather than `applied: false`, and a
  parked *job*'s queue-side record belongs to the `QueueAdapter` — a durable `SessionStore` under
  the bundled in-memory adapter wakes a session no job is waiting on.
- Bridged tool calls: the server asks the **first attached** client and fails dispatch fast when
  none is attached (which is why autonomous jobs simply never bridge). Results are idempotent by
  `executionId` — a late answer racing a timeout is expected and must not error the client or
  re-open a settled call. The server feeds every bridged result into the session runner's
  optional `settleExecution` before the host's `bridge.onResult` observer — operators don't wire
  that loop themselves. A runner whose id isn't known yet at assembly time reaches its bridge
  executor via a dispatch-time delegate on `call.sessionId` (see `smoke/sdk-client.ts`). The
  browser guest engine is loaded on first bridged call, never at import; keep it that way (it is
  ~2 MB) and keep the variant an optional peer dep.

## Server, profiles & auth

- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- **A browser cannot authenticate a WebSocket attach with a header** — the `WebSocket` constructor
  takes `(url, subprotocols)` and nothing else, and the one `authenticate` hook guards REST *and*
  the upgrade. So a dashboard has exactly three options: a cookie (sent automatically on a
  same-origin upgrade), a query-string ticket (`ClientOptions.buildWsUrl` exists for this, but
  something has to issue the ticket), or a server-side proxy that stamps the credential on the
  tab's behalf. Baking a key into the served JS is not one of them. `packages/cli` takes the cookie
  route, which is the entire reason it serves the app and `/v1` from one origin via the `fallback`
  option. Anything reached through `fallback` is outside `basePath` and gets no `authenticate`
  call — that namespace is the host's to guard.
- Cookie auth means ambient authority, so CSRF is live: WebSocket upgrades are **exempt from
  CORS**, which makes an explicit `Origin` check — not `SameSite` alone — the actual defense on an
  attach.
- The CLI's generated auth key is two halves of one promise. `resolveInstanceConfig` is pure (no
  I/O), so when auth is required off loopback with no key it only *records* `generateAuthKey` —
  and already stands the Host-header guard down (`allowedHosts: null`) on the strength of it.
  `startInstance` materializes the key (`<stateDir>/auth-key`, 0600, regenerated if corrupt,
  ephemeral when `stateDir` is null) and then refuses to serve if `allowedHosts === null` while
  the built-in auth came up disabled. Keep that assert: it is what turns "auth believed on,
  secret undefined" — a silently open gateway wearing an authenticated banner — into a failed
  start. Relatedly, `insecureHosts` entries match the **bind host** literally (`0.0.0.0` waives
  auth only for the all-interfaces bind, never "any host") and fold into `allowedHosts`, which
  still fences an unauthenticated instance to loopback + declared names against DNS rebinding.
- Profiles pin `CLAUDE_CONFIG_DIR` *after* the `buildRunnerConfig` hook (profile wins over
  hook-set env); profile `defaults` fill unset request fields only. An `ANTHROPIC_API_KEY` in the
  server env still outranks every profile's config-dir credentials (SDK chain) — surface, don't
  fight it. The oauth notice is per-profile.
- **Setting `CLAUDE_CONFIG_DIR` at all changes the CLI's credential source**, not just its config
  dir: set, credentials come from `<dir>/.credentials.json`; unset, the CLI's own resolution runs
  — which on macOS is the login Keychain, where `claude login` puts a claude.ai login. So pinning
  even the CLI's default `~/.claude` turns a working Mac login into "Not logged in · Please run
  /login" (reproduced: same prompt, same cwd, only the env var differs; `apiKeySource` is 'none'
  both ways, so it can't discriminate). `claudeSessionEnv` in server.ts therefore *skips* the pin
  when the baseline env already lands the CLI in the profile's dir — that skip is load-bearing
  (it's what makes the auto-detected `default` profile work on a Mac), and so is its converse:
  a baseline carrying a *different* `CLAUDE_CONFIG_DIR` is still overridden by the profile, or
  two profiles collapse into one identity. A profile whose dir is NOT the default needs its own
  credentials: run `CLAUDE_CONFIG_DIR=<dir> claude auth login` (writes `<dir>/.credentials.json`),
  or inject a long-lived `CLAUDE_CODE_OAUTH_TOKEN` via `buildRunnerConfig` (the launchd pattern
  in `examples/workerdeck.config.mjs`). The `checkCredentials` preflight probes each profile's
  exact session env with `claude auth status` at `listen()` and warns on a logged-out verdict —
  warn-only, silent on "couldn't check", off by default in the library, on in the CLI, and it
  reads nothing but the `loggedIn` boolean (never credential material or account identity).
- Profile management is doubly opt-in (a `profileStore` AND `canManageProfiles`) and the two
  profile sets never mix: `profiles` from server options are code — immutable over HTTP, and they
  win a name collision — while the store holds UI-created ones. `validateProfile` is shared by
  startup and the routes so a POSTed profile can never be one startup would have refused, and
  `managed` is recomputed on every response (never persisted, never trusted from a client). A
  managed *Claude* profile needs `allowedConfigDirRoots`: naming a config dir is choosing a
  credential store, so unset means the routes create provider profiles only. Profiles can't be
  renamed — sessions and jobs are pinned to the name. A store does NOT suppress the auto-detected
  `default` profile; opting out of that is still `profiles: []`.
- Provider-session grants live on `ProfileInfo.session` (`capabilities`, `mcpServers`,
  `instructions`) and narrow — never widen — via `CreateSessionRequest.capabilities`; the gateway
  400s a widening request rather than silently downgrading it. MCP is **named, never configured**
  there: a transport config's headers can carry credentials and `ProfileInfo` is served by
  `GET /profiles`, so the names refer to servers the host connected in `createEngineRunner` and
  `selectMcpTools` filters by the `<server>__<tool>` namespace. For the same reason a provider
  session request carrying its own `mcpServers` is refused (MCP tools are authoritative — a
  client that could name one could point an authoritative tool anywhere); Claude sessions still
  bring their own, since the CLI spawns them under the operator's own config dir.
- **Session notifications subscribe through `SessionRegistry.onRegister`, and three details of
  that seam are load-bearing.** (1) `register()` fires the hook per *runner object*, not per call
   — `prepare()` lists a runner and its caller registers what it returned, so a per-call hook
  fires twice for every Claude session and every notification is delivered twice. (2) The
  subscription starts at `runner.info().lastSeq`, because `Runner.subscribe(fn, afterSeq = 0)`
  **replays the log**: at 0, a session rebuilt from a park re-announces every permission request
  it ever made. (3) The `SessionInfo` snapshot is taken a microtask after the event, since
  listeners run *inside* `#emit`, before the runner has applied what the event means — read
  synchronously, a `session_closed` notification reports `status: 'starting'`. Seq and ts still
  come from the event, so identity and ordering are untouched.

## Host filesystem (`/v1/fs/*`)

- **`cwdAllowed` is not the containment check for these routes, and reusing it would be a hole.**
  It resolves `..` and compares prefixes, which is sound for its own job — vetting a cwd the
  *operator* typed. The `/fs` routes walk paths the *agent* may have authored, so a symlink
  planted inside an allowed root (`root/notes → ~/.ssh`) defeats any lexical check. `host-files.ts`
  decides containment only on `realpath` output, and canonicalizes the roots themselves at
  startup — a root that is itself a symlink (`/tmp` → `/private/tmp` on macOS) otherwise contains
  nothing. Requests go to `realpath` **whole**, never lexically collapsed first: `root/link/..` is
  lexically `root` and physically the link target's parent, and only the physical answer is true.
- **Every filesystem refusal is an identical `404 'not found'`** — outside the roots, escaped via
  symlink, dangling link, and genuinely absent are byte-identical. Anything finer turns the API
  into an existence oracle for paths outside the roots (a planted link answering 403 iff
  `~/.ssh/id_rsa` exists). `403` is reserved for verdicts that leak nothing beyond the roots:
  malformed requests, and in-root targets of the wrong kind. Don't "improve" these messages.
- **Resolve and open are two halves of one discipline.** Resolution's guarantees hold at resolve
  time only, so callers open exactly `ResolveOutcome.path` through `readContained`/`writeContained`:
  `O_NOFOLLOW` turns a final-component swap into `ELOOP`, `O_NONBLOCK` makes a swapped-in fifo open
  instantly rather than parking the request forever, the `fstat` gate refuses non-regular files
  before a byte moves (`/dev/zero` would otherwise be an unbounded read), and truncation happens
  only after that gate. A *parent* directory swapped inside the window can still redirect the
  open — that needs `openat2(RESOLVE_BENEATH)`, which Node does not expose; accepted, documented.
- **Reading follows `allowedCwdRoots`; writing does not.** `hostFiles.roots` is a *narrowing*, not
  the enabling grant — a caller holding the auth key can already start a session in any allowed
  root and have the agent read what's in it, so serving those trees over `/fs` adds no authority
  it didn't have. Writing keeps its own switch precisely because it *isn't* implied: an agent's
  writes go through the permission flow and a `PUT /fs/write` does not. Two boundary cases are
  load-bearing: with neither `hostFiles.roots` nor `allowedCwdRoots` the routes 404 (the
  permissive "unset means anywhere" cwd default is about paths the operator types, never a licence
  to serve `/`), and an explicit `roots: []` disables them rather than falling through to the cwd
  roots — hence `??` and not `||` at the resolution site.
- **Writes are conditional, always.** `expectedHash` (sha256 of what was read) or nothing, and
  nothing means "create" — a path that already exists then 409s. There is no unconditional
  overwrite, because the agent is editing the same tree; a client that lost track of its base can
  only re-read, never force. The response's own hash chains into the next write.
- **`/fs/find` walks, so it must not follow.** The recursive search (`host-file-search.ts`) skips
  symlinks as files *and* as directories: as directories that is the difference between a bounded
  walk and a cycle, and as files it guarantees every path it offers is one `/fs/read` will accept.
  It never resolves a path of its own — it is handed an already-contained directory — which is why
  it lives beside the containment core rather than inside it.
- These routes are **operator-privileged**: authorized by the auth key alone, deliberately outside
  the agent permission flow. That is not the trust story of a tool call — which is exactly why the
  bypass that matters (writing) is its own flag.

## Message attachments (`/v1/sessions/:id/attachments`)

- **The bytes never ride the protocol, and that is the whole design.** A session's event log is an
  unbounded in-memory array replayed to *every* attaching client and captured verbatim into
  parking snapshots. Base64-inlining a phone photo into `user_message` would be paid for on every
  attach, forever, and written to disk by the file session store. So an attachment is uploaded
  first, the command names it by id, and what lands in the log is a `MessageAttachment` reference.
  `SessionRunner.sendMessage` is the seam: it builds the content blocks from the bytes and emits
  the refs. If you ever find yourself putting `data` on a `SessionEvent`, this is why not.
- **An unknown attachment id fails the whole command.** Not "send the message without it" — a
  message that quietly lost its picture reads as the model ignoring it, which is far worse to
  debug than a `protocol_error`.
- **Only three shapes reach a model, and the fourth is refused at the door.** Images (jpeg / png /
  gif / webp) become image blocks, PDFs document blocks, anything textual is inlined in a
  `<attachment name=… type=…>` envelope, and everything else is a 415 at upload. All three are
  verified against the real CLI by `pnpm smoke:media` — the fake `queryFn` harness proves the
  server *builds* the blocks, never that the CLI accepts them on streamed input.
- **`image/heic` is not on that list, and it is what an iPhone shoots.** The transcoding is the
  client's job (`AttachmentNormalizer` in the iOS app), not the gateway's — the gateway would have
  to grow an image pipeline to do it, and the client already has the pixels decoded. It also
  downscales to 1568px, which is roughly what a vision model resizes to anyway.
- **The store is memory, for the session's lifetime, exactly like `/files`.** An attachment 404s
  after a restart and a client then renders a placeholder; the *message* is unaffected, because
  the model saw the bytes at send time. Durability here would mean the gateway looking after a
  photo library nobody asked it to keep.
- **A text attachment's name is put in front of the model.** `safeName` strips path separators,
  control characters and the envelope's own `<`/`"` delimiters — it is client-supplied text
  crossing into both a response header and a prompt.

## MCP status (`/v1/sessions/:id/mcp`)

- **`mcpStatusInfo` drops `env` and `headers`, and must keep doing so.** The SDK's
  `McpServerStatus.config` carries a stdio server's environment and an HTTP server's headers
  verbatim — routinely API tokens. This route exists so a phone can answer "why is my MCP server
  down"; it must never become a way to read the operator's credentials off their own machine.
  `args` *is* forwarded (the operator's own client shows it, and hiding it would only mislead),
  so keep secrets out of argv, not out of this response. A server test asserts both omissions.
- **Tool parameters are not available.** The status payload names and describes each tool and
  carries no input schema, so the CLI's own "Parameters:" block cannot be mirrored. The iOS tool
  screen says so rather than leaving a suspicious gap.
- **The three actions are session-scoped.** `reconnect`/`enable`/`disable` go to the running CLI;
  nothing is written to a `.mcp.json`. The iOS screen's footer says this, because "Disable" on a
  server list otherwise reads as an edit to config.

## APNs push (the CLI's forwarder)

- **Sandbox and production are different token *namespaces*, not just different URLs.** A build
  run from Xcode gets a sandbox token; a TestFlight or App Store build gets a production one.
  Same key, same phone, different token — push one at the wrong endpoint and Apple answers
  `BadDeviceToken` forever. So the environment is a property of *each registered device*, never a
  server-wide flag: the app reads `aps-environment` out of its embedded provisioning profile,
  sends it with the token, and the forwarder routes each token to its own host. A `#if DEBUG`
  guess is wrong for a Release build run from Xcode, which is exactly when you'd be debugging.
- **The provider JWT must carry a raw `r||s` signature, not DER.** `crypto.sign('sha256', …)`
  produces a DER SEQUENCE unless given `dsaEncoding: 'ieee-p1363'`, and Apple's answer to the
  difference is a bare 403 with nothing to debug from.
- **Do not re-sign the provider token per push.** Apple rejects one older than an hour *and*
  rate-limits refreshing it (`TooManyProviderTokenUpdates`); the client caches for 40 minutes,
  which sits in the middle of that window.
- **Apple throttles a provider that repeatedly pushes to invalid device tokens** — connections
  start dying with GOAWAY and cancelled streams that look like a network fault. One probe with a
  bogus token is a legitimate credential check (a good JWT gets `BadDeviceToken`, a bad one gets
  `InvalidProviderToken`); a loop of them is self-inflicted. Relatedly, a stream that never left
  the queue reports only "the pending stream has been canceled", so the client keeps the
  *session's* error and reports that instead — otherwise DNS failure, TLS failure and Apple
  hanging up are indistinguishable.
- `fetch`/undici will not do: APNs is HTTP/2 only, hence `node:http2` directly.
- The APNs key's **environment and restriction scope cannot be changed after the key is created**
  (the portal now forces the choice at creation, and a team gets only two active keys). WorkerDeck's
  is "Sandbox & Production" + "Team Scoped", which is what lets one key serve both endpoints.

## Build, test & packaging

- A package that imports a workspace sibling needs the vitest workspace-source alias (see
  `packages/core/vitest.config.ts`) — the `@workerdeck/source` condition alone isn't enough,
  vite-node externalizes siblings to their unbuilt `build/` entries.
- Inter-package deps are `workspace:*`, and **pnpm must be what packs them**: `pnpm publish`/`pnpm
  pack` rewrite the protocol to the concrete version, `npm publish` does not — npm can't resolve
  it, since this workspace is declared to pnpm alone (no `workspaces` field in the root
  package.json), so it would ship `workspace:*` verbatim and break every consumer.
- **A brand-new package cannot have its first release published by `publish.yml`.** Trusted
  publishing is configured *per package* on npmjs.com, and that settings page only exists once the
  package does — so the first version of a new name has to go out by hand, authenticated normally
  (`pnpm publish --access public` from `packages/<new>`, with 2FA), *then* the trusted publisher is
  configured, and every later release goes through CI. Skip this and the tagged run fails at the
  publish step having already passed the whole gate. The rest of the packages in the same run are
  unaffected — `pnpm publish -r` skips versions already on the registry, so a re-run is safe.
  Observed at 0.5.0: the OIDC exchange 404s (`[WARN] Skipped OIDC:
  ERR_PNPM_AUTH_TOKEN_EXCHANGE`) and the publish then 404s on `PUT` — because npm has no trusted
  publisher to authorise *creating* the name. `pnpm publish -r` walks in dependency order and
  stops at the first failure, so packages after it never publish; check the registry rather than
  assuming the whole run failed.
- **A publish is visible to the write path before the read path.** Straight after publishing a new
  name, `npm view <pkg>` and `npm install` can 404 for minutes while the *packument* is indexed,
  even though `GET /<pkg>/<version>` already returns 200 and `npm access get status` reports it
  public. A re-publish attempt answering `E403 "cannot publish over the previously published
  versions"` is proof the first one worked — do not mistake the 404 for a failed publish and
  re-run. `npm cache clean --force` clears the negative cache locally.
- **Configuring a trusted publisher needs npm ≥ 12**, and the CLI will not tell you why. The call
  is `npm trust github <pkg> --file publish.yml --repo <owner>/<repo> --allow-publish`; the
  registry rejects any config with no `permissions` field, and npm 11 has no concept of one (it
  sends `{type, claims}` only), so every call 400s no matter what you pass. npm 12's
  `--allow-publish` / `--allow-stage-publish` are what become `permissions: ["createPackage"]` /
  `["createStagedPackage"]`, and at least one is mandatory. What makes this expensive to diagnose
  is that npm **drops the registry's explanation**: npm-registry-fetch's `HttpErrorGeneral`
  appends only `body.error`, while the trust endpoint answers with `body.message` — so you get a
  bare `400 Bad Request` and no reason (npm/cli#9377). Anything built on this CLI inherits that
  blindness; read the response body yourself. Two more traps in the same command: `--repo` must
  match the real remote **case-sensitively** or OIDC rejects the token later at publish time, and
  `--file` takes the workflow *filename*, never its path.
- *Running* a trusted publish is a different version floor: npm ≥ 11.5.1 / Node ≥ 22.14, and
  pnpm's own OIDC support needs pnpm ≥ 11.1.0 — `actions/setup-node` writes an unresolved
  `${NODE_AUTH_TOKEN}` into `.npmrc`, and 11.0.8 sent that placeholder as auth (404s). A trusted
  publisher is bound to the workflow *filename*, and a tag runs the workflow from the TAGGED
  commit — so a tag that predates `publish.yml` publishes nothing.
- **A throttled registry read is indistinguishable from a 404.** Under rapid repeated calls
  `npm view <pkg>` answers as though the package does not exist. Any script that branches on
  "is this published yet?" has to retry before believing the negative, or it silently skips
  packages that are in fact on the registry.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- **Everything publishable lives under `packages/`, and that is load-bearing.** Three release
  invariants disagree about paths: `publish.yml`'s tag/version gate reads only
  `readdirSync("packages")`, `version:set` filters `./packages/*` — but `pnpm publish -r` walks
  *every* non-private workspace package, `apps/` included. A publishable package under `apps/`
  would therefore ship while being invisible to both the version bump and the tag check: a stale
  version, silently, on every release. This is why the dashboard is `packages/web` and not
  `apps/web` — it is published, so all three have to agree about it.
- The root package is `workerdeck-monorepo`, not `workerdeck`. The unscoped npm name belongs
  to `packages/cli`, and two packages with one name in a pnpm workspace is a conflict. The root is
  private, so its name is cosmetic — but don't "fix" it back.
- `packages/web` is published as **static files with zero runtime dependencies** — everything it
  builds with (React, the router, Tailwind, the workspace packages) is a devDependency, because it
  all ends up compiled into `dist/`. Declaring any of them a dependency would make consumers
  install a toolchain to obtain files. Its entry (`entry.mjs`) is hand-written and outside vite's
  graph, so the published entry can never drift from the published `dist/`.
- `packages/cli` gets the dashboard from a **runtime dependency** on `@workerdeck/web`, not a
  vendored copy: `resolveWebRoot()` is that package's exported `dashboardDir`. Two consequences.
  In a checkout it resolves to `packages/web/dist`, which only exists once the app has been built
  — dev never builds, so `pnpm --filter @workerdeck/web run build` is a prerequisite for
  running the CLI from source (`resolveWebRoot()` throws with that instruction). And in
  `packages/cli/vitest.config.ts` the workspace-source alias needs an explicit entry for `web`
  *before* the general rule: `web` is an app with no `src/index.ts` for the regex to find.
- The dist is portable only because the SPA builds its client from `location.origin` and uses hash
  history; `packages/web/vite.config.ts` sets no `base`, so assets resolve from an absolute
  `/assets/...` and the dashboard **must be mounted at a domain root**. Subpath mounting would be
  a build-time `base` decision, not a runtime flag.
- `packages/web`'s build drops the legacy `.woff` files that `@fontsource` emits alongside
  `.woff2` (`scripts/trim-fonts.mjs`, ~660 KB). The generated `@font-face` lists `woff2` first, so
  any browser that can run the app never requests them. It happens in the *producing* package so
  every consumer gets one payload.
- The CLI loads `workerdeck.config.mjs` through a dynamic `import()` of a *runtime* path on
  purpose: it is the operator's code, not part of our module graph. Keep the specifier
  non-literal so no bundler tries to resolve it — and note vitest cannot load a config fixture from
  outside the project root, which is why `packages/cli/test` writes them under the package.
