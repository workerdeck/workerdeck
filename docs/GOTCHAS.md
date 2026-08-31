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
- **The model list needs shaping, and it happens once, in `core/src/lib/normalize.ts`**
  (`modelOptionsFromSdk`) so no client invents its own. Three traps, all live:
  `supportedModels()` leads with a `value: 'default'` sentinel that is a *choice*, not a model —
  a session running on it reports something else, so a picker row for it can never be checked and
  a status bar naming it says "Default" for a session answering as Opus. It is dropped, and its
  `resolvedModel` is forwarded as `capabilities.defaultModel` instead, which is the only way to
  name a promptless session's model before its first turn. `displayName` is the family alone
  ("Opus") or carries a variant instead of a version ("Opus (1M context)"), so rows are renamed
  from their resolved id. And the list is flat: `primary` (newest of each family) is derived here,
  because the CLI reports no grouping and every UI would otherwise guess differently.
  Two more rules live in the same function. The list is **re-sorted into capability order**
  (`FAMILY_ORDER`: fable, opus, sonnet, haiku) because the CLI reports no ranking field; a family
  the list has never heard of sorts *after* the known ones rather than to the top, and ties keep
  the CLI's own order. And a **derived name is used only when it is unambiguous** — two rows of one
  model (a 1M-context variant beside a plain one) derive the same string, and there the CLI's own
  names are the only thing that tells them apart.
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
- **`/clear` is a `conversation_reset`, not a new session — and three of its rules look wrong
  until you know why.** The CLI parses `/clear` itself (no client intercepts the string; plan-mode
  exit arrives on the same SDK message), the runner maps it to the `conversation_reset` event, and
  the reducers empty `items` while keeping session-scoped state. (1) The event log is **never
  truncated**: it still carries `capabilities`, `system_init`, `status_changed` and the other
  state events a fresh attacher depends on — `#fetchCapabilities` will not re-emit — so
  `SessionRunner.subscribe` instead skips *transcript content* strictly below the latest reset,
  with protocol's `transcriptContent` as the rule (broader than `transcriptActivity() > 0`:
  deltas and tool results count zero rows and still mutate items). The reset event itself is
  content, so a superseded reset is skipped with the conversation it cleared and the latest one
  always replays — which is what clears a reconnecting client still holding pre-reset rows, and
  what keeps a pre-reset *client* (protocol 7, no reducer case) correct on its next attach.
  (2) `#activityCount` stays **monotonic** across the reset: it is the unread cursor watermarks
  diff against, and winding it back to the fresh row count would leave every stored mark above it
  and that badge silently dead. (3) The runner adopts `new_conversation_id` as `#sdkSessionId`
  **immediately**, not at the follow-up `system_init` (which only comes with the next prompt) — a
  dormant record written in between must resume the fresh conversation, not replay the cleared
  one. Pending approvals deliberately survive: the runner still holds them, so
  `permission_requested`/`permission_resolved` are state, not content.
- The CLI **pushes** a `rate_limit_event` only when a window *changes*, so a session that is
  watched rather than driven would show no plan usage at all. The runner therefore polls the
  structured `/usage` control request after init and after every turn and re-emits the windows as
  ordinary `rate_limit` events (`rateLimitEventsFromUsage` in `core/src/lib/normalize.ts`) — clients
  need nothing new, and replay covers late attachers. That control request is marked experimental
  in the SDK, method name included, so it is probed for by name and every failure is silent: if
  it disappears, usage goes back to change-only, and nothing else breaks.
- **A session's own rate-limit reading can be arbitrarily old, and the poll has no timer.** Its
  three call sites are a promptless start, `system_init` and `turn_result` — so a session idle
  since yesterday is never refreshed, an attach triggers no poll, and replay faithfully
  re-installs yesterday's number as current (`replayCoalesceKey` keeps the last per window *on
  purpose*). A dormant wake is **not** affected: a fresh log means there is nothing to replay and
  `system_init` polls immediately. The gateway therefore keeps the account-level truth itself —
  `ProfileUsageTracker` (`server/src/services/profile-usage.ts`), fed from every session's `rate_limit`
  events and served as `ProfileInfo.usage` on `GET /profiles`. Two rules there: last-write-wins is
  by the **event's own `ts`**, never arrival order (it subscribes from seq 0, so a rebuilt
  runner's replayed reading must not clobber a sibling session's live one), and the
  **0%-after-reset inference happens at serve time**, because it is a function of the wall clock —
  a fabricated `rate_limit` event would be replayed from transcripts forever and captured into
  parking snapshots. `inferredReset` is what keeps that zero distinguishable from an
  engine-reported one; an absent window is still **unknown, never 0%**. On the client side
  `mergeUsage` (protocol) decides which of the two a surface draws — the profile's per-window
  reading wins wherever it exists, and *not* by comparing timestamps: the reducer keeps one clock
  for the whole map, so a session's morning `five_hour` is dated with its afternoon `seven_day`
  event and would beat a fresher profile entry.
- **The CLI's own session title is a poll, not an event.** No member of the `SDKMessage` union
  carries it; it lives on `SDKSessionInfo.summary` / `.customTitle`, which only `getSessionInfo`
  and `listSessions` return. `SessionRunner` reads it at `system_init` and after each turn
  (`#fetchEngineTitle`), and two rules keep it honest: it is **not read at all while `meta.title`
  is set** — a rename is a person's decision, and not fetching means nothing is stored waiting to
  resurface if the rename is later cleared — and `summary` is taken only when it **differs from
  `firstPrompt`**, because the SDK falls back to the first prompt before a session has a real
  title, and `sessionTitle()` (`core/src/lib/title.ts`) already has its own prompt fallback.
- **A resumed transcript carries no structure.** `getSessionMessages` returns exactly
  `{ type, uuid, session_id, message, parent_tool_use_id, parent_agent_id, timestamp }`: `isMeta`,
  `isSidechain`, `promptSource` and `origin` are all dropped, and `isMeta` entries are filtered
  out by the SDK itself. So the backfill cannot mark a harness message synthetic from structure
  the way the live path does — `isSyntheticUserText` (`core/src/lib/normalize.ts`) matches the CLI's
  own wrappers instead, and only `<task-notification>` / `<local-command-caveat>`. That stamping
  belongs in the **runner, not the reducer**: `transcriptActivity` counts a non-synthetic user
  message as a row, so a row the client hides but the count counts is an unread badge for work
  nobody typed.

## Permissions

- **A turn that ends under a standing approval must be *deferred*, not discarded.** Session status
  is purely edge-driven — no poll, no reconciliation, ~11 `#setStatus` call sites — so a single
  dropped edge is permanent for the life of the session. `awaiting_approval` rightly outranks
  `idle` for *display*, but the guard used to `return` on the turn-over signal (both the SDK's
  `session_state_changed` and the `turn_result` fallback), and `#settleApproval` then asserted
  `running` on the assumption that an answered approval means work resumes. When the turn was
  already over — an interrupt, an approval timeout — the session claimed to be running a turn that
  had produced its result, **for hours, on every client at once**, because it is one runner field
  faithfully rendered three times. So `#turnOverWhileBlocked` remembers the fact and the settle
  path applies it; it is cleared the moment work genuinely resumes, because a turn-over belongs to
  the turn that produced it and must not settle the next one. Tests in `core/test/runner.test.ts`
  §"status after a turn ends under a standing approval" — including the two that must keep
  passing, the ordinary resume and the stale-turn-over case. The codex runner does not share this:
  it applies `idle` ungated at turn end, so it has the inverse (and harmless) display trade.

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

- **`disableBypassPermissions` is the server-wide mirror of Claude Code's
  `permissions.disableBypassPermissionsMode`, enforced at the gateway.** It refuses
  `permissionMode: 'bypassPermissions'` on session/job creation (403) *and* strips the
  `allowDangerouslySkipPermissions` pre-authorization from requests — stripping rather than
  refusing, so clients that ask for the capability by default keep working and only their later
  switch attempt fails, with the CLI's own visible error.

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
- `createEngineRunner` has four obligations invisible in its types, and each is a runtime-only
  failure: forward `restore` (else a woken session starts empty), adopt `id` (else the rebuild is
  refused and every client's route and watermark is stranded), seed the VFS only when *not*
  restoring (else the wake overwrites what the parked turn wrote), and dispose per-session
  resources in `onClose` (which **also runs on park** — parking releases the same things). Two of
  those now have first-class options — `createEngineSession({ seedVfs, id })`, where `seedVfs` is
  ignored outright on a restore — and `createProviderRunner` (server) does all four. Hand-building
  `config.vfs` still works and still wins, and then the `restore ? undefined : createVfs(...)`
  dance is yours to get right.
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
  **And the window codex reports is a PRICING policy, not the model's size** — which is why a
  1M-class model reads ~258k, why that reading is nonetheless correct, and why it is the
  *operator's* to change. Measured 2026-08-24 against 0.149.0 on `gpt-5.6-terra`, whose published
  API limits are **1,050,000 context / 922,000 max input / 128,000 max output**:

      default (nothing set)          -> modelContextWindow 258400
      model_context_window = 500000  -> modelContextWindow 475000
      model_context_window = 900000  -> modelContextWindow 828400

  The catalog compiled into the binary says terra is `"context_window": 272000,
  "max_context_window": 872000`, and `ModelInfo` carries an `effective_context_window_percent`.
  The three readings pin the formula exactly:

      reported = min(model_context_window ?? context_window, max_context_window) x 0.95

  So **272000 is not a capability, it is the price tier**: OpenAI's own docs say prompts over
  272K input tokens are billed at 2x input / 1.5x output *for the whole request*, and codex's
  default sits on that boundary. The 5% is a reserve. The practical consequences:
  - The meter is honest — it reports the window codex has actually budgeted for the thread, which
    is what decides when auto-compaction fires. It is not the model's ceiling and was never
    claiming to be.
  - An operator who wants the big window sets `model_context_window` in their own
    `~/.codex/config.toml` (up to 872000 → 828400 reported; codex clamps to `max_context_window`,
    which is itself below OpenAI's stated 922,000 max input). That is a real cost/quota decision,
    not a display setting, which is exactly why it belongs to them — same posture as
    `network_access`, and the same red line: **WorkerDeck never writes it.** Carry the caveat with
    the advice: openai/codex #16068 (closed as a duplicate of #16033) reports that setting it
    **breaks auto-compaction permanently** after the first overflow — `fill_to_context_window()`
    writes a near-zero delta into `last_token_usage.total_tokens` and the check never fires again.
    Reported against 0.116/0.117, unverified by us on 0.149.0. So the honest phrasing is "raise it
    and watch for compaction failing", not "raise it".
  - **The cap moves between releases**, so a reading from a past session is not evidence against a
    reading today: openai/codex #32806 documents Sol going 372000/353400 → 272000/258400, and
    #30875 reports 5.5 oscillating between the two. Nothing to do about it; just do not treat a
    remembered number as a contradiction.
  - **"But I reached 800k tokens" is the `total`-vs-`last` trap wearing a different hat.** The TUI
    prints `Token usage: total=…` (thread-cumulative) *beside* a `% context left` readout
    (occupancy). A long session passes 800k cumulative without occupancy ever leaving the window,
    because **auto-compaction keeps resetting it** — which is how "I just kept going naturally"
    happens. Note what that implies for us: codex's `contextCompaction` is one of the ThreadItem
    variants we do **not** map, so on a WorkerDeck surface that summarisation is completely
    invisible and the ring simply drops for no stated reason. Brief:
    `_docs/features/codex-compaction-invisible.md`.
  - **Never hardcode a window in our catalog to "correct" this.** A table in this repo that
    disagrees with the binary is the exact failure mode the engine catalogs exist to avoid — and
    here it would also be wrong for every operator who had set the override.

  Still unverified: whether the reported window can *move* mid-thread. Nothing observed does this,
  but if it ever did, the meter's denominator would change between turns — the occupancy rule
  (newest `last.totalTokens` against the newest window) already handles it, and nothing pins it.
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
  `plan`/`dontAsk` are still not offered — they name CLI workflows codex cannot deliver.
  Each policy is stated twice on the wire — `thread/start` takes `sandbox` (string) +
  `approvalPolicy`, `turn/start` takes `sandboxPolicy` (object) + `approvalPolicy` — keep all
  four in lockstep.
- **`auto` IS offered, and it is a THIRD axis — *who reviews* — not a fourth sandbox.**
  `ENGINE_CAPABILITIES.codex.permissionModes` carries it. Codex's own "Approve for me" is
  workspace-write + ask — the same sandbox and the same granular flags as `acceptEdits`, because
  without the flags there is no request for a reviewer to answer — plus
  `approvalsReviewer: 'auto_review'` on `thread/start` *and* `turn/start`, which routes every
  approval to codex's risk-assessing subagent instead of to the user. The reviewer is stated
  explicitly for every mode (`'user'` for the other three) rather than omitted for the default: a
  thread inherits it across turns, so leaving it unset lets a stale `auto_review` survive a switch
  back to a user-reviewed mode. **The semantic gap no client may paper over**: the Claude engine's
  `auto` classifier is operator-configurable (`autoMode.environment`, allow/soft_deny/hard_deny),
  while codex's reviewer is a fixed, OpenAI-prompted subagent with no configuration surface at
  all. Same mode name, different tunability — say so wherever the mode is explained.
- **Network access is NOT an approval question, and `turn/start`'s object-form sandbox policy
  will silently take it away.** Codex has three independent axes, not two: sandbox mode, approval
  policy, and — inside workspace-write only — `network_access`, which is **off by default** and
  which no approval policy turns on. So a `git push` under `acceptEdits` does not raise a
  question; it fails with `Could not resolve host`, because a DNS failure is not a sandbox denial
  and there is nothing to escalate. The operator's `[sandbox_workspace_write] network_access =
  true` in `config.toml` is the only supported answer (per-host allow/deny via the managed
  network proxy is codex's newer, finer one; WorkerDeck does not wire its approval decisions
  yet). WorkerDeck sets none of this — but it must not *unset* it either, and that is the trap:
  `turn/start`'s `sandboxPolicy` object is serde-defaulted **field by field**, so sending
  `{type: 'workspaceWrite'}` bare resets `networkAccess` to false and `writableRoots` to empty on
  every single turn, overriding config.toml with no error and no notice. Measured against 0.149.0
  with `network_access = true` set: bare object → `curl: (6) Could not resolve host`, fully-stated
  object → `200`, policy omitted → `200`. Omitting it is not the fix (restating the policy each
  turn is what makes a between-turns permission-mode switch take effect), so the runner reads
  `config/read { cwd }` — which resolves project layers for that cwd — once per child and echoes
  the block back verbatim. `read-only` is deliberately untouched: the setting is scoped to
  workspace-write, as its name says, and a read-only sandbox has no network either way (measured
  both ways). A free canary in `smoke:codex` pins the `config/read` block's four fields; if it
  ever stops reporting them the runner degrades to the bare shape and the clobber is back.
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
  **`pnpm smoke:codex --canary` now pins that union**, and it exists because "we noticed" was not
  a strategy: the alarm fails on a variant that is *new* since 0.146.0 and warns on one that is
  merely unmapped, and it is free (a local dump out of the binary we ship, no network or auth). It
  currently reports **9 of 18 unmapped** — including `collabAgentToolCall` and `subAgentActivity`,
  i.e. codex's entire multi-agent surface, which has been arriving invisibly ever since we
  upgraded. So the standing claim to be careful with is not "codex has no sub-agents" but "we have
  never mapped them"; the brief is `_docs/features/codex-multi-agent.md`.
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
  *deliver* the bytes rather than name them — a protocol addition, not yet designed.)
  The item's `result` is an undocumented free-form string and is length-capped before it reaches
  the event log — assume a long one is an encoded image, and base64 never goes on the wire.
- **A sub-agent is a SEPARATE THREAD on the same connection, and `threadId` is the only thing
  that says so.** Codex's multi-agent surface is live in ordinary sessions *today* — we never send
  `multiAgentMode`, but the operator's config enables it and codex's default posture is
  `explicitRequestOnly`, so a user who asks for sub-agents gets them. A spawned agent announces
  itself as a `subAgentActivity` item on the root thread (`{id, kind, agentThreadId, agentPath}`;
  `kind` is `started|interacted|interrupted` — **there is no `completed`**, the child thread's
  `turn/completed` is the finish; codex sends no `tool_use` for a spawn either, so the runner
  authors the anchor call itself as `CODEX_AGENT_TOOL`, which is what every agent affordance
  downstream keys off), and thereafter its items, its deltas, its token usage and its
  own turn lifecycle all arrive on the **same JSON-RPC connection**, distinguished only by the
  `threadId` every notification carries. Two consequences, and the first shipped as a bug:
  **(a) thread-scoped notifications must be read off the root thread only.** `turn/started`,
  `turn/completed` and `thread/tokenUsage/updated` are per-thread facts. A child's `turn/completed`
  arrives while the root turn is still running — measured, ~14 s early — and taking it ended the
  session's turn, published the *sub-agent's* last line as the turn result, and silently dropped
  the root's real answer (every later item fell outside a turn). `THREAD_SCOPED_NOTIFICATIONS` in
  `runner.ts` is that gate; the regression test scripts the exact sequence.
  **(b) items and deltas are deliberately NOT filtered** — a sub-agent's work belongs in the
  transcript. Un-attributed it reads as one agent contradicting itself, which is why attribution
  by `threadId` is the feature this gate makes possible rather than a separate idea.
- **`WORKERDECK_CODEX_TRACE=<file>` dumps the raw inbound app-server traffic** (notifications and
  server→client requests, JSONL, appended). It is off unless set, and it deliberately skips
  `account/*` and `login*` — the one place this protocol can carry a masked credential fragment,
  which nothing of ours writes to disk. Reach for it whenever a question is about *what the child
  actually sent*: the whole sub-agent finding above came out of one traced turn, after a wire
  capture of the same session had been read three ways and still hidden the child threads.
- **The app-server has no slash-command surface at all** — no command-listing RPC exists, and
  codex's own `/model`, `/approvals` etc. are TUI-local. `slashCommands: false` is correct and a
  composer must hide the `/` popover rather than offer an empty one. (`skills/list` does exist,
  so surfacing *skills* is a real possibility — a feature, not a repair.)
- **A clear is a FRESH THREAD on the same session, because codex has no reset RPC.** The near
  neighbours are all something else: `thread/compact/start` summarises and continues,
  `thread/fork` makes a second thread, `thread/goal/clear` is unrelated. So `clearContext()` drops
  `#sdkSessionId`, sets `#threadLoaded = false` and lets `#ensureThread()` do `thread/start`
  instead of `thread/resume` — the dead-child path minus the resume. Four things ride with it, and
  each was a bug waiting to happen:
  **(a) It rides the TURN CHAIN, and that is the whole safety argument.** The chain is what
  serialises everything that touches `#ensureThread` — every `#runTurn`, *and the resume
  backfill, which is a chain link and is NOT a turn*. A guard on `#activeTurn` looks equivalent
  and is not: websocket frames are not serialised with each other, so a `clear_context` arriving
  mid-backfill passed that guard, issued a concurrent `thread/start`, and then — depending on who
  won — either had the resume re-adopt the old thread id and replay the cleared conversation at
  seqs *above* the reset, or silently lost the backfill. Two `thread/start`s in flight is the
  other shape of it: whichever resolves last owns `#sdkSessionId`, `#isRootThread` then misroutes
  the running turn's `turn/completed` to the agent path, and the turn never settles — a wedged
  chain, with `interrupt()` hanging on it. So: one entry point, on the chain, for both callers.
  **A corollary: it must NOT wipe `#queue`.** By the time the clear link runs, every message
  queued before it has already run; whatever is left was typed *after* and belongs to the new
  conversation. Wiping it swallowed exactly those, silently.
  **(b) The new thread id is adopted BEFORE `conversation_reset` is emitted** whenever a child is
  already up (an eager `thread/start`; it costs no tokens and no model call). This mirrors the
  Claude engine, whose reset adopts the SDK's `new_conversation_id` immediately for exactly the
  same reason — a dormant record written in between must name the fresh conversation, not the
  cleared one. The fallible step goes first and **rolls back**: a failed `thread/start` restores
  the old id, because half-clear (id dropped, transcript intact, no reset emitted) is the worst
  outcome of the three.
  **(c) With no live child there is no id to adopt**, and the session sits with *no*
  `sdkSessionId` until its next turn. The parking service treats that as "nothing to come back
  to" and **deletes** the stale dormant record (`#forgetDormant`, narrower than `discard`, which
  would also drop the config and end the session's ability to go dormant ever again). Without
  this, a restart in that window wakes the session into the transcript the user just threw away.
  **Know what that costs**, because it is the designed trade and not a bug: for codex the dormant
  record *is* the session's way back, so a session cleared while its child is dead does not come
  back after a restart at all — the row is simply gone. Losing an emptied conversation beats
  waking into one that was deliberately discarded. Verified live 2026-08-24
  (`pnpm smoke:restart codex clear`).
  **(d) The context reading is retired, and cannot be re-polled.** Claude re-polls after a reset;
  codex's only source is `thread/tokenUsage/updated`, which arrives *during* a turn. So there is
  no reading at all until the next turn runs, and the protocol's standing rule applies — render
  nothing, never 0%. The event log's `conversation_reset` fold (`core/src/lib/event-log.ts`)
  already did this for all three engines.
  **(e) Sub-agents are `forget()`-ten, not `sweep()`-ed — and remembered.** Sweep settles the
  running ones as failed and *keeps the rows*, which is right when the process dies (the anchor
  `tool_use` cards are still in the transcript). A clear is the other way round: the anchors go
  with the transcript, so a surviving row would publish a `toolUseId` that resolves to nothing —
  and both clients key a pressable, enterable agent line off exactly that id. But an agent
  **outlives the root turn that spawned it by design**, and a clear neither interrupts it nor
  drops the child, so its traffic keeps arriving on the same connection: `#agentFor` would find no
  record and *mint a fresh anchor*, streaming the cleared conversation's agent work into the new
  one. Hence `#clearedThreads` — their ids are remembered for the session's life and their
  notifications dropped. Pending approvals go the same way: a card whose anchor was just cleared
  can never be answered against anything the user can now see.
- **`/clear` typed into a codex composer is intercepted by the runner**, and that is deliberate
  duplication of the capability route, not a shortcut around it. `slashCommands: false` meant the
  string went to the model as an ordinary prompt and got an ordinary answer — it did not error,
  which is worse than erroring, because it looked like it might have worked. The intercept is
  narrow on purpose (the bare word after trimming, and no attachments; `explain what /clear does`
  is a prompt) and it is the **same call the command makes** — one entry point, deliberately, for
  the reason in (a). A clear sent while a turn is running **queues** behind it rather than cutting
  it short: a clear is not an interrupt, and one that landed in the middle of the turn it was
  clearing would be neither.
- **The cleared thread is not deleted and should not be.** It stays in CODEX_HOME and stays
  resumable from `GET /sdk-sessions`. Worth saying out loud in any UI copy, because "clear" reads
  as "gone". Verified live 2026-08-24: resuming the pre-clear thread replays its whole
  history, and resuming the post-clear one replays only what came after.
- **The context reading cannot witness a clear — only a codeword can.** A fresh codex thread
  already reads **~14k tokens before anyone types**: the system prompt, the tool schemas and the
  skill list are the floor of the window, not a conversation. So two small turns either side of a
  clear both read ≈ that floor, and "the reading got smaller" is indistinguishable from noise —
  measured 2026-08-24, the post-clear turn read **higher** than the pre-clear one (13909 → 14028,
  purely because the second prompt was longer). The only honest proof that the *model's* context
  was reset is asking it for something it was told before the clear and watching it fail;
  `pnpm smoke:codex --clear` does exactly that, and the reading is reported rather than asserted.
  The same floor is why a codex ring never starts near empty.
- **A project's `.codex/config.toml` is only read if that project is TRUSTED — and in a read-only
  sandbox codex cannot ask, so it silently reads nothing.** Codex gates project config on a
  `[projects."/abs/path"] trust_level = "trusted"` entry in `$CODEX_HOME/config.toml`. The vanilla
  TUI prompts ("do you trust this folder?") and writes it; `codex app-server` has no prompt. So a
  session on a project nobody has opened in a terminal ignores its `.codex/config.toml` entirely —
  MCP servers, model pins, all of it — with no error and no log line. Measured 2026-08-22, 0.149.0
  and the bundled 0.146.0 identically: flipping only the trust entry moves `codex mcp list` from 0
  project servers to 1.
  **The gate is SANDBOX-SCOPED, which is the part that misleads.** Only `read-only` — WorkerDeck's
  `default` mode — leaves the project untrusted. A `thread/start` under `workspace-write` or
  `danger-full-access` (`acceptEdits`, `auto`, `bypassPermissions`) **writes `trust_level =
  "trusted"` into the operator's own config.toml** and then loads the project config. Verified by
  driving app-server against a throwaway CODEX_HOME: read-only left the file untouched,
  workspace-write appended the entry. Two consequences: a notice in the wider modes would be
  *false* (hence the `default`-only gate in `#warnUntrustedProject`), and **codex writes trust
  entries on our behalf there even though WorkerDeck itself never does**. A mid-session widen does
  NOT heal an already-started thread — a `turn/start` carrying a `workspaceWrite` policy on a
  read-only thread loaded nothing and wrote nothing.
  **Discovery and trust are per-layer, and neither is "walk up forever".** The layer chain is the
  cwd and its ancestors **up to and including the nearest directory containing `.git`** (dir or
  file); with no git anywhere, the cwd alone. Every layer's `.codex/config.toml` is loaded. Trust
  is decided per layer: an exact entry for that layer's canonical path wins (an explicit
  `"untrusted"` beats inherited trust), otherwise it inherits **only from the chain's git root's**
  entry. So a trusted mid-chain directory does not trust its children, a nested repo is not
  covered by the outer repo's entry, and a linked worktree inherits from its *main* repository
  (via the `.git` file's `gitdir:`). `trust_level` accepts exactly `trusted`/`untrusted` —
  anything else fails codex's bootstrap outright.
  **Canonicalize both sides.** On macOS `/tmp` symlinks to `/private/tmp`, and codex canonicalizes
  the cwd before matching; a hand-rolled comparison against a non-canonical entry reports a
  trusted project as untrusted. This fooled the original diagnosis.
  Three things that are NOT the gate, each of which looked like it: the codex version, whether the
  directory is a git repo (it shapes the layer chain, it does not gate), and spawn cwd —
  `process.ts` deliberately passes none, and that is correct, because codex resolves project
  config from the *thread's* cwd.
  `engines/codex/trust.ts` implements the match and emits the notice as a `session_error` at
  session start; its parser refuses anything it cannot read with certainty (multi-line strings,
  inline-table `projects`, array-of-tables, conflicting duplicates) because **a false notice is
  worse than a missed one**. We deliberately never write the trust entry ourselves — granting
  codex a privilege on the operator's behalf sits against the codex auth red lines in `CLAUDE.md`.

- **`SubagentInfo.toolUseId` keeps its documented meaning on codex.** The spawn signal is the
  `subAgentActivity` item, whose own `id` is the model's `spawn_agent` call id — a genuine tool-use
  id — so the runner authors the anchor `tool_use` itself and keys every event of the agent's
  *thread* to it (`engines/codex/subagents.ts`).

- **The sub-agent tracker keys by thread id and publishes a tool-use id; do not confuse the two
  vocabularies.** `engines/codex/subagents.ts` is deliberately NOT the claude tracker generalised —
  that one infers spawns from tool names and verdicts from result-text sniffing, while
  `subAgentActivity {kind: 'started'}` positively announces an agent, names it (`agentPath`), keys
  it (`agentThreadId`, the id every later notification carries) and hands over the model's own
  `spawn_agent` call id. So the map is keyed by **thread id** — the wire's handle — while
  publishing a **tool-use id**: `parentToolUseId` on nested events must equal the anchor
  `tool_use`'s id for `subagentItems` (the frame-membership rule every client shares) to reassemble
  the sidechain. A record survives the runner's turns, because codex agents are designed to outlive
  the root turn that spawned them; what ends them all is `sweep()` when the app-server child dies or
  the session closes, since an agent whose host process is gone can never report, and `running` on a
  closed session is a lie a 1.2s-polled list re-renders forever. The settled tail is bounded by
  `SUBAGENT_HISTORY` and enforced at *settle* time (once per agent) rather than at `list()` time
  (once per row of that poll); running records are never capped.
- **An unannounced non-root thread still gets an agent record.** `#agentFor` mints one for any
  thread emitting items on the connection — codex runs threads of its own for review/compact, and a
  `subAgentActivity` could in principle be missed — which is the claude tracker's nested-event
  fallback on a stronger signal. The minted record is label-less and its anchor `tool_use` is
  authored on the spot, because an attributed event whose `parentToolUseId` matches no top-level
  call renders inline instead of as a frame; a late `started` edge fills the name in.

## Engine adapters & capability records

- **`checkAvailability` and `listSessions` take the profile's *complete* session environment,
  never a delta.** `AvailabilityTracker` passes `sessionEnvFor(profile)` — the same assembly the
  real create path produces. A delta would be a plausible-looking optimization and a broken one:
  codex replaces its child env wholesale, so a delta strands `HOME`, `PATH` and the auth chain with
  them, and the probe would answer about an environment no session ever runs in.

- One engine = one `EngineAdapter` in `core/src/engines/` (capabilities, shipped model catalog,
  availability probe, runner factory), looked up via `getEngineAdapter`. The server consumes
  adapters directly — the invariant was never "server touches no engine"; it is (a) `server`
  imports no model SDK, (b) the gateway process holds no credential material, (c) provider
  credential resolution stays in host code. Codex satisfies all three the same way claude does:
  the binary resolves its own auth from the session env.
- **`JobQueue.submit` deliberately does not validate `cwd`, and must not start.** Whether a
  session needs one is the engine's capability record (`EngineCapabilities.hostCwd`), which the
  gateway resolves at the door via the session factory's `checkCwd`. A second, engine-blind copy
  of the rule inside the queue would refuse the filesystem-less provider engine outright.
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
  (codex's is in that file's header, claude's in `docs/RELEASING.md`) and diffs. Availability probing is gated on
  `checkCredentials` (a library must spawn nothing in tests), cached ~60s, refreshed lazily on
  `GET /profiles`, and **display-only by default**: create against an unavailable profile still
  proceeds and fails with the engine's own error — a stale probe must never become an outage. That
  default is an *operator's* trade, and it is wrong in front of an end user who cannot read a
  provider stack trace, which is why `requireAvailableProfile` exists: it 503s the create with the
  probe's reason. It refuses only on a definite `false` — an unprobed or unprobeable profile stays
  allowed, because "couldn't check" is not "not available". The `engines` server option overrides
  adapters *for tests only*; it is not an extension point.
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
- Host tools go in through `createEngineSession({ tools })` **with a stated trust**, and the two
  contradictions are refused at assembly, not at runtime: a `sandboxed` tool carrying `execute`
  would run in-process with the gateway's authority (defeating the point), and an `authoritative`
  one without `execute` would park the turn on a call no executor claims. `mcpTools` cannot express
  a sandboxed tool at all — everything in it is authoritative by construction.
- AI SDK MCP lives in `@ai-sdk/mcp` (not `ai`) as of v7, is imported lazily, and supports
  **http/sse only** — stdio is local-only upstream and is rejected explicitly. Claude-engine
  sessions still do stdio, since the CLI spawns those itself.
- **A stateless MCP server must answer `GET` with 405.** The client opens the SSE stream with a
  `GET` before it sends anything; mounted under a framework's default 404 the entire connect fails
  with an error naming neither the method nor the route. Cost an hour in `apps/embedded`, and it
  will cost every embedder who mounts a POST-only server — which is the common case.
- **A declared MCP server that didn't connect refuses the build.** `profile.session.mcpServers` is
  a *declaration*; honouring it partially was the worst failure mode this engine had — the session
  reports healthy and the agent apologises through every request that needed the server, with one
  warning line in a log nobody reads. `connectMcpTools(…, { required: true })` fails at connect
  time instead (closing the clients that did open, or an embedder leaks a socket per failed
  create). Hand the **connection** to `createEngineSession` as `mcp`, not just `mcp.tools`: a tool
  set alone cannot tell "connected, exposes nothing" from "never connected", so the fallback check
  is the cruder namespace one.
- The provider engine's `mcpStatus` capability is `true` and `AiSdkRunner.mcpServers()` always
  answers — an **empty list** when no MCP was wired, never `undefined`. Undefined becomes a 501
  meaning "this engine cannot tell you", and this is the one engine that always can: the host
  assembled the session and the host is being asked.
- `web_fetch` is layered: `createWebFetch` (core) does the SSRF-guarded fetch (DNS-resolved,
  private/link-local denied per redirect hop; cross-host redirects surface a notice instead of
  following; 15-min page cache by URL) and the digest pass runs on the **session's own model**
  via `AiSdkRunner.generateDigest`, which adds its tokens into `#turnAccum` — any extra model
  call made outside that method loses tokens from the turn's accounting. The digest is never
  cached (it's per-prompt). One limit the layering does not close: the guard resolves the hostname
  itself and then hands the URL to `fetch`, which resolves it **again** — a DNS-rebinding TOCTOU
  this tier accepts rather than closes. An operator who needs the check bound to the connection
  supplies `fetchImpl` with a pinned agent; nothing in core pins for them.
- `deliver_file` exists only when `onFileDelivered` is wired; `createEngineSession` grants it by
  default (`capabilities.deliverFiles: false` withholds it). Delivered files are downloadable
  only while the session lives — in-memory VFS; durability is the persistence tier.

- **`sandboxedProviderProfile()` adds no mechanism — the empty arrays are the whole thing.**
  `capabilities: []` and `mcpServers: []` already mean what they mean and `createToolContext`
  already withholds a tool whose backend the host did not inject; the helper only makes the three
  fields one call, the failure mode otherwise being a profile that *looks* sandboxed and still
  grants `deliver_file` because nobody wrote the empty array. A session under it can run untrusted
  JS in the WASM guest under the interpreter's own timeout/memory limits and read+write the
  session's in-memory VFS (a map, not a filesystem); it cannot touch a host path, spawn a process,
  reach the network (`web_fetch`/`download`/`web_search` are all capabilities and none is granted),
  deliver a file, or use MCP. Two things it does not do, because they are not a profile's to
  decide: it authorizes nobody (that is `scope` + `authorizeSession`), and it does not make the
  model's *input* trustworthy — a sandbox bounds what a tool can reach, not what a prompt can talk
  the model into asking for.

## Session scope (embedded deployments)

- **Scope is not `meta`.** `meta` is free-form, client-settable and echoed; an enforcement rule
  whose input the caller supplies is not an enforcement rule. `scope` is validated at the door,
  merged with the principal's (a scoped caller may add narrower tags, never contradict its own —
  403), and written by no route afterwards. `UpdateSessionRequest` must stay scope-free.
- **A runner that forgets to echo `config.scope` is invisible to every check and therefore
  visible to everyone.** That is why `buildRunner` — the one chokepoint for create, dormant
  rebuild and parked rebuild — asserts the runner's `info().scope` equals the config's, and why
  the server re-stamps the scope onto whatever the host's `buildRunnerConfig` hook returned. Same
  posture as the profile's `CLAUDE_CONFIG_DIR` pin winning over the hook.
- **The WS attach checks scope before `parking.ensureLive`.** Waking rebuilds the runner and
  reconnects its MCP servers; doing that for a caller about to get a 404 spends the session's
  resources on someone with no claim to it. Checked again after the wake, because that socket can
  drive the session.
- **The default rule's asymmetry is intended**: a session may carry keys the principal says
  nothing about, but a session missing a key the principal pins is not that caller's. A session
  with *no* scope is invisible to a scoped principal — the right fail direction, so sessions
  predating the feature never leak into an end user's list. And `scope: {}` on a principal pins
  nothing, so it is unrestricted like an absent one; never read `{}` as "sees nothing".
- **Scope is on the wire, and that is a decision.** `SessionInfo.scope` is what makes the parked
  and dormant records carry it for free (both embed `info`), what lets `parking.listInfo()` be
  filtered without a sidecar map, and what lets a notification observer route per user. The cost
  is that any principal the policy admits sees the tags — so an embedder should use opaque ids as
  values, not names it would not show that audience.
- **Jobs are the queue's copy of the same tags** (`JobInfo.scope`, stamped at `submit`). Without
  them the queue is a side door into an unscoped session. Once a run has started the live
  session's info is the subject; before and after, `canSeeJob` hands the predicate a **stub**
  built from the job (id, scope, profile, cwd). It used to fall back to the default rule there,
  which was wrong in the dangerous direction: a policy *narrower* than tag-match (tags plus a
  role, say) would have had queued jobs listed and cancelable by a peer it rejects. Wherever the
  predicate exists it is the only rule.
- **Declaring `authorizeSession` withdraws the unscoped-means-operator default.** The
  operator-only surfaces key on `isOperator`, which is `scope === undefined && no policy` — so a
  host that writes a policy over its *own* principal shape and never sets `scope` would otherwise
  read as "everyone is the operator" and serve `/fs/*` and the queue firehose to end users. With
  a policy declared, operator principals must say so: `operator: true` (and `operator: false`
  forces the other way). Also: a scoped principal can still read `GET /profiles`, which is gated
  by `allowedProfiles`, a *separate* opt-in — set it. The per-profile **config snapshot** is
  withheld from a non-operator, since a profile you may run is not a directory you may inventory.
- **A policy that throws has not said yes.** `canSee` catches and returns false rather than 500ing
  the route: one surprising row must not turn a hundred-row list into a page-wide error.
- **The queue firehose has no per-socket filter.** `/queue/ws` fans every job's events — prompts,
  progress previews, result text — to every socket, so a scoped principal is refused it outright
  rather than handed other scopes' runs. Same for `/queue`, `/sdk-sessions` (the operator's
  on-disk engine store) and `/fs/*`.
- **An idle provider session still does not survive a gateway restart.** Dormancy needs
  `capabilities.resume`, which provider sets `false`, and `park()` refuses unless the loop is
  resting on deferred calls. So for an embedded deployment on k8s, conversation lifetime is pod
  lifetime unless the embedder rebuilds the thread itself. Park-at-rest for the provider engine
  is the fix and is not built.

## Parking & bridged execution

- **`AiSdkRunner.clearContext()` refuses while tool calls are outstanding, and waiting is not the
  fix.** A parked call's result is owed by a client that may answer in two days, and the messages
  it would be spliced into are exactly what a clear drops. The clear rides the turn chain like
  everything else that touches `#messages`, so one typed mid-turn queues behind that turn rather
  than racing it — but a *parked* turn has no end to queue behind. `interrupt()` is the way out: it
  fails the parked calls and finishes the turn, after which the clear runs.

- **A `RunnerSnapshot` must round-trip `JSON.stringify` unchanged, `state` included.** The engine's
  continuation state is typed `unknown` and opaque to the host precisely so `packages/server` never
  resolves a model SDK — which also means nothing type-checks what is inside it. A `Date`, a `Map`
  or a typed array in there rehydrates as something else, and the bundled in-memory store is the
  one store that hides it: the bug appears only under a durable `SessionStore`, on a restart, as a
  session that comes back subtly wrong rather than failing.

- **`parking.touch()` writes *both* record kinds, and dropping either half is the same bug one
  engine over.** A session has exactly one of a dormant record and a live one, and the PATCH route
  has no business knowing which — so `touch()` calls `#rememberDormant` *and* `#persistLive`, each
  of which no-ops for the engine it does not apply to (no `resume` capability; no `snapshot()`).
  With only the dormant half, a renamed **provider** session under `persistLive` lists correctly
  right up to the restart and then comes back under its old title — exactly the bug the dormant
  half was added for.

- **Two ways a session outlives its runner, and they are not interchangeable.** Parking preserves
  *mid-task* state, which means a `RunnerSnapshot` — and `Runner.park()` is optional on the
  interface for a reason: `AiSdkRunner` is the only implementation, because the claude and codex
  engines run behind a binary that owns its own process state. Those two get **dormancy** instead:
  a `DormantSessionRecord` with no transcript in it at all, just the id, the `sdkSessionId`, and
  the config — rehydration is an ordinary create with `resume` set, and the transcript comes back
  from the *engine's* store as `replay: true` events. Do not try to unify them, and do not read
  "park everything on SIGTERM" as a plan: for the two engines anyone actually runs, `park()`
  returns nothing. Four rules keep the shared machinery honest:
  - **Records are written continuously, never on shutdown.** A shutdown hook is exactly what a
    `kill -9`, an OOM, or a pulled cable do not run. `system_init` is the earliest a resume is
    even possible (before the engine names its session there is nothing to come back to), and
    every non-park status change refreshes it.
  - **`listInfo` skips a record whose id the registry holds.** A live session has a dormant
    record — that is the point — so without the filter the merged `GET /sessions` shows every
    running session twice.
  - **The `session_closed` discard is skipped while the manager is `#closed`.** `registry.remove`
    (a DELETE) and `registry.closeAll` (a shutdown) both close runners with reason `'server'`, so
    the *only* thing separating "this session is over" from "this process is over" is that
    `parking.close()` runs first. Drop that guard and a graceful restart forgets precisely the
    sessions it was preserving — which is how this was found.
  - **Waking one re-runs `buildRunnerConfig`.** `env` is on `EPHEMERAL_CONFIG_KEYS` and never
    reaches disk, so a claude profile's `CLAUDE_CONFIG_DIR` pin must be re-derived from the
    profile rather than read back. Handing the stored config to the engine as-is would strand a
    rehydrated session on the wrong credential store.
  - A park's record is *consumed* on wake; a dormant one — **and a live one** — is refreshed in
    place, because the session will need it again the next time the process dies. Getting that
    wrong for a live record is the sharpest bug in this area: consuming it opens a window from the
    attach to the next turn in which the session exists nowhere durable, so a user who opens a
    session, reads it and types nothing loses it to a redeploy, with no error and no trace.
- **The provider engine's restart story is `snapshot()`, not dormancy, and it is off by default.**
  Dormancy remembers an *engine* session id to resume from; a provider session has no engine store
  behind it, so its record carries the state itself. `Runner.snapshot()` is `park()`'s value
  without `park()`'s teardown — same builder, different gate: it refuses a turn in flight and
  pending *in-process* executions (whose results die with the process), and allows the idle case
  `park()` exists to refuse. `parking.persistLive` writes it through on `turn_result`,
  `model_changed` and `permission_mode_changed`; the record is `kind: 'live'`, rebuilt lazily on
  first attach like a dormant one. Two things it is easy to get wrong:
  - **The write must not be synchronous in the event listener.** `turn_result` is emitted from
    *inside* the turn, before the `finally` that clears the abort controller — so a `snapshot()`
    called straight from the listener sees a turn in flight and refuses, every time, silently.
    `#queue`'s microtask hop is what puts it after. A refactor that "simplifies" the hop away
    produces a write-through that never writes and nothing that says so.
  - **The persisted log drops stream deltas** (`snapshotRetains` in protocol). Safe because a
    delta is superseded by the `assistant_message` that flushes it — including on the error path,
    where an interrupted turn flushes its partial buffers before the failed `turn_result` — and
    because `transcriptActivity(stream_delta)` is 0, so the `activityCount` a restore recomputes
    from the log is bit-identical and no client's unread cursor moves. A *cap* on the log would
    have broken exactly that. The rule is **provider-only**: a Claude log's thinking blocks arrive
    empty and are backfilled from the delta stream, so the same rule there would silently erase
    every thought.
- **A restored session must not schedule a turn.** `AiSdkRunner.start()`'s restore branch
  deliberately schedules nothing. An *interrupted* turn leaves the message history ending on the
  user (the catch path flushes a partial `assistant_message` for the transcript but never pushes
  the model's response messages), so `#runTurn`'s "already answered" guard would pass and the
  woken session would re-run the very turn the user killed — unprompted, on first attach, burning
  tokens. It was unreachable while `park()` was the only source of snapshots (it required pending
  deferred calls); `snapshot()` makes it reachable. `park-restore.test.ts` pins it.
  - **The wake must clear `prompt`, and carry the title as it does.** `prompt` is the session's
    *opening* prompt, it persists in the record, and `SessionRunner.start()`/`CodexRunner` send it
    unconditionally — so a session created with one used to re-run it as a fresh turn on top of the
    thread the resume had just replayed. The provider engine has always guarded its own rehydration
    (`if (this.#config.restore)` in `AiSdkRunner.start`); claude and codex rehydrate by `resume`,
    which unlike `restore` is a **public request field** — `createSession({ resume, prompt })`
    legitimately means "continue this thread, and here is the next thing". So the suppression lives
    at the wake site in `rebuild:`, never in a runner. Dropping it alone is a *different* bug:
    `sessionTitle()` derives from `prompt` when `meta.title` is unset, so the wake also freezes
    `record.info.title` into `meta` or the session comes back nameless.
  - **A rename must re-save the record, and the record must carry the runner's live `meta`.**
    `setTitle()` writes the *runner's* `#config`, which `SessionParkManager.#configs` never sees,
    and the wake rebuilds from `record.config` while discarding `record.info` — so a rename used to
    survive the listing and die on the wake. `#rememberDormant` persists `{ ...config, meta:
    info.meta }`, and `PATCH /sessions/:id` calls `parking.touch()` because a rename emits no event
    and nothing else would trigger a save. A **parked** session 409s the PATCH instead: it has no
    runner to carry the change, and its snapshot is the host's to rewrite, not this route's.
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
- **The dormant write is asynchronous, and the two engines do not get one at the same moment.**
  `#rememberDormant` runs on `system_init` *and* every non-park `status_changed`, so a claude
  session has a record from its first moments. **Codex emits no `system_init` at all**, so its
  first record rides the post-turn `status_changed`. Kill the gateway inside that window and the
  row is not un-resumable — it is **gone**. Verified with `pnpm smoke:restart codex`, which is why
  that smoke waits for the record on disk rather than racing it.
- **A swept engine store fails quietly, and more quietly than intended.** Delete the CLI's own
  transcript behind a dormant record and the attach **succeeds**: the row lists, the socket opens,
  the transcript comes back **empty** (a dormant record holds no transcript — it backfills from
  the engine), and the next turn is simply never answered. The record staying is deliberate (the
  failure may be transient), but nothing anywhere says "this session's engine state is gone", so
  it reads as a hang. Reproduce with `pnpm smoke:restart claude swept`.
- **Never put `ANTHROPIC_API_KEY` in a gateway's environment when the profile is meant to run on a
  subscription.** The CLI takes the key, `plan_info` and `rate_limit` stop arriving, and turns
  silently never complete — indistinguishable from a hang. This bit `smoke/restart.ts`, which
  deliberately does *not* pass `--env-file-if-exists=.env` even though its neighbours all do.
- Bridged tool calls: the server asks the **first attached** client and fails dispatch fast when
  none is attached (which is why autonomous jobs simply never bridge). Results are idempotent by
  `executionId` — a late answer racing a timeout is expected and must not error the client or
  re-open a settled call. The server feeds every bridged result into the session runner's
  optional `settleExecution` before the host's `bridge.onResult` observer — operators don't wire
  that loop themselves. A runner whose id isn't known yet at assembly time reaches its bridge
  executor via a dispatch-time delegate on `call.sessionId` (see `smoke/sdk-client.ts`). The
  browser guest engine is loaded on first bridged call, never at import; keep it that way (it is
  ~2 MB) and keep the variant an optional peer dep.

- **A `conversation_reset` must re-write the record, and nothing else will.** No `status_changed`
  follows a clear, and `#persistLive` is otherwise driven by `turn_result` — so the reset arm calls
  both `#rememberDormant` and `#persistLive`. The dormant record names the conversation that was
  just cleared (re-saved under a freshly adopted engine session id, or deleted if the engine has
  none yet); the live record *carries* the transcript, so without the second call the on-disk
  snapshot keeps the pre-clear messages until the next turn ends. Either omission means a restart
  in that window wakes the session straight back into the transcript the user threw away.

## Server, profiles & auth

- **`writeFile`'s `mode` option applies only when the file is *created***, so a 0600 write over an
  existing file silently keeps whatever bits that file already had. Every secret-adjacent write in
  `packages/cli` therefore follows `writeFile` with an explicit `chmod`: `auth-key.ts` (which
  regenerates over a file it has just judged corrupt — precisely the case where the old mode is not
  ours), `auth-sessions.ts` (whose temp path is `${path}.${pid}.tmp` and can be reused by a later
  run of the same pid), and `apns/devices.ts` (rewritten on every device registration). The `chmod`
  reads as redundant beside the `mode` argument and is not.

- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- **A browser cannot authenticate a WebSocket attach with a header** — the `WebSocket` constructor
  takes `(url, subprotocols)` and nothing else, and the one `authenticate` hook guards REST *and*
  the upgrade. So a dashboard has exactly three options: a cookie (sent automatically on a
  same-origin upgrade), a query-string credential (`ClientOptions.buildWsUrl` exists for this),
  or a server-side proxy that stamps the credential on the tab's behalf. Baking a key into the
  *served JS* is not one of them. `packages/cli` takes the cookie route for the dashboard it
  serves itself, which is the entire reason it serves the app and `/v1` from one origin via the
  `fallback` option. Anything reached through `fallback` is outside `basePath` and gets no
  `authenticate` call — that namespace is the host's to guard.
- **Two deployment shapes, two auth models. Do not mix them up.**
  - **Tenant infra** — the operator's own clients (iOS, the VS Code extension, a dashboard on
    another machine) talking to the operator's own gateway. These reuse the **one global gateway
    key**. Node clients send it as a header on both transports. A *browser* client cannot, so
    `createCliAuth` also accepts it as `?key=` **on WebSocket upgrades only** (`querySecret`),
    and `hostAuth()` in `packages/client` is the one place that builds those URLs. Confined to
    upgrades on purpose: a key in a query string is a permanent, replayable credential that
    lands in reverse-proxy access logs, so what a leaked URL buys is a single attach and never a
    REST call — `?key=` on REST is *not* authenticated and must stay that way.
  - **Embedded infra** — WorkerDeck inside a host product, serving that product's end users. The
    global key is exactly wrong here (every user would hold the operator's secret), so these
    supply their **own** `authenticate`. That seam already exists and is total: a config file
    with `authenticate` sets `hostAuthenticates`, `createCliAuth` is then built with
    `secret: undefined`, and `instance.ts` routes the server's hook to the host's function — so
    the built-in scheme, **cookie and `?key=` alike**, is not consulted at all. `packages/server`
    itself never reads `?key=`; grep it before believing otherwise.
- Cookie auth means ambient authority, so CSRF is live: WebSocket upgrades are **exempt from
  CORS**, which makes an explicit `Origin` check — not `SameSite` alone — the actual defense on an
  attach.
- **The login-session table is keyed by `HMAC-SHA256(secret, token)`, and that keying is doing
  three jobs at once** — do not "simplify" it back to a plain digest of the token. The table is
  mirrored to `<stateDir>/auth-sessions.json` (`createAuthSessionStore`) so a restart does not
  sign every browser out while the browser still holds a cookie the 7-day ttl says is good; but
  what goes on disk must then be worth nothing to whoever reads it, and rotating `--auth-key`
  must still invalidate every outstanding cookie. Keying by the secret gives all of it: the file
  holds neither the cookie value nor the secret (inverting either needs a preimage of a
  256-bit-entropy input), and rows written under an old secret simply stop matching any lookup
  and age out on their own expiry — no revocation list, no fingerprint field. Logout still
  deletes a row, which is why this stayed a server-side table rather than becoming a stateless
  signed token. The store is fire-and-forget by contract: the auth paths are synchronous, so a
  store that cannot write must degrade to "logins do not survive a restart", never refuse a
  login.
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
  both ways, so it can't discriminate). `claudeSessionEnv` (`server/src/lib/profile-env.ts`) therefore *skips* the pin
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
  400s a widening request rather than silently downgrading it. The enforcement is the gateway's
  alone: `createEngineSession` takes `config.capabilities ?? profile.session.capabilities` and lets
  the request value win outright, because by then the widening check has already run. A host that
  calls `createEngineSession` directly — it is public API — with capabilities it took from a client
  owes that check itself. MCP is **named, never configured**
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
  come from the event, so identity and ordering are untouched. Two more rules on that snapshot:
  `runner.info()` is read at **send** time, not delivery time — the payload must describe the
  **Session webhooks are server-wide, not per session** — the whole point is to hear about
  sessions you did not create and are not attached to, which a per-session subscription could not
  give you.
  Read at **send** time, not delivery time: the payload must describe the
  session as the event left it, not as it is after three webhook retries — and the notifier's
  webhook delivery is a deliberate near-copy of the queue's job-webhook delivery rather than a
  shared helper, because coupling them would let a change to job deliveries silently change
  session ones.
- **Two CSRF details in `createCliAuth` sit beside the `Origin` rule above.** (a) The origin
  verdict is **tri-state** — `absent` / `ok` / `foreign` — because absence means different things
  per call site: every current browser sends `Origin` on cross-site POSTs and on every WS
  handshake, so absent means a non-browser client, which carries no ambient cookie. Login and
  logout therefore allow absent-Origin (curl-style provisioning) while unsafe methods and upgrades
  on a *cookie*-authenticated request require it present. (b) The cookie is `SameSite=Lax`, not
  Strict, on purpose: Strict drops the cookie on a top-level navigation from an external link,
  landing a logged-in operator on the login page, and buys nothing the explicit Origin check does
  not already cover — the real surfaces are same-site-different-port and the WS handshake, both of
  which need that check whatever `SameSite` says.

- **`cors: { origins }` is sharing policy, not a credential.** Preflights are answered *before*
  `authenticate` (browsers strip credentials from them, so they would otherwise 401), but every
  real request still goes through the hook — an allowlisted page that does not hold the key gets
  nothing. Two implementation rules: **exact origins only**, no wildcards or suffix matching, and
  `Access-Control-Allow-Credentials` is **never** sent, which is what keeps an ambient cookie from
  becoming cross-origin authority. WebSocket upgrades are exempt from CORS entirely and are
  unaffected — their credential is whatever `authenticate` accepts on the handshake.
- **A `ProfileStore` holds NO credentials, by construction.** `ProviderConfig.apiKeyEnv` is a
  variable *name* and a Claude profile's `configDir` is a *path*; both are resolved against the
  server's own environment at session time. That is exactly what makes a stored profile safe to
  write to disk and safe to serve from `GET /profiles` — the same rule `toDurableRecord` follows
  when it drops `env` from a persisted session config.

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
- **`/fs/find`'s ranking is part of its contract**, because it is what an `@file` picker is
  built on: subsequence matching (`seslist` finds `SessionListView.swift`), filename hits above
  path hits, shallow above deep, and an empty `q` returns the shallowest files rather than
  nothing. Build directories are skipped.
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
- **The attachment store is in-memory, so a restart outlives it.** The `MessageAttachment`
  reference in the transcript survives (it is in the log), but
  `GET {basePath}/sessions/:id/attachments/:attachmentId` 404s afterwards — a message can outlive
  the bytes it names, and a client rendering one has to tolerate that.
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
  downscales to 1568px, which is roughly what a vision model resizes to anyway. The **browser**
  composer downscales too, to the same longest edge (`useAttachments`' `prepare`), re-encoding as
  JPEG at 0.85 — a phone photo is several times that in each direction and costs tokens for detail
  no model reads. The constant is spelled once per client with nothing shared between them
  (`MAX_IMAGE_EDGE`, `ComposerAttachments.maxImageEdge`), so tune one and you have broken a pair.
  GIFs are exempt, because a redraw keeps one frame of an animation, and anything the browser
  cannot decode (HEIC on most desktops) is uploaded as-is so the gateway answers with its own 415
  rather than the client inventing one.
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
- **Clients gate the skills affordance on the `skills` event having arrived** (`state.skills`
  defined), never on `capabilities.skillsList` alone: the flag says the engine *can* answer, the
  list says it *has*. The list is always asynchronous to the capability.
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
- **Codex answers MCP status before the session has connected, over a throwaway child** — same
  device as the skill list, and for the same reason: the session spawns nothing until it has work,
  and a panel reading "No MCP servers configured" until the first turn states something false
  about the operator's config. `mcpServerStatus/list` blocks until the servers are enumerated
  (measured: complete on the very first call, ~2s from spawn), so there is no half-populated
  answer to race. The dialog also stops falling through to its empty state when the request
  *failed*: a 501 gives no standing to claim nothing is configured.
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

## Attach replay (the hold, the cache, the five filters)

- **Only a fresh attach (`replayingFrom === 0`) yields a hold target, and the reconnect's
  `undefined` is load-bearing.** A reconnect replays into a transcript the reader is already
  looking at, and blanking it mid-turn would be a worse bug than the flicker the hold fixes.
  Because `useClaudeSession` sets the target unconditionally on every `attached` frame, a
  reconnect's `undefined` also *releases* a hold whose replay a socket drop cut short — the
  re-attach streams the remainder visibly instead of sitting blank until the backstop fires.
  Guarding that set with "only when defined" silently re-creates exactly that blank window.

- **Image refs are the fifth filter, and the only one that also applies to the LIVE path.** With
  `imageRefs`, a `tool_result`'s base64 `image` parts are delivered as `image_ref` addresses
  (`media_type`, decoded `bytes`, `part_index`) and the bytes come back from the *same* route the
  fourth filter built, with `?part=N`. Measured, this is the one that was actually worth doing:
  **91% of all tool-result payload across 214 local sessions is base64 no client rendered**, and a
  real attach falls 4,548 KB → 1,275 KB while a session with no pictures is byte-identical. Four
  things not to re-derive. It is a **new part type, never a hollowed-out `image`** — a head is a
  valid shorter text, an image with no bytes is not a smaller image, and an unfamiliar type falls
  through every existing fold exactly as the CLI's own `tool_reference` does. It targets **`image`
  with a base64 source, never "non-text"**: the only other non-text part in the corpus is
  `tool_reference`, and every instance of it totals 122 KB. `part_index` is **stamped from the
  stored array, not the delivered position** — `headOf` drops non-text parts while building a head,
  so the two filters composed renumber a block; that is also why refs are applied *before*
  truncation and why `headOf` now keeps an `image_ref`. And it is its **own flag**, because this
  family's additive-at-protocol-7 argument rests on "a client that never asked cannot receive one"
  holding by construction, which a flag whose meaning grew after shipping would destroy. The live
  half is `SubscriberSet` (`core/src/lib/subscribers.ts`), which is also where the answer to "which
  filters reach live events" is now written down once instead of three times.
  **Why the live path too, and not just replay**: bytes on a live event have only two fates on the
  client, and both are worse than an address. Discarded, they were 335 KB (median) delivered once
  per attached watcher for nothing; kept, they need a second decode-from-event render path, which
  pins megabytes of base64 inside `TranscriptState` — and the transcript LRU then retains that
  across session switches. That is the disease relocated, not cured.

- **A truncating replay is the fourth filter, and the only one that changes an event's
  *content*.** With `truncateResults`, a `tool_result` block over
  `TOOL_RESULT_HEAD_CHARS` (8,000) is delivered as its head with `truncated`/`total_chars` set,
  and the rest is one `GET /sessions/:id/events/:seq/result?toolUseId=` away. Three rules hold it
  up. It is **replay-path only** — `replaySlice` copies, the stored log is never mutated, because
  the live path, the parking snapshot and the fetch route all need the whole thing. It is
  **opt-in from the unit that renders**, which is stricter than `coalesceReplay`'s opt-in and for
  a sharper reason: `client` and `react` are separate packages an embedder can skew, so a caller
  that asked for heads without knowing how to fetch them back would show one as if it were the
  whole result — the silent lie this family exists to prevent. `useClaudeSession` sets it, and so
  does the iOS app's own attach (`TranscriptViewModel.run`) — one per *renderer*, never anywhere
  else. And the head is **chosen against the clients' own budgets** (~400 collapsed,
  2,000 open), so both un-pressed states are byte-identical to an untruncated attach and only the
  uncapped "show everything" press ever fetches; `packages/ui/test/result-budget.test.ts` asserts
  that relationship, because a head lowered under the open budget would clip it with no marker.
  Two consequences worth knowing before touching it: the **highest-seq event is exempt from
  dropping but not from truncation** (a session ending on a `find /` puts its 641 KB frame exactly
  there), and the marker outlives the clip — a head short enough to fit the open budget is still
  not the result, so the affordance is `clipped || truncated`, never `hidden > 0`.
- **It cuts text, and text is not where the bytes are — measured.** Re-run against the session the
  feature was designed on, a truncating attach came out at 3,092 KB against 3,101 KB: **0.3%**. Of
  176 `tool_result` blocks, four held more than 8,000 characters of text (8 KB between them) and
  the giant frames were base64 **image parts**, which `truncateResultBlocks` deliberately does not
  touch — slicing one corrupts it. Across every local session log the ratio holds: 44 MB of
  tool-result text against 458 MB of base64, in 189 of 215 sessions, two thirds of it produced by
  **`Read`** (an agent looking at a PNG) rather than by a browser tool. Those parts are dropped by
  `blockText`/`joinedText` on arrival and rendered by nobody, so they are a candidate for a
  *drop* rule of this same family — not for this one. Keep the two apart, and do not restate the
  old "68% of an attach" projection: it measured `JSON.stringify(content).length`, which counts
  base64 as text.
- **A stale `sourceSeq` must be refused, not guessed.** The fetch route requires `toolUseId` and
  verifies it against the block it found. A woken dormant session has a fresh log with fresh seqs,
  so a seq cached across a rebuild can name a different event entirely, and handing the reader
  another tool's output under the row they pressed is the exact bug class the feature exists to
  remove. 404 there means "re-attach", and `loadFullResult` answers `false` rather than throwing:
  the caller is a press on a row, and an exception there has nowhere to go.
- **Three independent filters sit on the *dropping* side of a replay, and they compose.** `subscribe()` skips
  transcript *content* strictly below the latest `conversation_reset`; it skips events at or
  below `afterSeq`; and, **only when the caller opts in**, it skips state readings superseded
  later in the same replay (`coalesceReplay` → `replayCoalesceKey` → `staleReplaySeqs`).
  The opt-in is the load-bearing part: coalescing is sound only for a consumer whose handling of
  those events is last-write-wins, and `parking.ts` subscribes from seq 0 and *branches* on
  `status_changed` — a `parked` status triggers a park. Turning it on globally would silently
  skip that side effect. The WS attach in `server.ts` is the one caller, because a *client's*
  reducer really is last-write-wins there.
- **Coalescing must never drop the highest-seq event**, and it cannot by construction — the
  globally-last event is by definition the last of its own key. This is not trivia:
  `useClaudeSession`'s replay hold waits for `state.lastSeq` to reach the attach frame's
  `session.lastSeq`, so a coalescer that swallowed the final event would hang the panel blank
  forever. Tested on both sides. If you extend `replayCoalesceKey`, the property to keep is that
  folding the full log and the coalesced log through `applyEvent` yields identical state —
  `packages/react/test/replay-coalesce.test.ts` asserts exactly that. Three kinds look eligible
  and are not: `capabilities` (`defaultModel ?? base.defaultModel` is a fallback *merge*),
  `model_changed` (`undefined` means "keep the last known model"), and `system_init` (the
  server's `watchAuthSource` reads the **first** one).
- **A cached `afterSeq` against a rebuilt log fails silently, and that is the worst failure in
  this area.** Attaching at `afterSeq: 500` against a runner whose log holds 12 events delivers
  *nothing* — every seq is below the mark — so the client sits on a stale transcript with no
  error, no spinner and no reconnect. The log resets routinely: a dormant session is rebuilt with
  a brand-new runner starting at seq 0. `staleAttach` in `use-session.ts` is the guard, on two
  signals — `frame.session.lastSeq < held.lastSeq`, and a `createdAt` mismatch (all three runners
  stamp `createdAt` at construction, and `AiSdkRunner` restores it *exactly when* it restores the
  event array, so equality really does mean "same log" and a parked wake keeps its cache). Note
  this was reachable **before** any cache existed: a `SessionHandle` reconnect after a gateway
  restart re-attaches with its own advanced `#lastSeq` and freezes the same way.
- **Recovering from a stale attach has three traps**, each of which is a bug if skipped: unhook
  the event listener *before* resyncing (a rebuilt log that has advanced past the held seq
  replays new-log events in the same tick as the frame, and they must not compose into old-log
  state); seed the reducer back to `initialTranscriptState` (`applyEvent`'s `seq <= lastSeq`
  dedupe would otherwise silently swallow the whole fresh replay); and do **not** let the effect
  cleanup write the condemned state back to the cache, or the retry re-poisons what it just
  discarded. The retry attaches with `afterSeq` 0, for which `staleAttach` is false by
  definition, so it cannot loop.
- **The hold's placeholder must not become the next flicker.** The hold hides the transcript by
  `visibility` (never by unmounting — the rows must lay out so the virtualizer measures and the
  reveal is one paint of a settled list), and it draws a `Loading…` line. Unconditionally, that
  line appears and vanishes inside ~0.5s, which is the flicker the hold exists to remove, moved
  to the top of the panel. `wd-hold-appear` holds it at `opacity: 0` and fades it in only after
  600ms, so a healthy attach never paints it. The general rule: do not announce a wait too short
  to notice. (`visibility` is also the one hiding property a descendant can turn back **on**,
  which is how that line stays visible inside a hidden root.)
- **The reveal must paint already at the bottom, and the follow spring cannot do it.** Even
  `scrollToBottom('instant')` defers behind a `requestAnimationFrame` — one frame after the
  reveal's paint, measured as a revealTop of 33,037 against a final 34,459 on the 600-row fixture,
  i.e. a visible jump. What lands in the same frame is a layout effect on the hold's falling edge
  pressing `use-stick-to-bottom`'s own `state.scrollTop` setter (recorded in `ignoreScrollToTop`
  so the write is not read back as user intent).

- **`truncateResults` is replay-only, and the two "+N chars" markers are indistinguishable on
  screen.** A result that arrives while you watch is never truncated (`packages/core/src/lib/
  subscribers.ts` states the rule: the head budget sits above both clients' display budgets, so
  cutting a result already on screen buys a fetch for nothing). So a live row's marker is the
  renderer's *display clip* — pressing it lifts the clip locally and touches no network — while a
  reloaded row's marker is the wire truncation, and only that one fetches. They look the same, and
  only the wire one's terminal label carries the `— fetch the rest` suffix. **When verifying this
  feature, attach cold and watch the network panel; reading the transcript proves nothing.** An
  earlier verification pass concluded the feature was broken on the provider engine on exactly this
  mistake.
## Terminal theme (`transcriptVariant: 'terminal'`)

- **The gutter markers are the CLI's, and they are the whole of a row's identity.** `❯` is what
  you typed, `●` what the model said or a tool it called, `⎿` that tool's output one level in,
  `✻` thinking, `!` a notice from the runner rather than the model. Every renderer in
  `terminal/items.tsx` answers exactly two questions — which marker goes in the gutter, and what
  the body says — never a spacing, a radius or a border; those belong to `Row`/`Blank`/`Band`.
  `❯` is also `PROMPT_GLYPH`, shared with the composer's gutter, because two spellings would put
  the caret a glyph off the column.
- **`--term-font-size` and `--term-line` must be whole pixels.** They are the character cell, and a
  line height of `1.5 × 13px` is 19.5px: every second row of a long transcript then lands on a
  half-pixel, the text visibly softens, and the diff bands show a seam along their edge. This is
  the reason `TerminalSurface` rounds what it is handed rather than passing it through.
- **`--term-bleed` is a contract between the scroller and every band.** A full-bleed run of rows (a
  diff hunk, the user's prompt band, a hover fill) cancels it with matched negative margin *and*
  padding, so its value must equal the scroller's own horizontal padding. `TerminalSurface` sets
  both together for exactly this reason; a host that pads the scrolling element itself will see
  every band stop short of the edge with no error anywhere.
- **A diff's line numbers come from the wire, never from the client.** They are protocol's
  `FilePatch` hunks, which the *engine* produced — this code has never read the file, so anything
  it computed would look authoritative and point at the wrong line. A patch whose hunks all start
  at `0` is the approval case (the edit has not happened yet); `TerminalDiff` reads that back and
  renders **without** a number column rather than printing a column of zeroes.
- **The card components have no terminal branch at all.** The terminal theme is a separate
  renderer that the shell mounts *instead* of them, so nothing under `components/agent/` asks
  which variant it is in — if it is drawing, it is drawing cards. The one exception is the
  composer, which is not a transcript row: it lives outside the scroller, so it reads the variant
  from the panel-wide context and draws its own terminal form (`>` in the gutter, glyph actions,
  one rule along the top).
- **The blank line between blocks is a row, not a margin — except inside the virtualizer.** The
  virtualizer measures one element per item, so space between two items has to be *part of* one of
  them or it goes unmeasured and the scrollbar drifts. Hence `term-row-gap` as padding on the
  measured wrapper, applied conditionally via `needsBlank` so a tool call and its output stay
  flush the way the CLI leaves them.
- **Affordances must cost no layout.** The hover fill is a background and the copy actions are
  absolutely positioned overlays one line tall, so `affordances={false}` changes no glyph's
  position. That is what makes "off" the pure article rather than a degraded mode — and the reason
  a new affordance may not be added as anything that occupies space.
- **`ch` is measured off the live surface, never derived from the font size.** `CellMetrics.ch` is
  the advance of `0` in px — **7.83px at 13px JetBrains Mono, not 13 × 0.6** — read by `measureCh`
  from an absolutely positioned probe (absolute so it adds no layout and cannot re-trigger the
  `ResizeObserver` that called it). Every wrap column count in `height.ts` divides by it, so a
  derived value is wrong by a fraction of a cell on every row, and the error shows only in a
  browser.
- **A tool result's image is a fixed box of whole lines, reserved before the bytes arrive.**
  `IMAGE_BOX_LINES` (12, ≈240px at an 18px line) is the box in **all three states** — pending wash,
  loaded (letterboxed), failed — because an image's intrinsic size is unknowable until it is
  fetched, and a mount-corrected row brings back the growing scrollbar the height calculator exists
  to kill. Letterboxing is the accepted cost and nothing here may collapse to nothing. `image-box.ts`
  is its own module so `items.tsx` (which draws the box) and `height.ts` (which predicts it with no
  DOM) cannot spell it twice; `test/image-box.test.ts` pins the single spelling and
  `dev/height-audit.ts` owns the geometry.
- **Verify against the real renderer, not the model.** The playground (`cd packages/ui && pnpm
  dev`, port 5193) is the terminal theme's regression surface — jsdom has no text layout, so
  only a browser can check the geometry. Console hooks: `__wdAudit` (height audit, mounted rows
  only — scroll and merge), `__wdCheckMapping` (item→row mapping), `__wdPerf` (frame-time sweep),
  `__wdJumpRecap`, `__wdRepin`, `__wdSetFixture`, `__wdSetWidth`, `__wdSetMetrics`, `__wdMd`,
  `__wdLines`, `__wdAttach` (stage N fake attachments), `__wdScrollUp` (escape the bottom lock —
  the precondition for the two below), `__wdStream` (a row that **grows**, the only thing that
  fires the virtualizer's size-change correction), `__wdPinTrace` (per-frame gap to the bottom;
  `final: 0` is pinned) and `__wdReplay` (bursts under the replay hold; a pinned transcript shows
  one `scrollTop` per burst and never an intermediate value), plus the "audit grid" button. Re-run the audits after any change to row structure — both instrument bugs found
  building the scrubber inflated *coverage* rather than accuracy and would have read as
  calculator bugs.

- **The scrubber's right lane anchors on the answer, not the turn end.** Building marks from
  `turn_result` items alone is silently history-blind: `#backfillHistory` maps only `user` and
  `assistant` entries, so a resumed session — or any session replayed after a gateway restart —
  carries no turn rows at all and the whole right lane comes back empty while the blue lane
  survives, which reads as a rendering bug rather than a missing input. The rule: emit the turn
  mark for the last top-level assistant message of each segment and let a `turn_result`, where it
  exists, *decorate* it (failed colour, peek done-line). Both this and the unmarked-live-answer
  bug were pure logic, and the scrubber unit tests now pin them.

- **What pins the sticky prompt is a one-line `overflow: hidden` head, and the browser does the
  pinning.** The head re-renders the same row laid exactly over the real row's first line,
  `aria-hidden` with no pointer events (the real row keeps interaction and the a11y tree). Each
  prompt row renders inside a **lane** — an absolutely positioned strip spanning its turn — with
  the head `position: sticky` inside it: `sticky` is inert *on* an absolutely positioned element
  but works unchanged on a child *of* one, confined to the lane's box. An earlier version clamped
  the row's transform from render and paid for it every frame; any JS-written pin runs behind the
  compositor, so the row wobbled under momentum scroll. Three edges: the head must ride in its
  **own absolutely positioned sub-lane**, never in flow with its footprint cancelled by a negative
  bottom margin (sticky confinement clamps the *margin* box, so a zero-height margin box lets the
  head overshoot the lane's end by its own height and puts two pinned prompts on screen during the
  handoff); the lane is positioned with `top`, **not** the `translateY` every other row gets
  (sticky resolves at layout time, a transform is paint-only, so under a translate the head sticks
  against the lane's un-translated box and never pins at all); and `rangeExtractor`, which forces
  the pinned row into the virtual range, must compute the active prompt from the virtualizer
  instance's own offset — the range pass runs before the render that would refresh a ref, so a
  value computed outside the callback is one scroll event stale.

- **A focus-takeover guard keys on where the keyboard IS, not on how many times an effect ran.**
  A `mounted` ref (refuse the first pass, follow after) is unsafe under React StrictMode, whose
  dev-only mount/unmount/remount preserves refs: the second pass sees `mounted === true`, skips
  the guard, and steals focus from a half-written message — correct in production, wrong in dev.
  Related, and the other half of the same rule: `isTyping` tests the field's *content*, not its
  focus. VS Code keeps the composer focused at all times (on session show, and on any dead-space
  click), so guarding on focus alone means the approval prompt can never take the keyboard. An
  empty field has nothing to lose; a half-typed message wins.

- **The pulse frames `⋄ ◇ ◈ ◆` (`U+25C6/7/8`) are East-Asian *ambiguous width*.** Under an
  East-Asian locale a terminal may render them double-width and shift every line carrying them, so
  they are safe only where the glyph sits centred in a fixed-width box — which is exactly what the
  terminal theme's gutter cell (`.term-gutter`, one `--term-cell` wide) is. **Anything writing to
  a real terminal must use the ASCII set instead.** Frames are 150ms so one cycle is the 0.6s
  clock `icon-loading.svg` pulses on, and the rest frame is the complete mark, so stopping never
  lands on a half-drawn one.

- **The vendored prompt-area's list continuation rewrites `- ` to `• ` in the MODEL, not just on
  screen** — a bulleted message reached the agent as `• item`, which is a list to no markdown
  parser and a glyph the character grid has no cell for. It is switched off in `Composer`; the
  convenience survives because `insertListContinuation` keys on `[•\-*] ` and reuses the line's own
  marker, so Enter after `- item` still inserts `\n- ` and Enter on an empty item still leaves the
  list. Relatedly the terminal composer's gutter interrupt is `✕`, not `■`: the square reads as a
  *state* in a column where `●` and `◆` really are states, and `✕` is one of the few candidates
  that measures exactly 1ch in JetBrains Mono (`⏹`, `⏸`, `⏻` are 1.05–1.31 cells and break the
  grid).

- **iOS: a tap that stopped a scroll is not a press.** `TerminalRowCell` puts a
  `UITapGestureRecognizer` on the cell, and `allowableMovement` does not cover this on its own — a
  tap recognizer measures movement in **window** coordinates, so during momentum scrolling the
  finger is perfectly still while the content slides under it. Zero movement, tap recognizes,
  whatever drifted under the thumb gets expanded. UIKit solves this for `UIControl`s via
  `delaysContentTouches`, but a recognizer on a cell sits outside that machinery. The rule is
  stated in `handleTap` with two signals, and it needs both: the scroll was already
  dragging/decelerating at **touch-down** (the stop-the-scroll tap — touching kills deceleration,
  so reading it at tap time is too late), or `contentOffset` moved between touch-down and lift (a
  drag). `allowableMovement` stays at UIKit's default 10pt: that IS the platform's tolerance for a
  finger that shifts slightly, and a hand-rolled threshold would disagree with every other tappable
  thing on the phone. The tap recognizer also must not recognize simultaneously with a
  `UIPanGestureRecognizer` — only with the text view's own, which is what makes selection work.
  Both the bug and the fix were **confirmed on a physical device** (2026-08-20); nothing in
  `apps/ios`'s app target has a test suite, so a thumb is the only thing that can check this.

- **Green means sub-agent in the transcript, and it is spent twice.** A settled *mutating* tool is
  already green on the **gutter glyph** (`items.tsx`, `TerminalPlanner.toolTone`), so sub-agent
  green went on the Task's **body** instead — the two channels stay apart, and a green dot keeps
  meaning "wrote to the workspace" rather than becoming ambiguous. Four things constrain any change
  here. **Strings are heights**: the summary strings in `tool-run.ts` / `height.ts` /
  `ToolRun.swift` / `TerminalPlan.swift` are rendered verbatim because they are what the height
  calculator wraps, so a colour change is safe only while it changes **no characters** — no `↳`, no
  badge, no prefix, and any `<Ink>` split must concatenate byte-identically. **iOS has one tone per
  line**: `TermLine` carries a single `tone` and `TerminalRowCell` applies it over the whole range,
  clobbering per-range foregrounds in `line.attributed` (only `.font` is merged), so "green label,
  dim tail" needs a `TerminalTextRun.make` change and whole-line green is what shipped. **A merged
  run destroys the label**: consecutive same-parent calls fold into a `RunBlock` whose text is
  `runSummary`, with no `Agent(...)` left to colour — accepted deliberately, because a Task folds
  into a run *only when childless*, and one that did real work becomes a `TaskBlock` that is never
  folded. **The spawner set is already spelled three times** (`SPAWNER_NAMES`, `tool-icon.ts`,
  `JSONValue+Display.swift`); a name-keyed colour rule would be the fourth, which is why the rule
  keys off block shape instead. Note those are different rules with different edges: a `TaskBlock`
  forms for *any* top-level call with children, not for a name.

- **iOS: a selectable `UITextView` eats the first tap, and `cancelsTouchesInView` does not save
  you.** `BodyTextView` is `isSelectable = true`, which installs the text view's *own* single-tap
  recognizer. The press recognizer lives on the cell's `contentView` — a **superview** — and UIKit
  resolves that conflict in the inner view's favour, so the first tap was spent making the text
  view first responder and never reached `handleTap`. That is the whole of the long-standing
  "I always need to tap an expandable row twice" report. `cancelsTouchesInView = false` is the
  obvious fix and is the wrong one: it governs whether touches are cancelled *in the view*, not
  which recognizer wins. The fix is `tap.delegate = self` with `shouldRecognizeSimultaneouslyWith`
  → `true`, so the press runs *beside* the text view's recognizers.
  **And that breaks a guard, which is the part worth remembering**: `handleTap` refuses a press
  while a selection stands in the row (collapsing the block would take the selection with it), but
  running simultaneously the text view may have **already cleared** the selection by the time the
  handler fires — so the guard reads zero and presses anyway. The selection length is therefore
  snapshotted at **touch-down** in `gestureRecognizer(_:shouldReceive:)`, and both readings must be
  zero. Any future simultaneous recognizer inherits this hazard: state a guard reads at handler
  time may already have been mutated by the recognizer it now runs beside.

- **iOS: gestures are the one surface no agent can test.** The simulator will not accept synthetic
  touches from an agent shell, and the app target has no test host, so every tap/press/selection
  rule above is verified by a human thumb or not at all. Budget for that rather than discovering it
  at the end of a gesture change.
## Web dashboard

- **Overriding a colour token lower in the tree needs its *alias* too.** `theme.css` has two
  tiers: a raw palette, then an `@theme inline` block mapping it to Tailwind's `--color-*`. Some
  of those go through a bridge alias — `bg-surface` is `--color-surface: var(--surface)`, and
  `--surface: var(--bg-surface)` sits on `:root`. A custom property is substituted where it is
  **declared**, so `--surface` computes to the root's `--bg-surface` once and that resolved
  colour inherits down. Redefining `--bg-surface` on a subtree therefore changes nothing for
  anything spelled `bg-surface`, silently and with no error. The dashboard's `.app-frame` sets
  `--bg`, `--bg-surface` *and* `--surface`; the first attempt set only the first two and the
  detail bar, the file rail and the panel's status bar stayed on the old colour while everything
  else moved.
- **`navigator.clipboard` does not exist on the origin this dashboard actually runs on.** It is
  gated on a *secure context* — HTTPS or localhost — and the normal WorkerDeck deployment is plain
  HTTP on a LAN address, reached from another machine or a phone. So the property is `undefined`
  there and `navigator.clipboard.writeText(...)` throws outright. Copy through `copyText`
  (`ui/src/lib/clipboard.ts`), which falls back to `document.execCommand('copy')` over an
  off-screen textarea: deprecated, universally implemented, and the only thing that works here.
  The textarea must be *off-screen* rather than `display: none`/`visibility: hidden` — a hidden
  element cannot hold a selection, so the copy would silently do nothing. Every copy
  affordance routes through `copyText`, `CopyAction` in `terminal/affordances.tsx` included — it
  gates its `✓` on the return value, so the tick only claims what actually landed.
- **`crypto.randomUUID()` is gated on a secure context too, so it is `undefined` on exactly the
  deployment multi-gateway exists for**: a dashboard served over plain HTTP on a Tailscale name.
  (`localhost` counts as secure, which is why it only breaks off the machine.) `newHostId()`
  therefore builds a v4 from `crypto.getRandomValues`, which carries no such gate, and uses
  `randomUUID` only where it happens to exist — the id keys a localStorage record, so uniqueness
  within one browser is the entire requirement.
- **The sub-agent frame round-trips through the URL, and three rules keep it from looping.**
  `SessionView` navigates `?subagent=<toolUseId>&sn=<n>` into the panel and folds the panel's
  `onSubagentChange` report back into the same param, so the URL stays the one truth about what is
  on screen (the sidebar's secondary selection reads it, a copied link reproduces it,
  Back/Forward drive the frame through `openSubagent`'s withdrawal semantics). (1) **No-op on
  match** — the commonest report is the echo of our own request, and navigating again for it
  starts a URL → panel → URL cycle with nothing to say. (2) **`sn` rides through unchanged** when
  the panel entered a frame the URL didn't ask for (a Task row pressed in the transcript): the
  panel's request effect keys on the nonce, so an unchanged one makes our write inert on arrival
  while a fresh nonce re-requests the very frame we are merely describing — a fresh nonce per
  report *is* the loop. (3) **`replace`, never push** — a report is bookkeeping about state
  already on screen, so Escape does not mint a history entry per press. The visible consequence: a
  frame entered from inside the transcript leaves no history entry, so Back from it exits the page
  rather than the frame; the strip's Back and Escape are the frame's own way out.
  `?reveal=<toolUseId>&rn=<n>` is a separate pair, not a flag — a **task** has no agent behind it,
  so framing its tool-use id selects no items and draws an empty agent view.
- **The VS Code webview stamps its first paint into the HTML, and has no `connect-src` at all.**
  Every byte to a gateway rides postMessage, so the shared skeleton declares no external
  `connect-src`; `img-src` allows http(s) for inline images on **keyless** gateways only, because
  header auth cannot ride an `<img>` (the same trade the iOS client makes). Everything the first
  paint needs — font mode, density, variant, terminal cell, affordances, panel font size — is
  stamped on `<html>`/`#root` rather than pushed over the bridge: a postMessage arrives one tick
  late and these decide every row's height, so a late reading reflows the whole transcript in
  front of the reader. Changing any of them re-renders the HTML.
- **The dashboard is a build artifact; the packages are not.** `pnpm dev:server` is
  `pnpm dashboard && pnpm cli …`, so the gateway serves `packages/web/dist/` while every package
  resolves to source through the `@workerdeck/source` condition. A long-running `pnpm dev:server`
  therefore keeps serving the JS it was started with — a UI change needs the server restarted (or
  `pnpm dashboard` re-run), even though a server-side change would too. Symptoms look
  web-specific and are not.
- **A Tailwind theme token cannot be re-pointed on a subtree, and `font-family` is not a token
  lookup at all.** `SessionPanel`'s `transcriptFont` scopes a monospace agent view to the panel
  by stamping `data-agent-font='mono'` on its root, and the obvious rule — redefine
  `--cw-font-sans` there — does nothing. Two reasons, both worth knowing before scoping any other
  token this way. First, `--font-sans: var(--cw-font-sans)` is declared in `@theme` at `:root`,
  and a `var()` inside a custom property is resolved against **the element that declared it**, not
  the one that inherits it: `--font-sans` computed the sans stack at `:root` and carries that
  resolved value down forever, so Tailwind's `font-sans` utility never sees the override. Second,
  the ambient typeface comes from `body { font-family: var(--cw-font-sans) }`, resolved once at
  `body`; every descendant inherits the *resolved stack*, and nothing under the panel re-reads the
  token. So the rule sets all three — both tokens **and** `font-family` itself. The VS Code
  webview's equivalent gets away with tokens alone only because its override sits on `html`, the
  same element `:root` declares them on.
- **A flex container hands its parent its FIRST item's baseline, not its text's.** The session
  status bar aligns its readings with `items-baseline`, and that alone was not enough: a
  rate-limit meter was an `inline-flex` whose first child is a 13px `ProgressRing`, so the row
  received a circle's baseline and the number sat 2.5px high; the status `Badge` handed over its
  dot's. The meters are plain inline text now (the ring is `inline-block align-middle`), and the
  badge takes `items-baseline` with `self-center` on its dot/spinner — `self-center` being a no-op
  under the default `items-center`, so `Badge` is unchanged for every other caller. The general
  rule: if a row must align on text, nothing decorative may be the first flex item.
- **The transcript is virtualized, and two things want to write `scrollTop`.**
  `use-stick-to-bottom`'s follow spring owns *staying at the bottom*; `@tanstack/react-virtual`
  wants to *correct* the offset whenever a row measures differently from its estimate. They are
  split by regime in `Transcript.tsx`: **pinned, corrections are suppressed outright** — being at
  the bottom is the whole scroll position, and a correction that moves the viewport up is read by
  the follow logic as a user scrolling away, which silently breaks the lock mid-stream. Escaped,
  the virtualizer corrects so the scrollback holds still under the reader.
  `anchorTo`/`followOnAppend` stay at their defaults so it never becomes a second follow
  implementation, and `shouldAdjustScrollPositionOnItemSizeChange` restates virtual-core's own
  default rules — supplying the callback *replaces* them, so a major bump there needs a re-read.
  Related, and the reason a re-pin bug is hard to reason about: **a programmatic `scrollTop` write
  does not escape the bottom lock — only a real input event does.** `use-stick-to-bottom` sets
  `escapedFromLock` from `handleScroll`'s reading of user *intent*, so a test that "scrolls up" by
  assigning `scrollTop` leaves the reader still locked and proves nothing about the pin; escape it
  with a synthetic `WheelEvent`. And the library's resize guard (`state.resizeDifference`) watches
  the **content**, while a composer that grows resizes the **scroller** — the two are siblings in
  the panel's flex column, so typing a newline shrinks the scroller and the row being read slides
  under the fold, with the content unchanged and no scroll event to notice it by. That class of
  size change the guard structurally cannot cover, hence a `ResizeObserver` of our own on the
  scroller's box, re-pinning **only when already pinned**.
- **A new height epoch invalidates every remembered size, the *measurements* included** — they
  were taken at the old width. `virtualizer.measure()` clears the size cache, but a row re-enters
  it only when its ResizeObserver fires, which needs a *size change*: a mounted row whose height
  happens to survive the width change (short lines that never rewrap) keeps its estimate forever,
  and wherever the estimate is off the transcript grows a phantom tail — measured at 2,052px of
  scrollable nothing after one sidebar toggle on a real session. So the mounted rows are fed
  straight back in, with two sharp edges. **Order**: `resizeItem` diffs a measure against
  `measurementsCache`, which straight after `measure()` is still the pre-wipe array, so an
  unchanged row diffs to zero and the write is skipped — reading any measurement first (e.g.
  `getTotalSize()`) rebuilds the array from estimates and the diff is real again. **`resizeItem`
  directly, never `measureElement(element)`**: the latter is gated on the scroll state and
  silently drops a measure that lands while a scroll is still hot, which a resize's own scroll
  anchoring makes routine.
- **`useFlushSync` looks like dead weight and is not.** It draws a React "flushSync was called
  from inside a lifecycle method" error — corrections fire from `measureElement`'s ref callback,
  inside the commit — which in an embedder's console reads as a WorkerDeck bug. Turning it off
  silences that and costs anchoring: over the same walk up through unmeasured rows, on holds the
  scrollback to the pixel, off let a step slide 112px under the reader.
- **A row the reader cannot see is not in the DOM.** Find-in-page and select-all reach only
  mounted rows, and a row's transient UI state (an expanded tool card) resets when it unmounts.
  Anything that needs to *find* a row must go through the virtualizer, not `querySelector` —
  which is why catch-up's "jump" is a closure the transcript fills in (`jumpToRecapRef`) rather
  than a DOM query, and why it has to re-aim: the offset it first scrolls to is the sum of a few
  hundred estimates, and only the rows it crosses make it true.
- **The transcript variant is a *panel-wide* context, not a transcript one.**
  `TranscriptVariantProvider` wraps `SessionPanel`'s whole tree, because the composer and the
  approval/question prompts render **outside** the scroller and still have to know. It was
  originally around the transcript alone, and the symptom of that is quiet: the prompts silently
  rendered as cards inside an otherwise terminal panel, with nothing erroring. Anything new the
  panel draws beside the transcript inherits the fix; anything an embedder mounts outside the
  panel does not.
- **Those outside pieces are separate `TerminalSurface`s, so they need the metrics passed too.**
  A surface sets the cell; one handed no `fontSize`/`lineHeight` falls back to the CLI's 13/18. A
  host running the transcript at its *editor's* size (the VS Code panel does) and leaving the
  composer at the default gets a caret on a different column from the conversation — the exact
  failure the theme exists to prevent. `SessionPanel`'s `terminalMetrics` is one prop feeding all
  three for that reason.
- **The markdown renderer marks its lists `list-inside`, and that is not a spacing preference.**
  With the marker inside the content flow, `padding-left` moves the *bullet* as well as the text
  (so a list sits a marker-width right of the paragraph above it) and a wrapped line runs back
  under the bullet instead of hanging under its own text. The terminal theme's markdown therefore
  goes through a Streamdown **component map** (`components/terminal/markdown.tsx`) rather than
  overriding the renderer's classes — that was the lesson of the retired `lines` variant, whose
  prose block had grown sixty `!important`s and still had to set `list-outside!` before its
  indents to keep both problems away. `cards` keeps the renderer's defaults on purpose.
- `SessionPanel`'s `header` prop takes a **function** when an embedder wants the session-actions
  (`⋯`) menu in its own chrome: it is called with the menu and the status bar then renders
  without it. The menu can only be built inside the panel (capability record, host-file verdict,
  dialog state), but an app with a real top bar wants it up there — hence the seam rather than a
  second menu.

## APNs push (the CLI's forwarder)

- **The `apns.topic` is the iOS app's bundle id, and the two halves live in files that never see
  each other.** It must equal `PRODUCT_BUNDLE_IDENTIFIER` in `apps/ios/project.yml`; there is no
  shared constant and no validation, and Apple's answer to a wrong topic is a rejected push rather
  than anything that names the topic. `keyFile` is a **path**, resolved relative to the config
  file, and never key contents — gitignore is not the plan for the `.p8`, which belongs in the
  password manager (it downloads exactly once, and a team gets only two active keys). There is
  deliberately no `environment` key: that is a property of each device token.
  `examples/dev-server.config.mjs` is the worked example.
- **The push `category` is a wire contract with the iOS app, and breaking it fails silently.**
  `forwarder.ts` sends `PERMISSION_REQUEST` for a permission request and `SESSION_EVENT` for
  everything else; the app registers its Approve/Deny actions under those exact strings
  (`PushPayload.swift`). There is no shared type between the halves and neither side errors on a
  mismatch — the notification simply arrives with no buttons on it, which reads as "approval from
  the lock screen is broken" rather than as a typo. Renaming one half means shipping both, and an
  older app keeps the old string. The same applies to the payload as a whole, which is why
  `pnpm smoke:push` goes through `buildPush` rather than a hand-written `aps` dictionary: a
  hand-rolled payload carries no `sessionId`, `PushPayload.init?` returns nil, and the tap routes
  nowhere — which reads exactly like a broken deep link and is not one.

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
  `InvalidProviderToken`); a loop of them is self-inflicted.
- **The session's `error` event fires a tick *after* the stream it kills settles**, so
  "keep the session's error and report it for the canceled stream" can never work for the very
  failure that canceled it — Node's `closeSession` destroys pending streams synchronously and
  emits the session's own event after socket teardown. `pool.lastFailure` therefore only carries
  failures that *preceded* the stream (a GOAWAY does; it emits before the teardown). The stream's
  own killer is mined from `error.cause` instead — and when a dial fails on every address family
  (api.push.apple.com has A + AAAA, Happy Eyeballs walks both), that cause is an `AggregateError`
  whose own message is **empty**: the production log line was
  `The pending stream has been canceled (caused by: ) (0)`, a silently lost push.
- **A push failure is retried exactly once, and only with proof Apple never processed it**: the
  stream was still `pending` (no stream id ⇒ HEADERS never handed to the transport ⇒ connect
  failed; redial after a beat), `request()` threw before a stream existed, or the reset was
  `REFUSED_STREAM` (the routine GOAWAY-rebalance race; RFC-guaranteed unprocessed, retry on the
  spot). Everything else — `Timeout`, `INTERNAL_ERROR`, any post-response death — is **never**
  retried: permission pushes carry no collapse id on purpose, so a duplicate is a second banner
  asking for the same decision. A still-`connecting` session whose stream died pending is
  destroyed so the retry (and every later push) dials fresh instead of queuing behind a doomed
  connect; `destroy()` without an error emits no `'error'`, so the no-crash rule holds.
- **Node's Happy Eyeballs gives each address 250ms, and Apple does not always answer in it.**
  `autoSelectFamily` is default-on since Node 20 and `autoSelectFamilyAttemptTimeout` defaults to
  **250ms**; `api.push.apple.com` publishes A *and* AAAA, so a dial walks up to six candidates.
  Measured from one machine during a failure burst: every IPv6 candidate answered `EHOSTUNREACH`
  instantly, IPv4 connects took ~600-700ms when allowed to finish, and the default therefore burned
  all six in ~765ms (≈3 × 250ms) and failed — **0/5 on the default against 5/5 with a 2s attempt
  timeout, interleaved seconds apart**. Each failure was a silently lost notification reported as
  `The pending stream has been canceled (caused by: )`. The client sets the window explicitly.
  Raising it beats `autoSelectFamily: false`, which measured no better and would strand an
  IPv6-only host. Note the trap in *testing* this: the same three-way comparison run outside a
  burst showed no difference at all (10/10 each), so a null result here means "no burst right now",
  not "no bug" — sample while it is failing or not at all.
- **A route that is never mounted is not unclaimed — the dashboard's SPA catch-all owns it.**
  With no `apns` config there is no device route, so `/apns/devices` fell through to the static
  host, which serves `GET, HEAD` and answered a registration POST with **405**, not the 404 every
  doc promised. The app reads only 404 as "no push here", so it threw instead, never marked the
  host synced, and retried on every foreground with a visible error — on what is the normal state
  of every gateway that never wanted push. The fallback now claims `/apns/devices` whether or not
  a forwarder exists. Generally: when a surface's contract is "absent means 404", something has to
  answer that 404, because the catch-all below will otherwise answer for it — and it will answer
  405 or a 200 with an HTML document, both of which read as a broken gateway rather than an absent
  feature. Only reachable with the dashboard on; `--no-web` 404s and hid it.
- **Two things 401 `pnpm smoke:push` against a real gateway.** `WD_AUTH_KEY` (the gateway's own
  operator secret, `<state-dir>/auth-key`) is needed the moment `--auth-key` is in play; and the
  host must be spelled **the way the gateway was started** — the Host-header guard rejects the
  tailnet IP of a gateway launched with `--host <name>`, and it answers `unauthorized` rather than
  anything that mentions hosts.
- `fetch`/undici will not do: APNs is HTTP/2 only, hence `node:http2` directly.
- The APNs key's **environment and restriction scope cannot be changed after the key is created**
  (the portal now forces the choice at creation, and a team gets only two active keys). WorkerDeck's
  is "Sandbox & Production" + "Team Scoped", which is what lets one key serve both endpoints.
- **Never implement a UIKit completion-handler delegate requirement in its `async` form when
  the completion must land on the main thread.** The compiler's synthesized `@objc` thunk calls
  UIKit's completion block on whatever executor the async witness finishes on — a
  cooperative-pool thread — and `UNUserNotificationCenterDelegate`'s `didReceive` completion
  drives snapshot/state-restoration work that asserts main thread: every notification tap
  aborted with `NSInternalInconsistencyException: 'Call must be made on main thread'` (eight
  identical device crash logs, 2026-08-19/20). The fix is the completion-handler form — reduce
  the `UN…` types to Sendable facts where the callback lands, hop to the main actor, call the
  completion there. A `@MainActor` witness is not the alternative: the requirements are
  nonisolated and Swift 6 rejects the conformance; `@preconcurrency` only moves the crash to a
  dynamic isolation assert that bets on UIKit calling the delegate on main, which the SDK does
  not promise (no actor or sendability audit on the protocol as of the iOS 26.5 SDK). Not
  unit-testable: the delegate lives in the app target and `UN…` types cannot be constructed —
  the gate is the compiler plus one tap on a real notification.
- **A tapped notification lands on the row it was about, and the seq → row answer has to be
  recorded as the transcript folds.** The payload's `seq` is the event behind the notification;
  nothing in the reduced transcript state can place it afterwards, because items are folded,
  merged and mutated by later events and only a few embed a seq in their id. iOS therefore keeps a
  landmark table beside the reducer (`TranscriptSeqIndex`), noting the item count either side of
  each `applyEvent` — **beside**, not inside, because `TranscriptState` is a hand-mirror of the
  react reducer and a field only one client needs is a field the two copies will disagree about.
  Two rules fall out of it: the lookup answers with the first item appended *at or after* a seq
  (an event that appends nothing — a permission request — must still resolve somewhere honest),
  and a `conversation_reset` invalidates every recorded index, so the table is dropped whenever the
  item count *shrinks*. The route carries the seq as part of its identity, so a second notification
  about the same session is a destination SwiftUI treats as new; what makes a repeat tap on the
  *same* notification re-fire is still `clearRoute()` putting the pending route back to nil.

- **Closing a container must close what it contains, and only this renderer has to say so.**
  iOS holds expansion *beside* the rows (`TerminalExpansion`) because every frame comes from the
  height book, so a height the book does not know about is a clipped row; the web holds it in
  component-local `useState`, where an unmounted child's state dies with it. That difference means
  the web collapses a chain's sub-items for free and the phone did not — it kept every member's
  key, so re-opening a run handed back the six expanded results the reader had just collapsed.
  `apply(_:subtree:)` closes the block's whole key set with a container. The `.call` guard inside
  it is load-bearing, not defensive: the subtree passed in is the whole **block**, so a single
  result closing "its" subtree would collapse every sibling in the same run.

## Build, test & packaging

- **A test's name is not its assertion, and only the assertion runs.** `404s when the instance has
  no forwarder` asserted `expect(status).not.toBe(200)`, which the 405 that was the actual bug
  passed happily — green from the day it was written (see §APNs). A negative assertion is the
  shape to distrust: it green-lights every wrong answer except one. Assert the status, the body,
  the value — if the test name states a contract, check *that* contract, or rename the test to
  what it really pins.
- **Verifying "it is really production React" — check the right marker.** On a `pnpm start:prod`
  bundle, `grep jsxDEV` *does* hit the main chunk and it is a false positive: the one occurrence
  is a markdown library's own options check. The real markers are `react-stack-bottom-frame` and
  the dev warning strings — zero of either means production. (Measured difference on one 976-row
  session at a pinned width: dev and prod share a p50, dev's p95 is ~2× prod's — all tail.)
- **`localStorage['workerdeck.transcript-variant']` is stored raw, not JSON.**
  `setItem(key, 'terminal')`; writing `JSON.stringify('terminal')` stores it with quotes,
  `getTranscriptVariant()`'s `stored === 'terminal'` fails, and the panel silently stays on
  Cards — which looks exactly like the setting not working. A fresh profile also *defaults* to
  Cards, so screenshot the panel before trusting any transcript measurement.
- **A heavy transcript for free: resume, don't generate.** `GET /v1/sdk-sessions?cwd=…&profile=…`
  lists what the engine store holds, and a create with `resume: <id>` and *no* first prompt
  replays the whole thread — the engine backfills, no turn is sent, no tokens are spent. A real
  ~1000-row transcript lands in seconds, which is the thing worth scrolling in a perf sweep.
- **`@workerdeck/ui/workspace` is a separate entry point purely so Monaco stays unreachable from
  the root entry**, and `sideEffects: false` is not what saves you. Rollup does drop `CodeEditor`
  from a `SessionPanel`-only bundle, but Vite resolves Monaco's `new Worker(new URL(…,
  import.meta.url))` calls during *transform*, before tree-shaking runs, and emits ~9MB of
  language-service workers as assets that are never retracted. Unreachability from the root entry
  is the thing that prevents it — which is also why `monaco-editor` is an **optional peer**:
  importing the workspace entry means installing it, importing only the root entry means not
  having to.
- **The dashboard aliases away Monaco's four worker-backed language services** (TypeScript, JSON,
  CSS, HTML): 8.8MB of the build, `ts.worker` alone 6.7MB of the TypeScript compiler, buying
  IntelliSense and schema validation in a pane whose job is reading and small edits. Monarch
  highlighting for ~90 languages is unaffected — a separate main-thread mechanism
  (`languages/definitions/*`). It is an alias rather than a hand-written Monaco entry because such
  an entry must import `codicon.css`, and monaco-editor's exports map (`"./*": "./esm/vs/*.js"`)
  cannot resolve a `.css` subpath at all; an embedder who wants IntelliSense simply omits the
  alias. The alias regex matches the **whole** specifier, not a suffix — Vite substitutes only the
  matched span, so a partial match leaves the `./` prefix glued to an absolute replacement path.
  Separately, `optimizeDeps.exclude: ['monaco-editor']` is load-bearing: the dev dep optimizer
  rewrites the package into `.vite/deps/`, where the `new URL(…, import.meta.url)` worker paths
  404, and Monaco then logs "Failed to load worker script" and silently runs the worker on the
  main thread — exactly the UI freeze the worker exists to avoid.
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
