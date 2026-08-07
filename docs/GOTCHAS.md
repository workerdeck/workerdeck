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
- **Approvals are gated TWICE, and neither gate alone is enough** (measured against 0.146.0):
  `initialize` must declare `capabilities: {experimentalApi: true}`, and the `approvalPolicy`
  must be the **granular object** (`{granular: {sandbox_approval, rules, mcp_elicitations,
  request_permissions, skill_approval}}`) — the string vocabulary never asks (plain
  `'untrusted'` silently refused a sandbox-violating write and auto-approved a safe echo; no
  request ever arrived). The runner declares `experimentalApi` unconditionally and has **no
  non-experimental fallback** — a binary that rejects either gate fails the turn loudly, naming
  the capability, instead of quietly not asking. The free `smoke:codex --canary` pins both
  gates.
- **A codex command approval is an ESCALATION after a sandbox refusal, not a gate before
  execution.** The command already ran inside the sandbox and was blocked; the request's
  `reason` is codex's own sentence ("command failed; retry without sandbox?") and accepting
  re-runs the command WITHOUT the sandbox. The runner therefore authors
  `PermissionRequest.title`/`decisionReason` from that reason verbatim and anchors `toolUseId`
  to the already-emitted tool card — clients render the request's own words (both UIs already
  prefer `title`) and never compose a "wants to use X" sentence that would misstate the tense.
  The five wired channels: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval` (allow echoes the
  *requested* profile back, turn-scoped), `item/tool/requestUserInput` (mapped onto the
  AskUserQuestion convention, `questionBehavior` honored), `mcpServer/elicitation/request`
  (allow's `updatedInput` travels as the elicitation `content`). Everything else still gets a
  JSON-RPC -32601 rather than a hang, an unanswered approval times out into the channel's own
  denial (`approvalTimeoutMs`, default 300s), and turn end / interrupt / child death / session
  close all sweep pending approvals — a card never outlives what it gates.
- **`availableDecisions` is per-request, experimental, and gates the ACCEPT side only.** Under
  `experimentalApi` a command approval may carry `availableDecisions` (strings plus structured
  variants like `{acceptWithExecpolicyAmendment: …}`). The runner sends plain `accept` only
  when it's offered, and an allow the request offers no plain accept for is answered with the
  denial *and says so* — a one-shot allow is never widened into `acceptForSession` or a
  persistent execpolicy amendment. `decline` is sent even when unlisted: the response schema
  declares it unconditionally and a live decline against a request whose list omitted it
  completed cleanly (0.146.0) — the list's only "no" alternative, `cancel`, would interrupt the
  whole turn, which is codex's deny-and-interrupt and maps to our deny+`interrupt: true`.
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
- **Rate-limit windows are positional there and named here, so they are named by their measured
  duration.** `account/rateLimits/updated` reports `primary`/`secondary` with a
  `windowDurationMins`, while `RateLimitInfo.rateLimitType` is a *name* clients already act on —
  iOS labels `seven_day` "Weekly" and takes the pace marker's denominator from it. So the runner
  maps by length: 300 min → `five_hour`, 10080 min → `seven_day` (codex's actual primary window;
  these are exact matches, not approximations), anything else → a self-describing `window_<n>m`
  that clients print verbatim and draw no marker for — better than mislabeling a fortnight as a
  week. `status` is 'allowed' by construction as in `rateLimitEventsFromUsage`, with codex's
  `rateLimitReachedType` the one signal that turns it 'rejected'; a window with no `usedPercent`
  is unknown, not zero, and is dropped. Unlike the Claude engine — whose CLI pushes only on
  *change*, hence its `/usage` poll — app-server pushes these **during a turn**, so the runner
  only listens. `planType` becomes `plan_info`, emitted once per change.
- Permission modes ride TWO wire axes in lockstep: the sandbox (`default` → read-only,
  `acceptEdits` → workspace-write, `bypassPermissions` → danger-full-access) decides *what needs
  asking*, and the granular approval policy decides *whether asking happens* (`default`/
  `acceptEdits` all-flags-on, `bypassPermissions` all-flags-off — same shape, so there is one
  code path). So `default` is no longer the old "honest degradation" (read-only + never, where
  "would have asked" became "cannot act"): a blocked write now escalates to a real question,
  which is the closest codex gets to Claude's `default` — with the caveat that approving runs
  the command *unsandboxed*, a bigger grant than approving one Claude edit, which is why the
  request carries codex's own escalation sentence. `acceptEdits` auto-runs in-workspace writes
  (the sandbox allows them, so nothing asks) and still asks for what the sandbox refuses.
  `plan`/`dontAsk`/`auto` are still not offered — they name CLI workflows codex cannot deliver.
  Each policy is stated twice on the wire — `thread/start` takes `sandbox` (string) +
  `approvalPolicy`, `turn/start` takes `sandboxPolicy` (object) + `approvalPolicy` — keep all
  four in lockstep.
- **Model/effort overrides persist "for this turn and subsequent turns"**, so the runner names
  the model and effort explicitly on every `turn/start`, remembering the resolved defaults from
  the `thread/start` response — that is the only way `setModel(undefined)` can mean "back to the
  profile default" again.
- **Resume backfill reads `thread/resume`'s own response, and `turns` is populated ONLY there**
  (plus `thread/rollback`, `thread/fork`, and `thread/read` when `includeTurns: true` — every
  other Thread-bearing response and notification carries an EMPTY `turns` array, so a
  `thread/read` without the flag looks like an empty thread that isn't). Measured against
  0.146.0: items come back `itemsView: 'full'` in chronological order, and item ids restart per
  turn (`item-1`, …), so the replay gives each historical turn its own nonce — the b026e70
  namespacing discipline applies to backfilled turns exactly as to live ones. A non-null
  `turnsBackwardsCursor` on the resume response means the page is partial; the runner then
  fetches the whole rollout via `thread/read {includeTurns: true}` (which has no cursor surface
  at all), and if even that fails it replays the partial page under a `session_error` notice —
  truthful-but-partial must say so. Replay events are stamped `replay: true` in `#emit` (one
  item-mapping code path), a resume's new-turn `user_message` echo is deferred behind the
  replay so it can never precede the history it follows, and a reconnect after a dead child
  goes through `thread/resume` again but stashes nothing — history is never replayed twice.
  Backfill costs no tokens (no `turn/start`), but it does make a promptless resume spawn its
  child eagerly.
- **`thread/list` is how `GET /sdk-sessions` answers for codex — one short-lived child per
  request, closed before responding.** Wire facts (measured, 0.146.0): the page-size param is
  `limit` (not pageSize), `cursor` continues, `sortKey: 'updated_at'` matches the
  `lastModified` ordering clients render, timestamps are epoch **seconds** (protocol summaries
  want ms), and the `cwd` filter is an EXACT path match that accepts an array — pass both the
  spelled and realpath'd forms or macOS `/tmp` dirs silently miss their `/private/tmp` threads.
  The resume id is the row's `id`; the row also has a `sessionId` field and it is NOT the one
  `thread/resume` takes. `ephemeral` rows are dropped (never materialized on disk — nothing to
  resume). Routing: `?profile=` picks whose store to list; absent, exactly-one-profile servers
  resolve implicitly and multi-profile servers keep the legacy claude-store answer, because an
  old client cannot answer a new 400.
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
- **An unmapped `ThreadItem` is invisible, not merely unstyled.** Unknown item types fall to the
  `sdk_event` `codex.<type>` channel, which no UI renders — so a turn that did real work looks
  like it produced nothing. That is how codex's built-in `image_gen` went unnoticed:
  `imageGeneration` and `imageView` are ordinary item variants. When codex adds one, the item
  union is the thing to extend; `codex app-server generate-json-schema --out <dir>` (or
  `generate-ts`) dumps the authoritative list, which is how these were found.
- **A generated image is a host path, never bytes.** `imageGeneration.savedPath` is absolute on
  the host — by default under `$CODEX_HOME/generated_images/`, or in the workspace when the model
  was told the asset belongs to the project. The runner puts it in the tool card's *input* (a
  field, so a client keys a preview off it rather than parsing a sentence), and a client renders
  the picture by reading it back through `/fs/read`. It therefore previews only when the path is
  under an allowed root **and** within `hostFiles.maxFileBytes` (1 MiB default — a full-size
  generated PNG exceeds it); otherwise the card names the path, which is the honest fallback.
  Both defaults refuse the *common* case, so an operator who wants previews declares them —
  `hostFiles.roots` must then restate the cwd roots it replaces, plus
  `$CODEX_HOME/generated_images`, and `maxFileBytes` needs raising to a few MB.
  `examples/dev-server.config.mjs` does exactly this and is the worked example. Grant the
  **drawer, never `~/.codex`**: the same directory holds `auth.json`, and no file route may be
  one path segment away from it. (Making this work without operator config needs the runner to
  *deliver* the bytes rather than name them — a protocol addition; see `_docs/plans/`.)
  The item's `result` is an undocumented free-form string and is length-capped before it reaches
  the event log — assume a long one is an encoded image, and base64 never goes on the wire.
- **The app-server has no slash-command surface at all** — no command-listing RPC exists, and
  codex's own `/model`, `/approvals` etc. are TUI-local. `slashCommands: false` is correct and a
  composer must hide the `/` popover rather than offer an empty one. (`skills/list` does exist,
  so surfacing *skills* is a real possibility — a feature, not a repair.)

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
- **A client renders from the record, never from the engine name.** `TranscriptState.capabilities`
  is always populated (wire copy from the attach snapshot, else the protocol default), which is
  what lets one `SessionPanel` be correct for all three engines. The failure this replaced was not
  cosmetic: gating the model picker on the *`capabilities` event* meant a codex session — which
  never sends one — had no model switcher at all, and could not be switched for its whole life.
  The catalog on `ProfileInfo.models` is the fallback that fixes it.
- **A catalog row's `value` is an alias; a session reports a resolved id.** Rows read `opus[1m]`,
  `sonnet`, `claude-fable-5[1m]`; a running session reports `claude-opus-5[1m]`. Match through
  `ModelOption.resolvedModel` (authoritative when present, *including when it disagrees* — two
  rows of one family differ only there), then fall back to the family token for a server too old
  to send it. Comparing `value` alone is why a chip reads `claude-opus-5[1m]` instead of "Opus 5";
  the rule is written once per client (`ModelSelect.optionMatches`, Swift `ModelOption.matches`)
  and the two must stay identical.

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

## Produced files (`/v1/sessions/:id/produced`)

- **This route has no roots and no byte cap, and that is not a relaxation of `/fs/*` — it is a
  different claim.** `/fs/*` gates paths the *agent* may have authored, which is why it needs a
  root allowlist and realpath containment. A `file_produced` event is authored by the *runner*
  about a file the engine itself just wrote, and the store is built from nothing else. So the
  allowlist here is "the exact paths this session's own runner announced", not "anywhere under a
  directory someone declared" — an exact set of files beats a guess about a tree. The cap is
  absent for the same reason the old default was the bug: a generated PNG is routinely 1–2 MB and
  `/fs/read`'s 1 MiB default refused the common case.
- **Only files the engine *wrote*. Never files the agent *read*.** Codex's `imageGeneration`
  reports a `savedPath` its own tool created — that is a produced file. `imageView` reports a path
  the model chose to look at, which is an agent claim about an arbitrary location, and announcing
  it would hand `/fs/*`'s job to a route with no roots. It stays on `/fs/read`. If you are adding
  a new `file_produced` emission, the question to answer is "did the engine write this?", not "is
  this a file we'd like to show".
- **`fileId` is derived from the path (sha256, truncated), never minted.** Two things depend on
  it: codex reports the same `savedPath` on the progress item *and* the completed one, so a
  derived id makes the second a no-op instead of a duplicate; and a session rebuilt from a park
  re-derives the same ids, so a client's cached URL still resolves.
- **The store subscribes from seq 0 — the opposite of `SessionNotifier`, on purpose.** Replaying
  a permission request is a spurious notification; replaying a `file_produced` is how a rebuilt
  session re-learns what it already produced. Registration is idempotent, so replay is free.
- **The path is re-checked at serve time, not trusted from the announcement.** A file can move,
  be deleted, or become a directory between the event and the fetch — those are 404s, and the
  transcript still shows the path, which is the honest rendering. Bytes are *streamed*: with no
  cap on this route, buffering would put the file size into the gateway's heap.
- Serving is `nosniff` + `content-disposition: attachment`, like `/files` and `/attachments`:
  model-authored bytes must never render as a document on the gateway's origin. An `<img src>`
  is unaffected — disposition does not apply to subresources, which is the point.

## Skills (the `skills` event, `skillsList`)

- **A skill is not a slash command, and the protocol keeps them apart deliberately.** A command is
  wire syntax the CLI parses out of the message. A skill is a capability the *model* chooses from
  its description; there is no `/skillname` any engine recognises, and sending one reaches the
  model as literal text. So skills ride their own `skills` event and their own `skillsList`
  capability — **never** `capabilities.commands`, which means "the CLI accepts these as commands".
  A client may list them and may offer them as a typing aid; it may not render them as command
  chips.
- **Skills complete on `$`, not `/` — and that is codex's own convention, not a preference.**
  Its TUI completes skills on `$` and reserves `/` for commands, its `skill-creator` documents the
  reference form (`Use $skill-x at /path/to/skill-x to solve problem y`), and its bundled prompts
  are written that way ("Use $pdf to …"). So the two are separate triggers in both composers, and
  they behave differently: `/` resolves to a **chip** (the CLI really does parse `/name` out of a
  message), `$` resolves to plain editable **text**.
- **Picking one inserts text; it does not send.** Both clients insert the skill's own
  `interface.defaultPrompt` where it has one, else `$name` — the engine's own spelling beats
  paraphrasing it. The vendored prompt-area grew `TriggerConfig.insertAsText` for exactly this: a
  dropdown that can resolve a row to plain text instead of a chip.
- **`$` completes but is never *styled* in a sent message.** `$PATH`, `$5.00` and any shell
  snippet would otherwise be coloured as skills, and the charset check that saves `/` cannot save
  `$` (`5.00` passes it). Unlike `@` and `/` it is not syntax any engine parses, so a false
  positive buys nothing. Swift's `PromptTokens.scan` skips `.skill` outright; a test pins it.
- **Codex has skills and no commands; Claude has commands and no listable skills.** The two axes
  are orthogonal. Claude's CLI reports skill *names* on `system_init` and nothing else — no
  descriptions, no scope, no suggested prompt — which is not enough to fill a picker honestly, so
  `skillsList` is false there rather than rendering a list of bare words.
- **A promptless session lists skills over a throwaway connection.** `skills/list` needs a live
  child but not a thread, and a codex session otherwise spawns nothing until it has work — so the
  dashboard's "create, then type" flow had no skill list at all, which is the one place codex's
  own TUI beat us. `CodexRunner.start()` therefore spawns a child, asks, and closes it, rather
  than bringing the session's real child up early and parking a codex process behind every
  session someone created and never typed into. It is skipped when a prompt or a resume means a
  connection is coming anyway (a test pins that: one connection, not two), and the session's real
  connection re-lists on arrival — the fingerprint compare makes that a no-op.
- **`skills/list` must be given `cwds` explicitly — the empty case is a trap.** The schema
  documents it as defaulting to "the current session working directory", which reads like the
  thread's. Measured against 0.146.0: with no `cwds`, and *after* a `thread/start` carrying the
  session's cwd, the response comes back keyed to the **app-server child's own process
  directory** — for WorkerDeck, wherever the gateway was launched — and reports no repo-scoped
  skills at all. A project's own `.codex/skills/**` were invisible until the argument was passed.
  A core test pins the exact params.
- **Repo skills live at `<cwd>/.codex/skills/<name>/SKILL.md`** and come back with
  `scope: 'repo'`. `interface` (and so `defaultPrompt`) is a **plugin** concept: it is read from
  a `.codex-plugin/plugin.json` manifest, not from anything beside a `SKILL.md`. A `SKILL.json`
  next to a `SKILL.md` is ignored outright — tested, it produced no `interface` whatsoever. So
  every hand-written skill takes the clients' own fallback opener, which makes that fallback the
  common path rather than the edge case.
- **`skills/changed` carries no payload — it is an invalidation signal.** The runner re-runs
  `skills/list` and republishes only when the result actually differs (a fingerprint compare); the
  watcher fires per touched file, and an event per keystroke would fill the log with identical
  lists. Concurrent refreshes coalesce onto one in-flight request.
- Everything about the listing is best-effort. A binary too old to know the method, a broken
  manifest, a child that died mid-call — none of it fails a session; the panel simply never
  appears.

## MCP status (`/v1/sessions/:id/mcp`)

- **`mcpStatusInfo` drops `env` and `headers`, and must keep doing so.** The SDK's
  `McpServerStatus.config` carries a stdio server's environment and an HTTP server's headers
  verbatim — routinely API tokens. This route exists so a phone can answer "why is my MCP server
  down"; it must never become a way to read the operator's credentials off their own machine.
  `args` *is* forwarded (the operator's own client shows it, and hiding it would only mislead),
  so keep secrets out of argv, not out of this response. A server test asserts both omissions.
- **Tool parameters are engine-dependent, and both halves must be said.** The Agent SDK's status
  payload names and describes each tool and carries no input schema; codex's `mcpServerStatus/list`
  returns the **full JSON Schema** per tool. So `McpServerToolInfo.inputSchema` is optional, the
  tool screens render it where it exists, and the "not available" copy is now conditional — it
  used to claim the absence was universal, which stopped being true.
- **Listing and acting are separate capabilities.** `mcpStatus` says the engine can *list*;
  `mcpServerActions` says it can reconnect/enable/disable ONE server. Codex has the first and not
  the second: its reload RPC is server-wide, and enable/disable would mean writing the operator's
  `config.toml` — a different act from Claude's session-scoped switch. Splitting the axis is what
  keeps a read-only engine from rendering three buttons that do nothing.
- **The route 501s a POST the runner cannot serve, and that check is load-bearing.** `handleMcp`
  dispatches through `runner.reconnectMcpServer?.(…)` — optional chaining, so a missing method
  would no-op and then answer 200 with the unchanged list: a button reporting success having done
  nothing. The method is checked for before dispatch. Clients hide the controls off the capability;
  this is the door behind them.
- **Codex's list response carries no status at all.** Which servers exist and what they expose
  comes from `mcpServerStatus/list`; whether one is *up* arrives separately on
  `mcpServer/startupStatus/updated`, which `CodexRunner` accumulates and merges in.
  **Those notifications only fire for servers that come up while we are attached** — a child whose
  servers were already running sends none at all (measured: a working server with three tools and
  no notification). So *tools imply connected*: they can only have been enumerated over a completed
  handshake, and without that branch a healthy server reads as `pending` forever. A server with
  neither a notification nor tools stays `pending`, which is genuinely ambiguous — not started, or
  disabled in config, and the list response cannot tell them apart. `authStatus: 'notLoggedIn'`
  beats a missing notification and maps to `needs-auth`, because a credential is the thing the
  operator has to act on.
- **The three actions are session-scoped** *where they exist*. `reconnect`/`enable`/`disable` go to
  the running CLI; nothing is written to a `.mcp.json`. The iOS screen's footer says this, because
  "Disable" on a server list otherwise reads as an edit to config.

## Web dashboard

- **`navigator.clipboard` does not exist on the origin this dashboard actually runs on.** It is
  gated on a *secure context* — HTTPS or localhost — and the normal WorkerDeck deployment is plain
  HTTP on a LAN address, reached from another machine or a phone. So the property is `undefined`
  there and `navigator.clipboard.writeText(...)` throws outright. Copy through `copyText`
  (`ui/src/lib/clipboard.ts`), which falls back to `document.execCommand('copy')` over an
  off-screen textarea: deprecated, universally implemented, and the only thing that works here.
  The textarea must be *off-screen* rather than `display: none` — a hidden element cannot hold a
  selection, so the copy would silently do nothing.
- **The dashboard is a build artifact; the packages are not.** `pnpm server` is
  `pnpm dashboard && pnpm cli …`, so the gateway serves `packages/web/dist/` while every package
  resolves to source through the `@workerdeck/source` condition. A long-running `pnpm server`
  therefore keeps serving the JS it was started with — a UI change needs the server restarted (or
  `pnpm dashboard` re-run), even though a server-side change would too. Symptoms look
  web-specific and are not.
- `SessionPanel`'s `header` prop takes a **function** when an embedder wants the session-actions
  (`⋯`) menu in its own chrome: it is called with the menu and the status bar then renders
  without it. The menu can only be built inside the panel (capability record, host-file verdict,
  dialog state), but an app with a real top bar wants it up there — hence the seam rather than a
  second menu.

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
