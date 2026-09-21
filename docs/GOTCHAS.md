# Gotchas & invariants

Things that cost someone a debugging session. Each one is load-bearing: the obvious-looking
change is the wrong one. Grouped by where they bite. Architecture lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); this is the list of ways to get it wrong.

## Claude engine (Agent SDK / CLI)

- `cwd` is per-query in the SDK; the runner re-pins it every call. `SessionInfo.id` (server id) is
  not `sdkSessionId` (SDK session id used for `resume`).
- The SDK version floats (`^0.3.x`) and its unions grow; protocol mirrors must stay assignable
  both ways (SDK to protocol for events, protocol to SDK for options). Unmodeled SDK messages pass
  through as `sdk_event`: extend the protocol first-class, don't parse payloads client-side.
- `total_cost_usd`/`num_turns` on result messages are cumulative **for the engine process**, not for
  the session: roll up last-seen within one process, never sum. `usage` is per-turn: sum
  input+output+cache_creation+cache_read.
- **A session outlives its engine process**, through a dormant wake, a rebuild after a park, and a
  mid-session context clear. `CostLedger` (`core/src/lib/cost-ledger.ts`) is what keeps the session
  total whole: `observeCumulative` for an engine that reports a running total (claude),
  `observeDelta` for one that does not (codex, provider), `rollover()` at a `conversation_reset`,
  and `carryCost()` at rebuild from the `costState()` the park record saved.
- **A rebuilt claude process does not reliably count from zero, so its carry is reconciled, not
  added.** The CLI writes a `cost-state` line into its own transcript and restores `totalCostUSD` and
  `modelUsage` from it on a resume or a fork, so the woken process's first result already carries the
  earlier turns. But a transcript written by a CLI predating that feature has no such line, and then
  it does start at zero, and nothing the SDK emits says which happened. So `carryUnlessRestored` holds
  the restorable share pending and decides **once**, at the first non-empty cumulative reading: a
  restored total is the baseline plus new spend, hence at least the baseline on every model and every
  token field at once, and a reading that clears that bar is taken to already contain it. Adding
  unconditionally, which is the obvious implementation, **doubles the total in the common case**.
  Codex and provider report deltas and stay purely additive. A `/clear` is the one boundary that is
  certain: the CLI zeroes the ledger and scopes it to a new conversation id, so `rollover()` folds
  deterministically and pre-clear spend is never restorable.
- **`SessionInfo.totalCostUsd` and `SessionInfo.costUsd` are different claims.** `totalCostUsd` is
  what the engine reported and only claude reports one; `costUsd` is our own figure, priced from
  `usageByModel` through `protocol/src/pricing.ts`. Display surfaces read `costUsd ?? totalCostUsd`.
  An unpriced model yields `undefined`, never `0`: `$0.00` means free, `-` means unknown, and a
  table with no row for the model you actually use understates by an order of magnitude while
  looking fine, which is what `unpricedShare` exists to surface.
- `turn_result.usageByModel` and `turn_result.costUsd` are **session-cumulative for every engine**,
  which is what lets the server's `SpendLedger` bank a per-turn delta by differencing. Its baseline
  comes from `runner.info().usageByModel` at watch time, so a woken session's carried spend is not
  banked a second time.
- On `resume` the SDK re-streams only user messages; the runner backfills full history as
  `replay: true` events and the reducer dedupes doubled user messages by uuid. The SDK never
  echoes streamed-input user messages: the runner emits `user_message` itself in `sendMessage()`.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately: the runner fetches capabilities/context eagerly; `useClaudeSession` seeds
  mode/model/status from the `attached` frame's SessionInfo.
- CLI quirks (SDK 0.3.221): `getContextUsage().categories[].color` holds CLI theme token names,
  not CSS; `rate_limit` events can omit `utilization`, render unknown, never 0%.
- **Model list shaping happens once, in `core/src/lib/normalize.ts` (`modelOptionsFromSdk`)**, so
  no client invents its own. `supportedModels()` leads with a `value: 'default'` sentinel that is a
  choice, not a model; it's dropped and its `resolvedModel` forwarded as
  `capabilities.defaultModel`, the only way to name a promptless session's model before its first
  turn. `displayName` is the family alone or a variant string, so rows are renamed from their
  resolved id. The list is flat; `primary` (newest per family) is derived here since the CLI
  reports no grouping, then re-sorted into `FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku']`
  (unknown family sorts last). A derived name is used only when unambiguous: two rows of one family
  need the CLI's own names to tell apart.
- Model availability is purely a function of the pinned SDK version: older versions the CLI's own
  picker files under "more models" are in neither `supportedModels()` nor `initializationResult()`
  (confirmed: `claude-fable-5-1[1m]` and `claude-fable-5[1m]` both exist as catalog rows,
  `core/src/engines/claude/catalog.ts`). Taking a new SDK release is the only way a new model
  reaches us. `pnpm-workspace.yaml` sets `minimumReleaseAge: 0` (confirmed) since pnpm's exclude
  list can't express codex's platform binaries.
- **Two model-list truths coexist; keep both.** The live `capabilities` event is the in-session
  truth for the model switcher (also the only carrier of slash commands and the profile default's
  resolution). The static catalog (`core/src/engines/*/catalog.ts`, served on `ProfileInfo.models`)
  is the create-form truth: it fixes the cold-start free-text picker and may list models the CLI no
  longer reports. `defaultModel` can't be static (it's the operator's CLI config), so it alone is
  learned from sessions and stays absent on a cold server.
- `supportedModels()` reports per-model reasoning efforts (`supportedEffortLevels`, 0.3.221+),
  forwarded as `ModelOption.reasoningEfforts`; `CreateSessionRequest.reasoningEffort` maps to the
  SDK's `Options.effort`. Effort is an open string end to end (the CLI's vocabulary outruns typed
  unions, e.g. `max`) and the CLI silently downgrades an effort the model lacks, so over-offering
  is safe and under-typing is not.
- **`/clear` is a `conversation_reset`, not a new session.** The CLI parses `/clear` itself; the
  runner maps it to `conversation_reset`; reducers empty `items` while keeping session-scoped
  state. (1) The event log is never truncated, so `SessionRunner.subscribe` skips transcript
  content strictly below the latest reset (protocol's `transcriptContent`, broader than
  `transcriptActivity() > 0`); a superseded reset is skipped with the conversation it cleared.
  (2) `#activityCount` stays monotonic across the reset since it's the unread watermark; a catch-up
  boundary at or past the end of `items` yields no recap row and no dimming, which is what covers
  `/clear`. Clamping the boundary to the item count is the tempting fix and the wrong one: it would
  claim "nothing is new" about a session cleared out from under the reader. (3) The runner adopts
  `new_conversation_id` as `#sdkSessionId` immediately, not at the follow-up `system_init`: a
  dormant record written in between must resume the fresh conversation, not the cleared one.
  Pending approvals survive the reset; `permission_requested`/`permission_resolved` are state, not
  content.
- The CLI pushes `rate_limit_event` only when a window changes, so a watched-not-driven session
  shows no plan usage at all. The runner polls the structured `/usage` control request after init
  and after every turn and re-emits windows as ordinary `rate_limit` events
  (`rateLimitEventsFromUsage`). That control request is marked experimental in the SDK; if it
  disappears, usage goes back to change-only and nothing else breaks.
- **A session's own rate-limit reading can be arbitrarily old; the poll has no timer.** Its
  event-driven call sites (promptless start, `system_init`, `turn_result`) mean an idle session is
  never refreshed by anything it does itself, and replay re-installs the last reading as current.
  `Runner.refreshUsage()` (claude-only, throttled to a minute) runs on every attach, and
  `GET /profiles` asks one live session per profile for a newer reading when the held one is older
  than `USAGE_STALE_MS`. Both are fire-and-forget: never await either. `ProfileUsageTracker`
  (`server/src/services/profile-usage.ts`, confirmed) holds the account-level truth, fed from every
  session's `rate_limit` events, served as `ProfileInfo.usage`. Last-write-wins is by the event's
  own `ts`, never arrival order. The 0%-after-reset inference happens at serve time (confirmed
  `inferredReset: true` in that file), since a fabricated `rate_limit` event would replay from
  transcripts forever; an absent window stays unknown, never 0%. `usageIsStale` (protocol, older
  than `USAGE_STALE_AFTER_MS`, 15 min) is what every surface dims and labels "last reported..." by;
  never hide a stale reading. `mergeUsage` (protocol) prefers the profile's per-window reading
  wherever it exists, not by comparing timestamps.
- **The CLI's own session title is a poll, not an event.** No `SDKMessage` union member carries
  it; it lives on `SDKSessionInfo.summary` / `.customTitle`, returned only by `getSessionInfo` and
  `listSessions`. `SessionRunner` reads it at `system_init` and after each turn
  (`#fetchEngineTitle`). Not read at all while `meta.title` is set (a rename is a person's
  decision); `summary` is taken only when it differs from `firstPrompt` (the SDK falls back to the
  first prompt before a session has a real title).
- **A resumed transcript carries no structure.** `getSessionMessages` returns exactly
  `{ type, uuid, session_id, message, parent_tool_use_id, parent_agent_id, timestamp }`: `isMeta`,
  `isSidechain`, `promptSource`, `origin` are all dropped. The backfill can't mark a harness message
  synthetic from structure the way the live path does: `isSyntheticUserText`
  (`core/src/lib/normalize.ts`) matches the CLI's own wrappers instead (only `<task-notification>` /
  `<local-command-caveat>`). This belongs in the runner, not the reducer: `transcriptActivity`
  counts a non-synthetic user message as a row, so a row the client hides but the count counts is
  an unread badge for work nobody typed.

## Permissions

- **A turn that ends under a standing approval must be deferred, not discarded.** Session status
  is purely edge-driven (no poll, no reconciliation), so a single dropped edge is permanent for the
  session's life. If the turn-over guard returns early on the turn-over signal and `#settleApproval`
  then asserts `running` on the assumption an answered approval means work resumes, a session
  claims to run a turn that already produced its result, for hours, on every client at once (one
  runner field rendered three times). `#turnOverWhileBlocked` (confirmed in
  `core/src/engines/claude/runner.ts`) remembers the fact and the settle path applies it, clearing
  it the moment work genuinely resumes. Tests in `core/test/runner.test.ts` §"status after a turn
  ends under a standing approval" cover both cases. The codex runner applies `idle` ungated at turn
  end instead (harmless there).
- Allowing a permission MUST echo the tool input as `updatedInput` (undefined leads to ZodError,
  tool errors). The fake harness can't catch this class of bug: permission changes need a smoke.
- Switching a live session into `bypassPermissions` needs `allowDangerouslySkipPermissions` at
  spawn, fixed for the session's lifetime, reported as `SessionInfo.canBypassPermissions`: a picker
  disables the mode rather than offering a switch the engine will refuse. Rejected
  `set_permission_mode` returns a `protocol_error` frame.
- `AskUserQuestion` rides `canUseTool`; answers = allow with `updatedInput.answers` (question to
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- **`ENGINE_CAPABILITIES` in protocol is the one source of truth for per-engine permission-mode
  restrictions.** `PermissionMode`'s vocabulary is Claude Code's; other engines honor subsets and
  throw otherwise (`protocol_error`). `supportsPermissionMode(engine, mode)` is a lookup into that
  record; a core test pins each adapter's `capabilities` to it by identity. Don't re-encode any
  per-engine list elsewhere.
- **`disableBypassPermissions` is the server-wide mirror of Claude Code's
  `permissions.disableBypassPermissionsMode`, enforced at the gateway.** It refuses
  `permissionMode: 'bypassPermissions'` on session/job creation (403) and strips the
  `allowDangerouslySkipPermissions` pre-authorization from requests rather than refusing outright,
  so clients that ask for the capability by default keep working and only their later switch
  attempt fails.

## Provider engine (AI SDK v7)

- v7 inverts two conventions this repo had baked in: `result.usage` is already cumulative across
  steps (summing per-step usage double-counts; `AiSdkRunner` maps it once per turn), and a tool
  without a local `execute` terminates the loop rather than pausing it. Continuation is
  message-state replay (persist `responseMessages`, append a `ToolResultPart`, re-invoke), not
  resuming a suspended loop. Approvals map to v7's separate `toolApproval` mechanism. v7 is
  ESM-only and needs Node >= 22.
- `AiSdkRunner` streams every leg (`agent.stream`, never `generate`): `stream_delta` per token
  (suppressed by `includePartialMessages: false`), assistant/tool messages flushed per step. Tests
  must mock `doStream`, not `doGenerate`; only `generateDigest` still consumes `doGenerate`.
- A thrown `execute` yields a `tool-error` part absent from `result.toolResults` even though the
  SDK already fed the error back and kept looping. Deriving "which calls parked" from `toolResults`
  parks forever on an already-answered call: `AiSdkRunner` derives settled ids from
  `responseMessages` tool parts instead. Tool results are spliced before user messages typed
  mid-park (providers reject non-adjacent results); `interrupt()` rescues a parked turn by failing
  its calls; a turn whose history already ends with the assistant is skipped.
- Provider engines have no `supportedModels()`: the model picker offers `provider.models` as
  declared, falling back to `provider.model` alone. Don't ship a static model table for this
  engine, it goes stale for openai-compatible endpoints (claude/codex catalogs are the deliberate
  exception, since those model sets are properties of a pinned binary, not an operator's endpoint).
  `SessionInfo.engine`/`capabilities` are reported by each runner itself; no event carries them,
  the attach snapshot is the only source.
- `createEngineRunner` has four obligations invisible in its types, each a runtime-only failure:
  forward `restore` (else a woken session starts empty), adopt `id` (else the rebuild is refused
  and every client's route/watermark is stranded), seed the VFS only when not restoring (else the
  wake overwrites what the parked turn wrote), and dispose per-session resources in `onClose`
  (which also runs on park). `createEngineSession({ seedVfs, id })` covers two of these;
  `createProviderRunner` (server) does all four.
- The `'provider'` engine is the host-assembled escape hatch behind `createEngineRunner`: its core
  adapter is a pseudo-adapter (capabilities, an `apiKeyEnv` presence probe, an empty catalog) whose
  `createRunner` throws; the server routes provider creates to the hook.
- **An approval's `updatedInput` has to reach the model's history, not just the executor.** The
  assistant message already holds the `tool-call` part the model wrote; amending only
  `PendingToolCall.input` runs the edit while history still claims the original, so the next leg
  reasons from arguments never executed. `#amendToolInput` (confirmed in
  `core/src/engines/provider/runner.ts`) rewrites the matching history part too, immutably, inside
  `#dispatchSingle`'s pending guard, so an approval answered after an `interrupt()` already failed
  the call amends nothing. Both halves ride `#buildSnapshot`, so the edit survives park/resume.
- The transcript keeps the input the model wrote, on all three engines: the edit goes to the tool,
  not the row, and `permission_resolved` carries no input. Surfacing an edit in the transcript is a
  cross-engine protocol change, not a runner fix.

## Codex engine (`codex app-server` / the `@openai/codex` binary)

- **One `codex app-server` JSON-RPC child per session**, spawned lazily and held across turns; the
  conversation is a *thread* the binary persists in `CODEX_HOME`. Mid-turn mutability is off
  (`setModel`/`setPermissionMode` throw mid-turn); between turns everything is a `turn/start`
  parameter. We no longer ship the old `codex exec` transport (one child per turn, no partial
  messages, could not stream).
- **Wire framing is NDJSON with a bare envelope**: one JSON object per line, `{id, method, params}`
  / `{id, result|error}`, no `jsonrpc: "2.0"` field, notifications carry `emittedAtMs`. Handshake:
  `initialize` -> `initialized` (client notification) -> `thread/start`/`thread/resume` ->
  `turn/start`. Schema regenerates from the binary: `codex app-server generate-json-schema --out
  <dir>`.
- **The v2 vocabulary is camelCase; snake_case JSONL (OpenAI's exec-era docs) is a different
  protocol.** `agentMessage`/`aggregatedOutput`/`exitCode`/`localImage`, `fileChange.changes[].kind`
  as an object (`{type: 'update', ...}`), reasoning items carrying `summary[]` (default stream) and
  `content[]` (raw CoT, operator-config only) instead of `text`. Don't paste exec-era mappings.
- **Item ids are namespaced per turn**: `<nonce>:<itemId>`, a random per-turn nonce (not a counter,
  which would restart with a respawned process). Both transcript reducers upsert by id. Whether
  app-server item ids are unique per thread is unverified.
- **Streaming is real tokens** (`streaming: 'token'`): `item/agentMessage/delta` and reasoning
  deltas arrive token-by-token; `item/completed` supersedes the stream with final text.
  `smoke:codex` asserts deltas agree with the completed message.
- **A mid-turn message is `turn/steer`, not a queued turn.** `turn/steer {threadId, expectedTurnId,
  input}` takes the same `UserInput` union as `turn/start`; `expectedTurnId` is a precondition the
  server rejects once it no longer names the active turn, and rejection falls back to the queue path
  (message never lost, never duplicated). Detecting an unsupported binary: `runner.ts` treats both a
  literal `-32601` and a `-32600` whose message includes `unknown variant \`turn/steer\`` as "cannot
  steer" (measured against 0.153.4: unknown method is `-32600` via a serde miss on `ClientRequest`,
  not `-32601`). Steering is allowed while an approval is pending, since the approval gates the tool
  call, not the turn's input channel.
- **Approvals require two gates, either alone is not enough**: `initialize` must declare
  `capabilities: {experimentalApi: true}`, and `approvalPolicy` must be the granular object
  (`{granular: {sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval}}`) -
  the string vocabulary (e.g. plain `'untrusted'`) never asks. The runner declares `experimentalApi`
  unconditionally with no non-experimental fallback; `smoke:codex --canary` pins both gates.
- **A codex command approval is an escalation after a sandbox refusal, not a gate before
  execution.** The command already ran and was blocked; the request's `reason` is codex's own
  sentence, and accepting re-runs the command WITHOUT the sandbox. The runner authors
  `PermissionRequest.title`/`decisionReason` from that reason verbatim, anchored to the
  already-emitted tool card. Five wired channels: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval` (allow echoes the requested
  profile back, turn-scoped), `item/tool/requestUserInput` (AskUserQuestion convention),
  `mcpServer/elicitation/request` (allow's `updatedInput` becomes the elicitation `content`).
  Anything else gets a JSON-RPC -32601, not a hang. An unanswered approval waits forever unless
  `approvalTimeoutMs` (or gateway-wide `defaultApprovalTimeoutMs`) is set; unset/null/0 all mean
  never. Turn end, interrupt, child death and session close all sweep pending approvals.
- **`availableDecisions` is per-request, experimental, and gates the accept side only.** The runner
  sends plain `accept` only when offered; an allow the request doesn't offer plain accept for is
  answered with denial, never silently widened into `acceptForSession` or a persistent execpolicy
  amendment. `decline` is sent even when unlisted (the schema declares it unconditionally). `cancel`
  interrupts the whole turn and maps to deny + `interrupt: true`.
- **The spawn env replaces, never merges.** `spawn(..., { env })` gives the child nothing it isn't
  handed, so the runner always passes a complete environment - a delta silently strands
  `HOME`/`PATH` and the auth chain. The profile's `codexHome` pin rides this env (`CODEX_HOME`);
  `buildRunnerConfig` does not pin it the way claude profiles pin `CLAUDE_CONFIG_DIR`.
- **Auth is the `CODEX_HOME` store, full stop.** The app-server surface reads neither
  `CODEX_API_KEY` (honored only by `codex exec`, not shipped) nor `OPENAI_API_KEY`; either set, a
  turn goes out with no credential ("Missing bearer") - confirmed in `adapter.ts`. `codex login` /
  `codex login --with-api-key` persists into `$CODEX_HOME` (file, or under
  `auth_credentials_store_mode` the OS keyring), which makes `codex login status` exit 0. The
  availability probe trusts `login status` alone. The "Not logged in" verdict prints on stderr and
  the success line includes a masked key fragment: surface exit codes and fixed strings only, never
  that output.
- **The keyring store doesn't break the `codexHome` pinning trap, but for a subtler reason**: the
  store (file vs OS keyring) is chosen by config inside the home, not by whether `CODEX_HOME` is
  set, so pinning the default home stays harmless. No analogue of `claudeSessionEnv`'s skip exists.
  Whether a keyring login is scoped per-home or per-user is unverified.
- `@openai/codex` is pinned to an exact minor (`~0.155.1`; pre-1.0, JSON-RPC schema regenerates per
  release). It's an optional peer of core (floor `~0.149.0`; absent -> profiles report unavailable,
  creates throw the install message) and a real dependency of the CLI. The runner drives the binary
  directly with no SDK in between (`@openai/codex-sdk` is exec-only, no app-server client), resolved
  through the wrapper package to `vendor/<triple>/bin/codex`. Any change to `CodexRunner`'s spawn
  options, handshake, or event mapping needs a `smoke:codex` run.
- **`turn/completed` carries no usage.** Usage rides `thread/tokenUsage/updated`, whose `last` is
  one model request, not the turn: a tool-looping turn updates several times, so per-turn usage is
  the sum of `last` values seen during the turn, remapped to the Anthropic convention: `inputTokens`
  minus the cached share, reasoning tokens folded into output, `totalCostUsd: 0` = unknown. `total`
  is thread-cumulative and unused (its baseline after a resume is unknowable). Asserted in
  `smoke:codex`.
- **Context usage is the opposite half of the same notification; mixing them up is silent.**
  Occupancy is `last.totalTokens` (overwritten, never summed) against
  `tokenUsage.modelContextWindow`, emitted as a `context_usage` event after each turn - a request's
  input already contains the whole conversation, so the newest request is current occupancy. Sizing
  off `total` instead climbs toward 100% on an almost-empty thread. The event fires only when the
  window is present (no window, no reading - never render 0%), and `categories` is always empty
  (codex publishes no breakdown); an empty breakdown is valid, clients must not draw an empty
  "Breakdown" section.
- **The reported window is a pricing policy, not the model's size.** Formula pinned against 0.149.0:
  `reported = min(model_context_window ?? context_window, max_context_window) * 0.95`. Default read
  for `gpt-5.6-terra` is 258400 though its published API limit is 1,050,000 context; the compiled-in
  catalog says `context_window: 272000, max_context_window: 872000`. 272000 is OpenAI's 2x-billing
  boundary, not a capability ceiling; the 5% is a reserve.
  - The meter reports the window codex actually budgeted for the thread (what decides
    auto-compaction), not the model's ceiling.
  - An operator who wants a bigger window sets `model_context_window` in their own
    `~/.codex/config.toml` - a cost/quota decision, so WorkerDeck never writes it (same posture as
    `network_access`). Caveat to carry with the advice: openai/codex #16068 (dup of #16033, reported
    on 0.116/0.117, unverified on 0.149.0) says raising it breaks auto-compaction permanently after
    the first overflow, because `fill_to_context_window()` writes a near-zero delta and the check
    never fires again.
  - **The cap moves between releases** (openai/codex #32806, #30875): a past reading is not evidence
    against today's reading.
  - **"I reached 800k tokens" is the total-vs-last trap.** The TUI's cumulative `total` passes 800k
    without occupancy ever leaving the window, because auto-compaction keeps resetting it. Since
    2026-09-02 compaction is drawn: `contextCompaction` maps to a `context_compacted` event and a
    boundary row (appears when compaction starts, settles when it lands), and the 272K tier is
    explained in-product from `packages/ui/src/lib/context-note.ts` (keep in sync with
    `docs/PACKAGES.md` §`packages/ui`). The occupancy ring itself deliberately carries no compaction
    mark - it answers "how full now," the transcript row answers "what happened."
  - **Never hardcode a window in our catalog to "correct" this** - it would be wrong for any
    operator who set the override.
  - Unverified: whether the reported window can move mid-thread. The occupancy rule (newest
    `last.totalTokens` against the newest window) would handle it if it did.
- **Rate-limit windows are positional on the wire, named here by measured duration.**
  `account/rateLimits/updated` reports `primary`/`secondary` with `windowDurationMins`; the runner
  maps 300 min -> `five_hour`, 10080 min -> `seven_day` (exact matches), anything else ->
  `window_<n>m` (clients print verbatim, no marker). `status` is `'allowed'` by construction;
  codex's `rateLimitReachedType` is the only signal that flips it `'rejected'`. A window with no
  `usedPercent` is unknown, not zero, and dropped. Unlike Claude (which pushes only on change),
  app-server pushes these during a turn, so the runner only listens. `planType` becomes `plan_info`,
  emitted once per change.
- **Permission modes ride two wire axes in lockstep**: the sandbox (`default` -> read-only,
  `acceptEdits` -> workspace-write, `bypassPermissions` -> danger-full-access) decides what needs
  asking; the granular approval policy decides whether asking happens (`default`/`acceptEdits` all
  flags on, `bypassPermissions` all flags off). So `default` now escalates a blocked write to a real
  question rather than silently degrading - closest to Claude's `default`, except approving runs the
  command unsandboxed. `acceptEdits` auto-runs in-workspace writes and still asks for what the
  sandbox refuses. `plan`/`dontAsk` are not offered (CLI-only workflows codex can't deliver). Each
  policy is stated twice on the wire: `thread/start` takes `sandbox` (string) + `approvalPolicy`,
  `turn/start` takes `sandboxPolicy` (object) + `approvalPolicy`; keep all four in lockstep.
- **`auto` is a third axis (who reviews), not a fourth sandbox.** It's workspace-write + ask (same
  sandbox/flags as `acceptEdits`) plus `approvalsReviewer: 'auto_review'` on both `thread/start` and
  `turn/start`, routing every approval to codex's risk-assessing subagent instead of the user. The
  reviewer is stated explicitly for every mode (`'user'` for the other three), never omitted,
  because a thread inherits it across turns and a stale `auto_review` would survive a switch back.
  Codex's reviewer is a fixed, OpenAI-prompted subagent with no configuration surface, unlike
  Claude's operator-configurable `auto` classifier (`autoMode.environment`) - same mode name,
  different tunability, say so wherever the mode is explained.
- **Network access is a separate axis from approvals, and `turn/start`'s object-form sandbox policy
  can silently take it away.** Inside workspace-write, `network_access` is off by default and no
  approval policy turns it on: a `git push` under `acceptEdits` fails with `Could not resolve host`
  rather than raising a question. The operator's `[sandbox_workspace_write] network_access = true`
  in `config.toml` is the only supported way to enable it; WorkerDeck must not unset it either.
  `sandboxPolicy` is serde-defaulted field by field, so sending `{type: 'workspaceWrite'}` bare
  resets `networkAccess` to false and `writableRoots` to empty on every turn, silently overriding
  config.toml. The runner reads `config/read { cwd }` once per child and echoes the block back
  verbatim every turn (needed so a between-turns mode switch still takes effect). `read-only` is
  untouched - the setting is scoped to workspace-write. `smoke:codex` pins the `config/read` block's
  four fields.
- **Model/effort overrides persist "for this turn and subsequent turns."** The runner names the
  model and effort explicitly on every `turn/start`, remembering the resolved defaults from the
  `thread/start` response, so `setModel(undefined)` can mean "back to the profile default" again.
- **Resume backfill reads `thread/resume`'s own response; `turns` is populated only there** (plus
  `thread/rollback`, `thread/fork`, and `thread/read` with `includeTurns: true` - every other
  Thread-bearing response/notification carries an empty `turns`). Item ids restart per turn on
  replay (`item-1`, ...), so each historical turn gets its own nonce, same as live turns. A non-null
  `turnsBackwardsCursor` means the resume page is partial; the runner then fetches the whole rollout
  via `thread/read {includeTurns: true}` (no cursor surface), and if that fails too it replays the
  partial page under a `session_error` notice. Replay events are stamped `replay: true`; a resume's
  new-turn `user_message` echo is deferred behind the replay; a reconnect after a dead child goes
  through `thread/resume` again without stashing anything, so history is never replayed twice.
  Backfill costs no tokens, but does make a promptless resume spawn its child eagerly.
- **`thread/list` answers `GET /sdk-sessions` for codex**: one short-lived child per request, closed
  before responding (`adapter.ts`). Page-size param is `limit` (not `pageSize`), `cursor` continues,
  `sortKey: 'updated_at'` matches `lastModified` ordering, timestamps are epoch seconds (protocol
  wants ms), and the `cwd` filter is an exact path match accepting an array - pass both the spelled
  and realpath'd forms, or macOS `/tmp` dirs silently miss `/private/tmp` threads. The resume id is
  the row's `id`; the row's separate `sessionId` field is NOT what `thread/resume` takes.
  `ephemeral` rows are dropped (never materialized: nothing to resume). `?profile=` picks whose
  store to list; absent, exactly-one-profile servers resolve implicitly and multi-profile servers
  keep the legacy claude-store answer.
- **A dead child is a failed turn, not a failed session.** The thread lives on disk in `CODEX_HOME`,
  so the runner drops the connection, fails the in-flight turn with the exit + stderr tail, and the
  next message spawns a fresh child that resumes the same thread id. `turn/completed(status:
  failed)` and a rejected `turn/start` land the same way. Codex has no instructions surface
  (`session.instructions` on a codex profile is refused at startup; codex reads the cwd's
  AGENTS.md), no per-session MCP (`CODEX_HOME`'s config.toml owns servers; `/mcp` 501s), and image +
  text attachments only (images as `localImage` host temp-file paths, text inlined; a PDF has no
  representation and 415s).
- **An unmapped `ThreadItem` is invisible, not merely unstyled.** Unknown item types fall to the
  `sdk_event` `codex.<type>` channel, which no UI renders. When codex adds an item type, extend the
  union (`codex app-server generate-json-schema --out <dir>` or `generate-ts` dumps the
  authoritative list). `pnpm smoke:codex --canary` pins the union: fails on a variant new since
  0.146.0, warns on one merely unmapped, free (local dump, no network/auth). Reports 7/19 unmapped
  on 0.151.0: `hookPrompt`, `functionCallOutput`, `plan`, `dynamicToolCall`, `sleep`,
  `enteredReviewMode`, `exitedReviewMode`. Mapping every variant isn't the goal; knowing about each
  one is - the KNOWN set carries a note per deliberately-unmapped variant.
- **A generated image is a host path, never bytes.** `imageGeneration.savedPath` is absolute on the
  host, by default under `$CODEX_HOME/generated_images/`, or in the workspace when the model was
  told the asset belongs to the project. The runner puts it in the tool card's input (a field, not
  prose), and a client renders it by reading back through `/fs/read` - only when the path is under
  an allowed root and within `hostFiles.maxFileBytes` (1 MiB default, a full-size generated PNG
  exceeds it); otherwise the card names the path. An operator who wants previews must declare
  `hostFiles.roots` (restating the cwd roots plus `$CODEX_HOME/generated_images`) and raise
  `maxFileBytes`; `examples/dev-server.config.mjs` does this. Grant the drawer, never `~/.codex`
  (same directory holds `auth.json`). The item's `result` is an undocumented free-form string,
  length-capped before it reaches the event log; base64 never goes on the wire.
- **A sub-agent is a separate thread on the same connection; `threadId` is the only signal.** We
  never send `multiAgentMode`, but an operator's config can enable it (default posture
  `explicitRequestOnly`). A spawned agent announces itself as a `subAgentActivity` item on the root
  thread (`{id, kind, agentThreadId, agentPath}`, `kind` in
  `started|interacted|interrupted|completed`). Codex sends no `tool_use` for a spawn, so the runner
  authors the anchor call itself as `CODEX_AGENT_TOOL`. Thereafter the child's items, deltas, token
  usage and turn lifecycle arrive on the same JSON-RPC connection, distinguished only by `threadId`.
  - **Thread-scoped notifications must be read off the root thread only.** `turn/started`,
    `turn/completed` and `thread/tokenUsage/updated` are per-thread facts; a child's
    `turn/completed` can arrive while the root turn is still running. `THREAD_SCOPED_NOTIFICATIONS`
    in `runner.ts` (`turn/started`, `turn/completed`, `thread/tokenUsage/updated`,
    `turn/plan/updated`) gates this against `#isRootThread`.
  - **Items and deltas are deliberately not filtered** - a sub-agent's work belongs in the
    transcript, attributed by `threadId`.
  - **A child's items resolve through the agent's own `ItemScope`, never the root turn.** Agents
    outlive root turns by design, so the root's `#activeTurn` cannot be the gate: each `CodexAgent`
    carries its own nonce (its anchor id), tool-use latch and reasoning section index, and
    `#itemContext` picks the agent's scope when `threadId` names one. Between root turns the root
    thread is heard for `subAgentActivity` only (a settle or a relabel); every other root item with
    no turn is still dropped. Pinned by the outlives-the-turn test in `core/test/codex-subagents.test.ts`.
- **`WORKERDECK_CODEX_TRACE=<file>`** (`CODEX_TRACE_ENV` in `jsonrpc.ts`) dumps raw inbound
  app-server traffic (notifications and server->client requests, JSONL, appended). Off unless set,
  and deliberately skips `account/*` and `login*` - the one place this protocol can carry a masked
  credential fragment.
- **The app-server has no slash-command surface at all**: no command-listing RPC exists, codex's own
  `/model`, `/approvals` etc. are TUI-local. `slashCommands: false` is correct; a composer must hide
  the `/` popover. (`skills/list` does exist, so surfacing skills is a real possibility.)
- **A clear is a fresh thread on the same session** - codex has no reset RPC. `thread/compact/start`
  summarises and continues, `thread/fork` makes a second thread, `thread/goal/clear` is unrelated;
  none of them are a clear. `clearContext()` drops `#sdkSessionId`, sets `#threadLoaded = false`,
  and lets `#ensureThread()` do `thread/start` instead of `thread/resume` (the dead-child path minus
  the resume).
  - **It rides the turn chain**, which serialises everything touching `#ensureThread` (`#runTurn`
    and the resume backfill, which is a chain link and not a turn). A guard on `#activeTurn` alone
    is not equivalent: a `clear_context` arriving mid-backfill can race a concurrent `thread/start`,
    either replaying the cleared conversation above the reset or losing the backfill outright, or -
    with two `thread/start`s in flight - wedging the chain so the turn never settles. One entry
    point, on the chain, for both callers. It must NOT wipe `#queue`: messages queued before the
    clear link runs have already executed; whatever is left was typed after and belongs to the new
    conversation.
  - **The new thread id is adopted before `conversation_reset` is emitted** whenever a child is
    already up (an eager `thread/start`, no tokens/model call). Mirrors the Claude engine's
    immediate adoption of `new_conversation_id`, so a dormant record written mid-clear names the
    fresh conversation. The fallible step goes first and rolls back on failure (restores the old id)
    - a half-clear is the worst outcome.
  - **With no live child there is no id to adopt**, so the session sits with no `sdkSessionId` until
    its next turn. The parking service deletes the stale dormant record (`#forgetDormant` in
    `packages/server/src/services/parking.ts`, narrower than `discard`) rather than let a restart
    wake the session into the transcript the user just cleared. Consequence: for codex the dormant
    record IS the session's way back, so a session cleared while its child is dead does not survive
    a restart at all - the row is simply gone.
  - **The context reading is retired and cannot be re-polled** (unlike Claude). Codex's only source,
    `thread/tokenUsage/updated`, arrives during a turn, so there's no reading until the next turn
    runs - render nothing, never 0%.
  - **Sub-agents are `forget()`-ten, not `sweep()`-ed.** Sweep settles running agents as failed and
    keeps the rows (right when the process dies - anchor cards are still in the transcript). A clear
    removes the anchors along with the transcript, so a surviving row would publish a `toolUseId`
    resolving to nothing. But an agent outlives the root turn by design, and a clear neither
    interrupts it nor drops the child, so its traffic keeps arriving. `#clearedThreads` remembers
    cleared thread ids for the session's life and drops their notifications (including pending
    approvals, unanswerable against a transcript the user can no longer see).
- **`/clear` typed into a codex composer is intercepted by the runner**, the same call the
  clear-context capability makes (one entry point). Without the intercept the string would go to the
  model as an ordinary prompt and get an ordinary answer - no error, which is worse than an error.
  The intercept is narrow (bare word after trimming, no attachments; "explain what /clear does" is a
  prompt). A clear sent while a turn is running queues behind it rather than cutting the turn short.
- **The cleared thread is not deleted.** It stays in `CODEX_HOME` and stays resumable from `GET
  /sdk-sessions` - worth saying in any UI copy, since "clear" reads as "gone."
- **The context reading cannot witness a clear; only asking the model can.** A fresh codex thread
  already reads ~14k tokens before anyone types (system prompt, tool schemas, skill list), so two
  small turns either side of a clear both read near that floor and a smaller number is
  indistinguishable from noise. `pnpm smoke:codex --clear` proves the reset by asking the model for
  something it was told pre-clear and watching it fail, reporting the reading rather than asserting
  it.
- **A project's `.codex/config.toml` is read only if that project is trusted, and in a read-only
  sandbox codex cannot ask - it silently reads nothing.** Trust is a `[projects."/abs/path"]
  trust_level = "trusted"` entry in `$CODEX_HOME/config.toml`; the vanilla TUI prompts and writes
  it, `codex app-server` has no prompt. A session on a project nobody opened in a terminal ignores
  its `.codex/config.toml` (MCP servers, model pins, all of it) with no error.
  - **The gate is sandbox-scoped.** Only `read-only` (WorkerDeck's `default` mode) leaves the
    project untrusted. A `thread/start` under workspace-write or danger-full-access (`acceptEdits`,
    `auto`, `bypassPermissions`) writes `trust_level = "trusted"` into the operator's own
    config.toml and then loads the project config - codex writes trust entries on our behalf there
    even though WorkerDeck itself never does. A notice is shown only in `default` mode
    (`#warnUntrustedProject`), since it would be false in the wider modes. A mid-session widen does
    not heal an already-started thread.
  - **Discovery and trust are per-layer, not "walk up forever."** The layer chain is the cwd and its
    ancestors up to and including the nearest directory containing `.git` (with no git anywhere, the
    cwd alone); every layer's `.codex/config.toml` loads. Trust is decided per layer: an exact entry
    for that layer wins (an explicit `"untrusted"` beats inherited trust), otherwise it inherits
    only from the chain's git root's entry. A trusted mid-chain directory does not trust its
    children; a nested repo isn't covered by the outer repo's entry; a linked worktree inherits from
    its main repository via the `.git` file's `gitdir:`. `trust_level` accepts exactly
    `trusted`/`untrusted`; anything else fails codex's bootstrap.
  - **Canonicalize both sides.** macOS `/tmp` symlinks to `/private/tmp`; codex canonicalizes the
    cwd before matching, so a hand-rolled comparison against a non-canonical entry misreports a
    trusted project as untrusted.
  - Not the gate, despite looking like it: codex version, whether the directory is a git repo
    (shapes the layer chain, doesn't gate it), and spawn cwd (`process.ts` deliberately passes none
    - codex resolves project config from the thread's cwd).
  - `engines/codex/trust.ts` implements the match and emits the notice as a `session_error` at
    session start; its parser refuses anything it can't read with certainty (multi-line strings,
    inline-table `projects`, array-of-tables, conflicting duplicates) because a false notice is
    worse than a missed one. WorkerDeck never writes the trust entry itself - doing so on the
    operator's behalf sits against the codex auth red lines in `CLAUDE.md`.
- **`SubagentInfo.toolUseId` keeps its documented meaning on codex.** The spawn signal is the
  `subAgentActivity` item, whose own `id` is the model's `spawn_agent` call id (a genuine tool-use
  id); the runner authors the anchor `tool_use` itself and keys every event of the agent's thread to
  it (`engines/codex/subagents.ts`).
- **The sub-agent tracker keys by thread id but publishes a tool-use id - don't confuse the two.**
  Unlike the claude tracker (which infers spawns from tool names and result-text sniffing),
  `subAgentActivity {kind: 'started'}` positively announces an agent, names it (`agentPath`), keys
  it (`agentThreadId`), and hands over the model's own `spawn_agent` call id. So the map is keyed by
  thread id while publishing a tool-use id: `parentToolUseId` on nested events must equal the anchor
  `tool_use`'s id for `subagentItems` to reassemble the sidechain. A record survives the runner's
  turns (agents outlive the root turn by design); `sweep()` ends them all when the app-server child
  dies or the session closes. The settled tail is bounded by `SUBAGENT_HISTORY`
  (`packages/core/src/engines/codex/subagents.ts`), enforced once per agent at settle time, not at
  `list()` time; running records are never capped.
- **An agent settles on its `subAgentActivity {kind: 'completed'}` item, not only on its thread's
  `turn/completed`.** The kind enum is `started`/`interacted`/`interrupted`/`completed`
  (schema-verified against 0.153.4 and 0.155.1). `turn/completed` on a thread we never subscribed to
  is not guaranteed to arrive, which used to leave the record `running` forever. Both paths now
  settle and `settle()` is first-wins: the thread's `turn/completed` supplies the richer report when
  it arrives first, the item-only path closes the row with an empty result (the item carries no
  text). Pinned by the two ordering tests in `core/test/codex-subagents.test.ts`.
- **An unannounced non-root thread still gets an agent record.** `#agentFor` mints one for any
  thread emitting items on the connection (codex runs threads of its own for review/compact, and a
  `subAgentActivity` could in principle be missed) - the claude tracker's nested-event fallback on a
  stronger signal. The minted record is label-less with its anchor `tool_use` authored on the spot,
  since an attributed event whose `parentToolUseId` matches no top-level call renders inline instead
  of as a frame; a late `started` edge fills the name in.

## Engine adapters & capability records

- **`checkAvailability` and `listSessions` take the profile's complete session environment, never
  a delta.** `AvailabilityTracker` passes `sessionEnvFor(profile)`, the same assembly the real
  create path produces. A delta is a plausible-looking, broken optimization: codex replaces its
  child env wholesale, so a delta strands `HOME`, `PATH` and the auth chain.
- One engine = one `EngineAdapter` in `core/src/engines/` (capabilities, shipped catalog,
  availability probe, runner factory), looked up via `getEngineAdapter`. The invariant: (a)
  `server` imports no model SDK, (b) the gateway process holds no credential material, (c) provider
  credential resolution stays in host code. Codex resolves its own auth from the session env, same
  as claude.
- **`JobQueue.submit` deliberately does not validate `cwd`, and must not start.** Whether a session
  needs one is `EngineCapabilities.hostCwd`, resolved at the door by the session factory's
  `checkCwd`. A second copy of the rule inside the queue would refuse the filesystem-less provider
  engine outright.
- `ProfileEngine` stays a closed union on purpose: both clients switch exhaustively, the Swift
  mirror ships in lockstep. Adding an engine is a versioned protocol event, not a string.
- The capability record is dual-sourced: `ENGINE_CAPABILITIES` in protocol (browser-safe default)
  and the server-stamped `ProfileInfo.capabilities`/`SessionInfo.capabilities` (wire truth, wins
  when both exist). A conformance test pins the adapters to the protocol record by identity.
- Catalogs are versioned with releases; the release checklist re-runs each catalog's extraction and
  diffs. Availability probing is gated on `checkCredentials` (an `AvailabilityTrackerOptions`
  field, confirmed in `server/src/services/availability.ts`), cached ~60s, refreshed lazily on
  `GET /profiles`, and display-only by default: create against an unavailable profile still
  proceeds and fails with the engine's own error. `requireAvailableProfile` 503s the create with
  the probe's reason instead, but refuses only on a definite `false`; unprobed stays allowed. The
  `engines` server option overrides adapters for tests only, not an extension point.
- `createEngineRunner` may return a promise, so per-session assembly (an MCP connect, a credential
  lookup) can be awaited there, disposed via `AiSdkRunnerConfig.onClose`; a rejection fails the
  create.
- **A client renders from the record, never from the engine name.** `TranscriptState.capabilities`
  is always populated (wire copy from the attach snapshot, else the protocol default), which lets
  one `SessionPanel` be correct for all three engines. Gating the model picker on the `capabilities`
  event alone breaks codex (which never sends one); the catalog on `ProfileInfo.models` is the
  fallback that fixes it.
- **A catalog row's `value` is an alias; a session reports a resolved id.** Rows read `opus[1m]`,
  `sonnet`, `claude-fable-5-1[1m]`; a running session reports `claude-opus-5[1m]`. Match through
  `ModelOption.resolvedModel` (authoritative when present, including when it disagrees: two rows of
  one family can differ only there, e.g. `claude-fable-5-1` beside `claude-fable-5`), falling back
  to the family token for a server too old to send it. The match rule is written once per client
  (`ModelSelect.optionMatches`, Swift `ModelOption.matches`) and the two must stay identical.

## Tool trust & the sandbox

- Tool trust is a boundary, not decoration: only `sandboxed` tools may leave the server, declared
  without `execute` (the AI SDK halting on those is the seam). MCP and any secret-bearing tool is
  `authoritative`; bridging one would let a browser forge authoritative results. `withMcpTools`
  throws on a name collision for that reason.
- Sandbox guest limits are interpreter-enforced, but the interrupt deadline cannot preempt time
  inside a host function: every granted capability needs its own timeout
  (`QuickJsExecutor#fetchText`, `fetchTimeoutMs`, default 10000ms, independent of the guest's own
  deadline; confirmed in `core/src/executors/quickjs-executor.ts`). Host and guest values cross by
  value only; never hand the guest a host object by reference: that prototype-chain leak is the
  CVE-2026-5752 failure shape, and `packages/sandbox/test/run-script.test.ts` pins it with a red
  team case walking `({}).constructor.constructor` to a `globalThis` that stays inside the guest
  realm.
- Host tools go in through `createEngineSession({ tools })` with a stated trust; contradictions are
  refused at assembly, not runtime: a `sandboxed` tool carrying `execute` would run in-process with
  the gateway's authority; an `authoritative` one without `execute` would park the turn on a call no
  executor claims. `mcpTools` cannot express a sandboxed tool at all: everything in it is
  authoritative by construction.
- AI SDK MCP lives in `@ai-sdk/mcp` (not `ai`) as of v7, imported lazily, supports http/sse only:
  stdio is rejected explicitly (confirmed in `core/src/engines/provider/session.ts`). Claude-engine
  sessions still do stdio, since the CLI spawns those itself.
- **A stateless MCP server must answer `GET` with 405.** The client opens the SSE stream with a
  `GET` before sending anything; mounted under a framework's default 404 the connect fails with an
  error naming neither the method nor the route. Every embedder mounting a POST-only server hits
  this.
- **A declared MCP server that didn't connect refuses the build.** `profile.session.mcpServers` is
  a declaration; honouring it partially means the session reports healthy while the agent
  apologises through every request that needed the server. `connectMcpTools(…, { required: true })`
  fails at connect time instead. Hand the connection to `createEngineSession` as `mcp`, not just
  `mcp.tools`: a tool set alone can't tell "connected, exposes nothing" from "never connected".
- The provider engine's `mcpStatus` capability is `true` and `AiSdkRunner.mcpServers()` always
  answers: an empty list when no MCP was wired, never `undefined`. Undefined becomes a 501, "this
  engine cannot tell you", and this is the one engine that always can.
- `web_fetch` is layered: `createWebFetch` (core) does the SSRF-guarded fetch (DNS-resolved,
  private/link-local denied per redirect hop; cross-host redirects surface a notice instead of
  following; 15-min page cache by URL), and the digest pass runs on the session's own model via
  `AiSdkRunner.generateDigest`, which adds its tokens into `#turnAccum`: any extra model call
  outside that method loses tokens from the turn's accounting. One gap the layering does not close:
  the guard resolves the hostname itself and then hands the URL to `fetch`, which resolves it
  again, a DNS-rebinding TOCTOU this tier accepts rather than closes; an operator who needs the
  check bound to the connection supplies `fetchImpl` with a pinned agent.
- `deliver_file` exists only when `onFileDelivered` is wired; `createEngineSession` grants it by
  default (`capabilities.deliverFiles: false` withholds it). Delivered files are downloadable only
  while the session lives: in-memory VFS.
- **`sandboxedProviderProfile()` adds no mechanism: the empty arrays are the whole thing**
  (confirmed in `packages/server/src/lib/sandboxed-profile.ts`). `capabilities: []` and
  `mcpServers: []` already mean what they mean, and `createToolContext` already withholds a tool
  whose backend the host did not inject; forgetting the empty array is a profile that looks
  sandboxed and still grants `deliver_file`. A session under it can run untrusted JS in the WASM
  guest under the interpreter's own timeout/memory limits and read+write the session's in-memory
  VFS; it cannot touch a host path, spawn a process, reach the network, deliver a file, or use MCP.
  It authorizes nobody (that's `scope` + `authorizeSession`), and it does not make the model's
  input trustworthy: a sandbox bounds what a tool can reach, not what a prompt can talk the model
  into asking for.

## Session scope (embedded deployments)

- **Scope is not `meta`.** `meta` is free-form, client-settable and echoed; an enforcement rule
  whose input the caller supplies is not an enforcement rule. `scope` is validated at the door,
  merged with the principal's (a scoped caller may add narrower tags, never contradict its own:
  403), and written by no route afterwards. `UpdateSessionRequest` must stay scope-free.
- **A runner that forgets to echo `config.scope` is invisible to every check and therefore visible
  to everyone.** `buildRunner` (the one chokepoint for create, dormant rebuild and parked rebuild)
  asserts the runner's `info().scope` equals the config's, and the server re-stamps the scope onto
  whatever the host's `buildRunnerConfig` hook returned.
- **The WS attach checks scope before `parking.ensureLive`.** Waking rebuilds the runner and
  reconnects its MCP servers; doing that for a caller about to get a 404 spends the session's
  resources on someone with no claim to it. Checked again after the wake, since that socket can
  drive the session.
- **The default rule's asymmetry is intended**: a session may carry keys the principal says
  nothing about, but a session missing a key the principal pins is not that caller's. A session
  with no scope is invisible to a scoped principal (the right fail direction, so sessions predating
  the feature never leak into an end user's list). `scope: {}` on a principal pins nothing, so it's
  unrestricted like an absent one; never read `{}` as "sees nothing".
- **Scope is on the wire, and that is a decision.** `SessionInfo.scope` is what makes parked and
  dormant records carry it for free, what lets `parking.listInfo()` be filtered without a sidecar
  map, and what lets a notification observer route per user. The cost: any principal the policy
  admits sees the tags, so an embedder should use opaque ids, not names it wouldn't show that
  audience.
- **Jobs are the queue's copy of the same tags** (`JobInfo.scope`, stamped at `submit`). Without
  them the queue is a side door into an unscoped session. Once a run has started the live session's
  info is the subject; before and after, `canSeeJob` hands the predicate a stub built from the job
  (id, scope, profile, cwd) rather than falling back to the default rule, which would be wrong in
  the dangerous direction: a policy narrower than tag-match could list and cancel a peer's queued
  job. Wherever the predicate exists, it is the only rule.
- **Declaring `authorizeSession` withdraws the unscoped-means-operator default.** Operator-only
  surfaces key on `isOperator`, which is `scope === undefined && no policy`, so a host that writes
  a policy over its own principal shape and never sets `scope` would otherwise read as "everyone is
  the operator" and serve `/fs/*` and the queue firehose to end users. With a policy declared,
  operator principals must say so: `operator: true` (`operator: false` forces the other way). A
  scoped principal can still read `GET /profiles`, gated by `allowedProfiles`, a separate opt-in.
  The per-profile config snapshot is withheld from a non-operator.
- **A policy that throws has not said yes.** `canSee` catches and returns false rather than 500ing
  the route: one surprising row must not turn a hundred-row list into a page-wide error.
- **The queue firehose has no per-socket filter.** `/queue/ws` fans every job's events (prompts,
  progress previews, result text) to every socket, so a scoped principal is refused it outright
  rather than handed other scopes' runs. Same for `/queue`, `/sdk-sessions` (the operator's on-disk
  engine store) and `/fs/*`.
- **An idle provider session still does not survive a gateway restart.** Dormancy needs
  `capabilities.resume`, which provider sets `false`, and `park()` refuses unless the loop is
  resting on deferred calls. For an embedded deployment on k8s, conversation lifetime is pod
  lifetime unless the embedder rebuilds the thread itself. Park-at-rest for the provider engine is
  not built.

## Parking & bridged execution

- **`AiSdkRunner.clearContext()` refuses while tool calls are outstanding.** A parked call's result
  is owed by a client that may answer days later, and the messages it would splice into are exactly
  what a clear drops. `interrupt()` fails the parked calls and finishes the turn; only then can the
  clear run.

- **A `RunnerSnapshot` must round-trip `JSON.stringify` unchanged, `state` included.** The engine's
  continuation state is typed `unknown` on purpose (`packages/server` never resolves a model SDK,
  so nothing type-checks it). A `Date`, `Map` or typed array inside it rehydrates as something
  else; the bug only shows up under a durable `SessionStore`, after a restart, as a session that
  comes back subtly wrong.

- **`parking.touch()` writes both record kinds.** It calls `#rememberDormant` and `#persistLive`;
  each no-ops for the engine it does not apply to (no `resume` capability, or no `snapshot()`).
  Dropping either half loses one engine's write-through: with only the dormant half, a renamed
  provider session lists correctly until the next restart, then comes back under its old title.

- **A session outlives its runner two ways, and they are not interchangeable.** Parking preserves
  mid-task state as a `RunnerSnapshot`; `Runner.park()` is optional because only `AiSdkRunner`
  implements it (claude and codex run behind a binary that owns its own process state). Those two
  get dormancy instead: a `DormantSessionRecord` (id, `sdkSessionId`, config, plus `info`/`profile`/
  `savedAt`, but no transcript). Rehydration is an ordinary create with `resume` set; the transcript
  comes back from the engine's own store as `replay: true` events. Do not try to unify the two
  paths, and do not read "park everything on SIGTERM" as a plan: for claude and codex, `park()`
  returns nothing.
  - **Records are written continuously, never on shutdown.** A shutdown hook is exactly what
    `kill -9`, an OOM or a pulled cable skip. `system_init` is the earliest a resume is possible;
    every non-park status change refreshes the record after that.
  - **`listInfo` skips a record whose id the registry holds**, or a live session's dormant record
    (which always exists) would make the merged `GET /sessions` list it twice.
  - **The `session_closed` discard is skipped while the manager is `#closed`.** `registry.remove`
    (DELETE) and `registry.closeAll` (shutdown) both close runners with reason `'server'`, so the
    only thing separating "this session is over" from "this process is over" is that
    `parking.close()` sets its guard first. Drop it and a graceful restart discards the records it
    was meant to preserve.
  - **`close()` must close the session sockets, not just the queue ones.** `wss` is a `noServer`
    instance: `wss.close()` neither closes nor terminates its clients, and `server.
    closeAllConnections()` does not reach upgraded sockets. The close path sends a close frame to
    every `wss.clients` entry, force-terminates stragglers after `SOCKET_CLOSE_GRACE_MS` (250ms),
    and awaits both `wss.close()` and `server.close()` (`Promise.all`) before resolving, bounded by
    `CLOSE_DEADLINE_MS` (1s) regardless of runtime drain-order differences between Bun and Node.
    `close()` is idempotent by contract (`closing ??=`, returns the first promise); the CLI's
    second-signal path does not rely on a second `close()` being re-entrant.
  - **The drain never waits on `awaiting_approval`.** `server.drain()` lets running turns reach idle
    before `close()`, but a session blocked on a human will not resolve on its own; it is named in
    the report and left behind. It sorts sessions with protocol's `sessionState`, the same
    vocabulary as the session list and `workerdeck guard`, deliberately not a second spelling of the
    busy set. Draining is a courtesy, never a correctness requirement: records are written
    continuously, so a hard stop already loses nothing.
  - **Waking one re-runs `buildRunnerConfig`.** `env` is on `EPHEMERAL_CONFIG_KEYS` and never
    reaches disk, so a claude profile's `CLAUDE_CONFIG_DIR` pin must be re-derived from the profile,
    not read back from the stored config.
  - A park's record is consumed on wake; a dormant one (and a live one) is refreshed in place,
    because the session will need it again next time the process dies. Consuming a live record
    opens a window from attach to next turn where the session exists nowhere durable: a user who
    opens a session, reads it and types nothing loses it to a redeploy, silently.
- **The provider engine's restart story is `snapshot()`, not dormancy, and it is off by default.**
  Dormancy remembers an engine session id to resume from; a provider session has no engine store
  behind it, so its record carries the state itself. `Runner.snapshot()` shares `park()`'s builder
  but skips `park()`'s teardown: it refuses a turn in flight and pending in-process executions
  (whose results die with the process), and allows the idle case `park()` exists to refuse.
  `parking.persistLive` writes it through on `turn_result`, `model_changed` and
  `permission_mode_changed`; the record is `kind: 'live'`, rebuilt lazily on first attach like a
  dormant one.
  - **The write must not be synchronous in the `turn_result` listener.** The event fires from
    inside the turn, before the `finally` that clears the abort controller, so a `snapshot()` called
    straight from the listener sees a turn in flight and refuses every time, silently. `#queue`'s
    microtask hop is what puts the write after; removing that hop for "simplicity" produces a
    write-through that never writes.
  - **The persisted log drops stream deltas** (`snapshotRetains` in protocol: `body.type !==
    'stream_delta'`). Safe because a delta is superseded by the `assistant_message` that flushes it
    (including on the interrupt path) and because `transcriptActivity(stream_delta)` is 0, so a
    restore's recomputed `activityCount` is bit-identical. This rule is provider-only: a Claude
    log's thinking blocks arrive empty and are backfilled from the delta stream, so applying the
    same rule there would erase every thought.
- **A restored session must not schedule a turn.** `AiSdkRunner.start()`'s restore branch schedules
  nothing. An interrupted turn leaves the message history ending on the user (the catch path
  flushes a partial `assistant_message` for the transcript but never pushes the model's response
  messages), so `#runTurn`'s "already answered" guard would pass and the woken session would re-run
  the killed turn, unprompted, on first attach. `park-restore.test.ts` pins it.
  - **The wake must clear `prompt`, and carry the title as it does.** `prompt` is the session's
    opening prompt and persists in the record; `SessionRunner.start()`/`CodexRunner` send it
    unconditionally, so a session created with one used to re-run it as a fresh turn on top of the
    replayed thread. `AiSdkRunner.start` guards its own rehydration (`if (this.#config.restore)`);
    claude and codex rehydrate by `resume`, which unlike `restore` is a public request field
    (`createSession({ resume, prompt })` legitimately means "continue, and here is the next thing").
    So the suppression lives at the wake site in `rebuild:`, never in a runner. `sessionTitle()`
    derives from `prompt` when `meta.title` is unset, so the wake must also freeze
    `record.info.title` into `meta`, or the session comes back nameless.
  - **A rename must re-save the record, and the record must carry the runner's live `meta`.**
    `setTitle()` writes the runner's `#config`, which `SessionParkManager.#configs` never sees, and
    the wake rebuilds from `record.config` while discarding `record.info`, so a rename used to
    survive the listing and die on wake. `#rememberDormant` persists `{ ...config, meta: info.meta
    }`, and `PATCH /sessions/:id` calls `parking.touch()` because a rename emits no event and
    nothing else would trigger a save. A parked session 409s the PATCH: it has no runner to carry
    the change.
- Parking is a persistence boundary, not an ending: `park()` emits `status_changed: 'parked'` and
  never `session_closed`, the snapshot happens after that emit and keeps the seq counter (a
  rehydrated runner continuing at a reused seq is silently dropped by the reducer's and client's
  `seq <= lastSeq` dedupe), and it refuses while a leg is in flight or any pending call is
  non-deferred. The runner announces the park only once every call of a batch has been dispatched;
  parking on the first `execution_dispatched` would strand the batch's remaining calls, which
  dispatch into a discarded runner.
- The engine's `state` inside a snapshot is opaque on purpose (typing it would drag `ai`'s
  `ModelMessage` into `packages/server`). `registry.evict()` (not `remove()`) drops a parked runner
  without closing it. A rebuild that ignores `EngineRunnerContext.restore` produces a fresh id and
  is refused with a loud error rather than silently forgetting the task.
- A durable `SessionStore` persists the record's config, and `toDurableRecord` drops four fields:
  `queryFn`, `historyFn`, `extraOptions`, `env`. Two are functions JSON would eat silently; `env` is
  credentials, and no store may ever hold it. Nothing is lost, because all four belong to the
  Claude engine, which cannot park; a rebuilt provider session resolves credentials through
  `createEngineRunner` from the live environment on every build. A host must resolve live values in
  the factory, not smuggle them into `config` for its factory to read back.
- Store operations are serialized per session (`SessionParkManager#queue`); that ordering is
  load-bearing once writes are real I/O. `#park` must evict before the save completes, or an attach
  in between binds a client to an inert runner, leaving a window where the session is in neither the
  registry nor the store: a delivery reading past it 404s the caller and files the execution as
  settled with nothing alive to wake it; a `discard` reading past it deletes nothing and lets the
  save resurrect a closed session. Read paths (`get`, `listInfo`) queue behind the write for the
  same reason.
- Re-arming a watchdog at `hydrate()` uses `max(expiresAt, now + expiredGraceMs)` (default 60s), so
  a deadline that lapsed during a restart does not fire at t=0 before a retrying delivery can land.
  A file store is single-process (two servers over one directory both hydrate and rebuild), its
  `list()` reads every transcript into memory, and its directory is plaintext transcripts (written
  0600 under a 0700 dir). Two things a restart does not carry over: `#settled` is in-memory, so a
  duplicate delivery after a restart 404s rather than returning `applied: false`; and a parked job's
  queue-side record belongs to the `QueueAdapter`, so a durable `SessionStore` under the bundled
  in-memory adapter wakes a session no job is waiting on.
- **The dormant write is asynchronous, and the two engines do not get one at the same moment.**
  `#rememberDormant` runs on `system_init` and every non-park `status_changed`, so a claude session
  has a record from its first moments. Codex emits no `system_init` at all, so its first record
  rides the post-turn `status_changed`; kill the gateway inside that window and the row is gone, not
  merely un-resumable. Verified with `pnpm smoke:restart codex`, which waits for the record on disk
  rather than racing it.
- **A swept engine store fails quietly.** Delete the CLI's own transcript behind a dormant record
  and the attach still succeeds: the row lists, the socket opens, the transcript comes back empty
  (a dormant record backfills from the engine, which now has nothing), and the next turn is simply
  never answered. The record staying is deliberate (the failure may be transient), but nothing
  reports "this session's engine state is gone", so it reads as a hang. Reproduce with
  `pnpm smoke:restart claude swept`.
- **Never put `ANTHROPIC_API_KEY` in a gateway's environment when the profile is meant to run on a
  subscription.** The CLI takes the key, `plan_info` and `rate_limit` stop arriving, and turns
  silently never complete, indistinguishable from a hang. `smoke/restart.ts` deliberately does not
  pass `--env-file-if-exists=.env`, unlike its neighbours.
- Bridged tool calls: the server asks the first attached client and fails dispatch fast when none
  is attached (autonomous jobs never bridge). Results are idempotent by `executionId`: a late
  answer racing a timeout must not error the client or re-open a settled call. The server feeds
  every bridged result into the session runner's optional `settleExecution` before the host's
  `bridge.onResult` observer; operators do not wire that loop themselves. A runner whose id is not
  known yet at assembly time reaches its bridge executor via a dispatch-time delegate on
  `call.sessionId` (see `smoke/sdk-client.ts`). The browser guest engine loads on first bridged
  call, never at import (it is ~2 MB); keep it an optional peer dep.
- **A `conversation_reset` must re-write the record, and nothing else will.** No `status_changed`
  follows a clear, and `#persistLive` is otherwise driven by `turn_result`, so the reset arm calls
  both `#rememberDormant` and `#persistLive`. The dormant record names the just-cleared conversation
  (re-saved under a freshly adopted engine session id, or deleted if the engine has none yet); the
  live record carries the transcript, so skipping the second call leaves the pre-clear messages
  on disk until the next turn ends. Either omission means a restart in that window wakes the session
  straight back into the transcript the user threw away.

## Hot reload (`--hot-reload`)

Dev only, and only from a checkout. It re-evaluates every module under `packages/` in place and
hands the live runners to the new code, so an engine child process, its subagents and its shell
grandchildren survive an edit. `docs/DEVELOPMENT.md` has the shape; these are the ways to get the
handover wrong.

- **`parking.close()` does not make a manager inert, and `#closed` was never meant to.** The guard
  covers the four write-throughs and the `session_closed` discard, not `#track`: a deferred
  `execution_dispatched` reaching a closed manager still arms a watchdog, and when it fires,
  `submitResult -> ensureLive -> #rebuild` builds a second runner for that id through the registry
  and factory of a generation that is over. That is why `watch()` retains its unsubscribe in
  `#watches`, and why `release()` exists.
- **Carry with `releaseSession`/`adoptSession`, never with `evict`/`register`.**
  `registry.register(runner)` re-attaches everything `onRegister` wires and nothing `createRunner`
  wires: `parking.remember`, `parking.watch` and `watchAuthSource` all live outside that hook. A
  session registered the bare way stops being written through (no record on a rename or a
  `conversation_reset`) and a client `close` never discards its record, so it comes back dormant on
  the next start. It tests green because the pre-reload record is still on disk;
  `hot-reload-seam.test.ts` pins it by counting notifications and deletions across two servers.
- **Adopt before `listen()`, not after.** Between the port opening and the adoption, an attach for a
  carried id reads its dormant record and resumes a second engine child on the same transcript.
  Hiding the record for the duration only masks it, not from `hydrate`, `delete`, or a `DELETE`
  route; registering first removes the window, and `listInfo`'s registry filter then hides the
  record for free. The corollary is the failure path: a `listen()` that throws has already attached
  the new generation's watchers, so `startInstance` releases every carried session before it closes
  the half-built server. Release first, or `registry.closeAll()` kills the children the whole
  feature exists to keep.
- **Flush the old manager before `close()`, and let it close before the new one adopts.** `touch()`
  is fire-and-forget by design (the PATCH route has nobody to report to) and the queued write
  re-checks `#closed`, so a snapshot forced at the seam without `flush()` is silently skipped. Two
  managers in one process also share the file store's `${path}.${pid}.tmp`, so their writes to one
  id must never overlap: the sequence is the whole protection.
- **A provider session is never carried; a reload is a restart for it.** Its executors close over
  the generation's `BridgeHub`, so a carried one fails every later bridged call with `no_client`
  while a client is attached, not merely the call in flight, and the manager's execution bookkeeping
  cannot be rebuilt from the runner. It goes through `snapshot()` and `persistLive` like any
  restart, which is why `--hot-reload` forces `persistLive: true` and interrupts a turn in flight
  before the write. `reloadPlan` keys that on the presence of `snapshot`, never on the engine name:
  "can this session persist itself" is the actual question.
- **`parking.adopt` registers first, watches from `lastSeq`, and touches once.** `#rememberDormant`
  has an ownership guard, so a `touch()` for a runner the new registry does not hold yet writes
  nothing. Watching from 0 instead of `lastSeq` queues one dormant re-save per historical
  `status_changed`, which on a long session is hundreds of file writes per reload.
- **A carried session runs the code it was born with.** Keeping the child alive means keeping the
  `SessionRunner`/`CodexRunner` object, the old generation's `packages/core`. An engine or protocol
  edit reaches new sessions only; do not debug "my change had no effect" on a carried one.
- **`registry.evict()` detaches as well as forgets**, and `onRegister`/`observe` may hand back a
  cleanup to make that possible. The hook is typed `unknown` rather than `void | (() => void)`
  because TypeScript forgives a stray return only against a bare `void`, and the narrower union
  would break every embedder whose hook is a one-expression arrow. Safe for `#park`, which clears
  the runner's subscribers first, so the cleanups are no-ops there.

## Peer messaging (`peers_list` / `peers_peek` / `peers_send`)

Session-to-session messaging on one gateway: every engine gets the three tools, backed by one
`PeerDirectory` the server installs (`services/peers.ts`). `docs/ARCHITECTURE.md` §Peer messaging
has the shape; these are the ways to get it wrong.

- **The transcript carries the bare text and `origin`; only the model input carries the
  envelope.** `sendMessage(text, attachments, { origin })` emits `user_message` with `origin:
  { kind: 'peer', sessionId, name, engine, hops }` and the text as sent, and feeds the model
  `peerMessageEnvelope(text, origin)`: a `<peer-message from-session=...>` block plus the framing
  that says it is not the user and cannot approve anything. A client never strips anything, and
  the badge rule is untouched: `transcriptProse` still scores a `user_message` zero.
- **A peer-origin `/clear` is text, never a command.** `CodexRunner.sendMessage` runs `/clear`
  through `clearContext` only when there is no origin; the claude engine gets the envelope, which
  the CLI does not match as a slash command. A peer must not be able to wipe another session.
- **Codex declares the tools as `dynamicTools` on `thread/start` and `thread/resume`; the call
  arrives as the server request `item/tool/call`.** Both need `experimentalApi`, which
  `INITIALIZE_PARAMS` already sends. Measured against 0.153.4: `thread/start` with `dynamicTools`
  is accepted and unknown fields are ignored, not refused, so a binary that drops the field
  silently drops the tools. **Whether `thread/resume` honours it is unverified** (a resume needs a
  rollout, which needs a turn, which costs tokens); `pnpm smoke:codex` is the check. There is no
  stdio MCP server and no `config.toml` write: `thread/start` also accepts a per-thread
  `config: { mcp_servers }` override (measured), kept in reserve, and never used for this because a
  child process with the gateway's address in argv is exactly what `mcpStatusInfo` forwards.
- **`dynamicToolCall` is a mapped item now.** `item/started` draws the call under the tool's own
  name (`peers_send`, not `mcp__...`), `item/completed` settles it from `contentItems`. The
  canary's MAPPED set moved it; `functionCallOutput` stays unmapped for the reason recorded there.
- **The runner holds a handle, not the directory.** `config.peers` is `peerDirectoryHandle()`,
  which resolves `installPeerDirectory`'s process-wide slot (`Symbol.for`) on every call. That is
  the hot-reload rule: a carried runner keeps the config it was born with, and a captured
  directory would keep answering from the generation whose registry was emptied by the handover.
  `peers` is in `EPHEMERAL_CONFIG_KEYS`; a function-bearing config must never reach a record.
- **Visibility is the sender's scope, not a client's.** `scopeMatches(from.scope, to.scope)`: a
  scoped session sees what a client carrying its scope would, an unscoped session sees everything.
  `authorizeSession` is *not* consulted, because it takes a principal and a session is not one;
  an embedder whose policy is richer than the tags must turn `peers` off (`peers: { enabled:
  false }`) or scope every session. A miss is "no such session", never a different word.
- **`peek` never wakes and never drives.** It reads a live runner's log through
  `subscribe(..., 0, { truncateResults, imageRefs })` and detaches at once, and a dormant session
  answers `live: false` with its stored `info`. `send` is the only path through
  `parking.ensureLive`, and it goes through `Runner.sendMessage`, so every engine's mid-turn rule
  applies unchanged: claude buffers in `InputQueue`, codex `turn/steer`s, provider chains a turn.
- **A peer's name travels twice, and a transcript resolves it from either.** `peers_send` answers
  the model in prose, so the recipient's name only reaches a client inside
  `peerDeliveredPrefix(sessionId, name)`, read back by `peerDeliveredTo`. That receipt names the
  target; an arriving `user_message`'s `origin` names the sender. `peerNamesOf(items)` collects
  both, and `peerSendTarget(item, names)` prefers the receipt, then what the rest of the transcript
  knows, then the short id - so a send whose receipt predates the naming (or whose target had no
  title yet) draws as a name the moment that peer speaks. A name never comes from a live sessions
  list: the transcript has to read the same on replay as it did live.
- **The loop guard is a hop chain reset by a human.** Each delivery carries `hops` (every session
  the exchange has passed through); the service remembers the last chain each session *received*
  and extends it when that session sends. A `user_message` with no `origin` clears it. Past
  `maxHops` (12) a send is refused with a reason that tells the model to ask its user. Beside it:
  `perMinute` (10) per sender-target pair, `maxMessageChars` (16k) with "write a file, send the
  path" as the refusal.

## Server, profiles & auth

- **`writeFile`'s `mode` option applies only when the file is created**, so a 0600 write over an
  existing file silently keeps whatever bits that file already had. Every secret-adjacent write in
  `packages/cli` follows `writeFile` with an explicit `chmod`: `auth-key.ts` (regenerating over a
  file it has just judged corrupt, precisely where the old mode is not ours), `auth-sessions.ts`
  (temp path `${path}.${pid}.tmp`, reusable by a later run of the same pid), and `apns/devices.ts`
  (rewritten on every device registration). The `chmod` reads redundant beside `mode` and is not.
- **Runtime profile CRUD is gated on three separate things, and all three matter.** `profileStore`
  must be supplied (absent, 404 "profile management is not enabled"), the principal must carry
  `canManageProfiles` (the CLI grants it to operator principals only), and `allowedConfigDirRoots`
  must contain the credential directory being asked for. Removing any one turns the other two into
  decoration; an empty root list refuses every managed Claude or Codex profile rather than allowing
  any, the safe direction but a confusing 403 on an ordinary request. The guard reads the field the
  engine uses (`configDir` for claude, `codexHome` for codex): it used to read `configDir`
  unconditionally, so every codex profile created over the API was refused for naming no
  `configDir` (fixed in `1e08f90`). A codex profile with no `codexHome` names no store of its own
  and is exempt, running on the server's own environment.
- **The API never accepts a credential, only a directory to resolve one from.** `configDir`/
  `codexHome` name a store the official SDK/CLI reads for itself; a field that carried a key would
  be a credential route on this surface, which the policy forbids. The guard is the root list, not
  a sanitizer.
- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- **A browser cannot authenticate a WebSocket attach with a header**: the `WebSocket` constructor
  takes `(url, subprotocols)` and nothing else, and the one `authenticate` hook guards REST and the
  upgrade. A dashboard has exactly three options: a cookie (sent automatically on a same-origin
  upgrade), a query-string credential (`ClientOptions.buildWsUrl`), or a server-side proxy that
  stamps the credential on the tab's behalf. Baking a key into the served JS is not one of them.
  `packages/cli` takes the cookie route for the dashboard it serves itself, the reason it serves the
  app and `/v1` from one origin via `fallback`. Anything reached through `fallback` is outside
  `basePath` and gets no `authenticate` call: that namespace is the host's to guard.
- **Two deployment shapes, two auth models. Do not mix them up.**
  - **Tenant infra**: the operator's own clients (iOS, the VS Code extension, a dashboard on
    another machine) talking to the operator's own gateway, reusing the one global gateway key.
    Node clients send it as a header on both transports. A browser client cannot, so `createCliAuth`
    also accepts it as `?key=` on WebSocket upgrades only (`querySecret`), and `hostAuth()` in
    `packages/client` is the one place that builds those URLs. Confined to upgrades on purpose: a
    key in a query string is a permanent, replayable credential that lands in reverse-proxy access
    logs, so a leaked URL buys a single attach, never a REST call: `?key=` on REST stays
    unauthenticated.
  - **Embedded infra**: WorkerDeck inside a host product, serving that product's end users. The
    global key is wrong here (every user would hold the operator's secret), so these supply their
    own `authenticate`. A config file with `authenticate` sets `hostAuthenticates`, `createCliAuth`
    is then built with `secret: undefined`, and `instance.ts` routes the server's hook to the host's
    function, so the built-in scheme, cookie and `?key=` alike, is not consulted at all.
    `packages/server` itself never reads `?key=`; grep it before believing otherwise.
- Cookie auth means ambient authority, so CSRF is live: WebSocket upgrades are exempt from CORS,
  which makes an explicit `Origin` check (not `SameSite` alone) the actual defense on an attach.
- **The login-session table is keyed by `HMAC-SHA256(secret, token)`, and that keying does three
  jobs at once**: do not simplify it back to a plain digest of the token. The table is mirrored to
  `<stateDir>/auth-sessions.json` (`createAuthSessionStore`) so a restart does not sign every
  browser out while the cookie's 7-day ttl says it is still good; but what goes on disk must be
  worth nothing to whoever reads it, and rotating `--auth-key` must still invalidate every
  outstanding cookie. Keying by the secret gives all of it: the file holds neither the cookie value
  nor the secret (inverting either needs a preimage of a 256-bit input), and rows written under an
  old secret simply stop matching any lookup and age out on their own expiry, no revocation list, no
  fingerprint field. Logout still deletes a row, why this stayed a server-side table rather than a
  stateless signed token. The store is fire-and-forget by contract (the auth paths are synchronous):
  a store that cannot write degrades to "logins do not survive a restart", never refuses a login.
- The CLI's generated auth key is two halves of one promise. `resolveInstanceConfig` is pure (no
  I/O), so when auth is required off loopback with no key it only records `generateAuthKey`, and
  already stands the Host-header guard down (`allowedHosts: null`) on the strength of it.
  `startInstance` materializes the key (`<stateDir>/auth-key`, 0600, regenerated if corrupt,
  ephemeral when `stateDir` is null) and refuses to serve if `allowedHosts === null` while the
  built-in auth came up disabled. Keep that assert: it turns "auth believed on, secret undefined" (a
  silently open gateway wearing an authenticated banner) into a failed start. `insecureHosts`
  entries match the bind host literally (`0.0.0.0` waives auth only for the all-interfaces bind,
  never "any host") and fold into `allowedHosts`, which still fences an unauthenticated instance to
  loopback plus declared names against DNS rebinding.
- Profiles pin `CLAUDE_CONFIG_DIR` after the `buildRunnerConfig` hook (profile wins over hook-set
  env); profile `defaults` fill unset request fields only. An `ANTHROPIC_API_KEY` in the server env
  still outranks every profile's config-dir credentials (SDK chain): surface it, don't fight it. The
  oauth notice is per-profile.
- **Setting `CLAUDE_CONFIG_DIR` at all changes the CLI's credential source**, not just its config
  dir: set, credentials come from `<dir>/.credentials.json`; unset, the CLI's own resolution runs,
  which on macOS is the login Keychain, where `claude login` puts a claude.ai login. Pinning even
  the CLI's default `~/.claude` turns a working Mac login into "Not logged in, please run /login"
  (`apiKeySource` is `'none'` both ways, so it cannot discriminate). `claudeSessionEnv`
  (`server/src/lib/profile-env.ts`) skips the pin when the baseline env already lands the CLI in the
  profile's dir: load-bearing for the auto-detected `default` profile on a Mac, and its converse
  holds too, a baseline carrying a different `CLAUDE_CONFIG_DIR` is still overridden by the profile,
  or two profiles collapse into one identity. A profile whose dir is not the default needs its own
  credentials: run `CLAUDE_CONFIG_DIR=<dir> claude auth login`, or inject a long-lived
  `CLAUDE_CODE_OAUTH_TOKEN` via `buildRunnerConfig` (the launchd pattern in
  `examples/workerdeck.config.mjs`). The `checkCredentials` preflight probes each profile's exact
  session env with `claude auth status` at `listen()` and warns on a logged-out verdict: warn-only,
  silent on "couldn't check", off by default in the library, on in the CLI, and reads nothing but
  the `loggedIn` boolean.
- Profile management is doubly opt-in (`profileStore` AND `canManageProfiles`), and the two profile
  sets never mix: `profiles` from server options are code (immutable over HTTP, and win a name
  collision), while the store holds UI-created ones. `validateProfile` is shared by startup and the
  routes, so a POSTed profile can never be one startup would have refused, and `managed` is
  recomputed on every response, never persisted or trusted from a client. A managed Claude or Codex
  profile needs `allowedConfigDirRoots`: naming a credential directory is choosing a credential
  store, so unset means the routes create provider profiles only. Profiles cannot be renamed:
  sessions and jobs are pinned to the name. A store redirects auto-detection rather than suppressing
  it: with a store wired, detected profiles are seeded into it on the first launch that finds it
  empty, arriving `managed` and editable instead of declared and immutable, and detection never
  writes again once the store holds anything. Without a store they stay declared. Opting out
  entirely is still `profiles: []`.
- Provider-session grants live on `ProfileInfo.session` (`capabilities`, `mcpServers`,
  `instructions`) and narrow, never widen, via `CreateSessionRequest.capabilities`; the gateway 400s
  a widening request rather than silently downgrading it. The enforcement is the gateway's alone:
  `createEngineSession` takes `config.capabilities ?? profile.session.capabilities` and lets the
  request value win outright, because by then the widening check has already run. A host calling
  `createEngineSession` directly with capabilities taken from a client owes that check itself. MCP
  is named, never configured, there: a transport config's headers can carry credentials and
  `ProfileInfo` is served by `GET /profiles`, so the names refer to servers the host connected in
  `createEngineRunner`, and `selectMcpTools` filters by the `<server>__<tool>` namespace. A provider
  session request carrying its own `mcpServers` is refused for the same reason (MCP tools are
  authoritative: a client that could name one could point an authoritative tool anywhere); Claude
  sessions still bring their own, since the CLI spawns them under the operator's own config dir.
- **Session notifications subscribe through `SessionRegistry.onRegister`, and three details of that
  seam are load-bearing.** (1) `register()` fires the hook per runner object, not per call:
  `prepare()` lists a runner and its caller registers what it returned, so a per-call hook fires
  twice for every Claude session and every notification is delivered twice. (2) The subscription
  starts at `runner.info().lastSeq`, because `Runner.subscribe(fn, afterSeq = 0)` replays the log;
  at 0, a session rebuilt from a park re-announces every permission request it ever made. (3) The
  `SessionInfo` snapshot is taken a microtask after the event, since listeners run inside `#emit`,
  before the runner has applied what the event means: read synchronously, a `session_closed`
  notification would report `status: 'starting'`. Seq and ts still come from the event, so identity
  and ordering are untouched, and the payload is read at send time, not delivery time, so it
  describes the session as the event left it, not as it is after three webhook retries. Session
  webhooks are server-wide, not per session: the whole point is to hear about sessions you did not
  create and are not attached to. The notifier's webhook delivery is a deliberate near-copy of the
  queue's job-webhook delivery rather than a shared helper, because coupling them would let a change
  to job deliveries silently change session ones.
- **Two CSRF details in `createCliAuth` sit beside the `Origin` rule above.** (a) The origin verdict
  is tri-state (`absent`/`ok`/`foreign`) because absence means different things per call site: every
  current browser sends `Origin` on cross-site POSTs and on every WS handshake, so absent means a
  non-browser client carrying no ambient cookie. Login and logout allow absent-Origin (curl-style
  provisioning) while unsafe methods and upgrades on a cookie-authenticated request require it
  present. (b) The cookie is `SameSite=Lax`, not Strict, on purpose: Strict drops the cookie on a
  top-level navigation from an external link, landing a logged-in operator on the login page, and
  buys nothing the explicit Origin check does not already cover; the real surfaces are
  same-site-different-port and the WS handshake, both of which need that check regardless of
  `SameSite`.
- **`cors: { origins }` is sharing policy, not a credential.** Preflights are answered before
  `authenticate` (browsers strip credentials from them, so they would otherwise 401), but every real
  request still goes through the hook: an allowlisted page that does not hold the key gets nothing.
  Two implementation rules: exact origins only, no wildcards or suffix matching, and
  `Access-Control-Allow-Credentials` is never sent, which keeps an ambient cookie from becoming
  cross-origin authority. WebSocket upgrades are exempt from CORS entirely and unaffected; their
  credential is whatever `authenticate` accepts on the handshake.
- **A `ProfileStore` holds no credentials, by construction.** `ProviderConfig.apiKeyEnv` is a
  variable name, and a Claude profile's `configDir` is a path; both are resolved against the
  server's own environment at session time. That is what makes a stored profile safe to write to
  disk and safe to serve from `GET /profiles`, the same rule `toDurableRecord` follows when it drops
  `env` from a persisted session config.

## Host filesystem (`/v1/fs/*`)

- **`cwdAllowed` is not the containment check for these routes.** It resolves `..` and compares
  prefixes, sound for vetting an operator-typed cwd. The `/fs` routes walk paths the *agent* may
  have authored, so a symlink planted inside an allowed root defeats a lexical check.
  `host-files.ts` decides containment only on `realpath` output, and canonicalizes the roots
  themselves at startup (a root that is itself a symlink, `/tmp` -> `/private/tmp` on macOS,
  otherwise contains nothing). Requests go to `realpath` whole, never lexically collapsed first.
- **Every filesystem refusal is an identical `404 'not found'`**: outside the roots, escaped via
  symlink, dangling link, and genuinely absent are byte-identical, else the API becomes an
  existence oracle for paths outside the roots. `403` is reserved for verdicts that leak nothing
  beyond the roots: malformed requests and in-root targets of the wrong kind.
- **Resolve and open are two halves of one discipline.** Callers open exactly `ResolveOutcome.path`
  through `readContained`/`writeContained`: `O_NOFOLLOW` turns a final-component swap into `ELOOP`,
  `O_NONBLOCK` stops a swapped-in fifo from parking the request forever, the `fstat` gate refuses
  non-regular files before a byte moves, and truncation happens only after that gate. A parent
  directory swapped inside the window can still redirect the open; that needs `openat2
  (RESOLVE_BENEATH)`, which Node does not expose. Accepted, documented.
- **Reading follows `allowedCwdRoots`; writing does not.** `hostFiles.roots` narrows, it does not
  grant: a caller holding the auth key can already start a session in any allowed root, so serving
  those trees over `/fs` adds no authority. Writing keeps its own switch because it isn't implied:
  an agent's writes go through the permission flow, `PUT /fs/write` does not. With neither
  `hostFiles.roots` nor `allowedCwdRoots` set, the routes 404. An explicit `roots: []` disables
  them rather than falling through to the cwd roots, hence `??` and not `||` at the resolution site.
- **Writes are conditional, always.** `expectedHash` (sha256 of what was read) or nothing, and
  nothing means "create": a path that already exists then 409s. No unconditional overwrite; a
  client that lost track of its base can only re-read, never force. The response's own hash chains
  into the next write.
- **`/fs/find`'s ranking is part of its contract**: subsequence matching (`seslist` finds
  `SessionListView.swift`), filename hits above path hits, shallow above deep, and an empty `q`
  returns the shallowest files rather than nothing. Build directories are skipped.
- **`/fs/find` walks, so it must not follow.** `host-file-search.ts` skips symlinks as files and as
  directories: as directories that keeps the walk bounded instead of cyclic, as files it guarantees
  every offered path will pass `/fs/read`. It never resolves a path of its own; it is handed an
  already-contained directory.
- These routes are **operator-privileged**: authorized by the auth key alone, outside the agent
  permission flow, which is why writing is its own separate flag.

## Shell mode (`!` in the composer, `shell_command`)

- **It goes through nothing.** A Bash tool call raises a permission card and honours
  `disableBypassPermissions`; a `!` command has none of that, it is a shell on whatever the gateway
  process can reach, in the session's cwd. It is its own switch (`shell: { enabled }`, CLI
  `--shell`), off by default, never inferred from `hostFiles` or `allowedCwdRoots`.
- **Three ANDed conditions, one refusal string.** `shell.enabled`, `auth.isOperator(authCtx)`, and
  the engine's `hostCwd === true`. A scoped principal is never an operator (`services/auth.ts`); the
  provider engine is `hostCwd: false`. All three failures return the same `protocol_error` text, so
  the surface is not an existence oracle. The gate is re-checked on every command; `attached.shell`
  is an offer, not the authorization.
- **Advertised per attachment, not per engine.** `EngineCapabilities` is a static per-engine table
  and cannot express config x operator x cwd. `AttachedFrame.shell?: boolean` is the only place
  that knows all three; omitted rather than sent false, additive, no `PROTOCOL_VERSION` bump needed.
- **`!` does not start a turn.** `runner.sendMessage()` wakes the model, so routing shell output
  through it would earn a reply to every `ls`. The CLI buffers the output and prepends it, wrapped
  in `<local-command-caveat>`, to the next real message. `Runner.queueLocalCommand` emits the
  transcript row now, holds the model-facing text, flushes it as a hidden leading block on the next
  `sendMessage`. The emitted `user_message` event stays the user's own text.
- **The buffer is dropped on every context reset**: `clearContext()`, a `conversation_reset` from
  any engine, and `close()`. Shell output that outlived the conversation it described would read as
  current to the model.
- **A compaction is one row with two halves, and the boundary's own uuid is not that row's id.**
  Both engines announce a compaction before finishing one (claude: `system/status`
  `status: 'compacting'` then `compact_result`; codex: `item/started` for `contextCompaction`). It
  is one `context_compacted` emitted twice under one id: `pending: true` at the start, again
  without it when the boundary lands, so the reducer's `upsert` settles the row in place. On claude
  that id is minted by the runner and held in `#compactionId`, since `compact_boundary`'s own uuid
  names the end, not the row; a boundary with nothing pending (auto-compaction on a fresh attach)
  falls back to that uuid. A **second** `turn_result` settles a still-pending compaction (must be
  the second: a manual `/compact` ends its own turn immediately while the summary keeps running).
  `replayCoalesceKey` keys on `context_compacted:<uuid>` so a replayed pair delivers only the
  settled one. The row's sentence lives in one place per client (`compactionText` in
  `packages/ui/src/lib/format.ts`, `TermFmt.compaction` in the kit, pinned against each other by
  `TerminalTextTests`), since the terminal renderer measures the string it draws. An open
  compaction also holds the session **busy**: `#setStatus` swallows an `idle` while
  `#compactionId` is set and replays it on settle.
- **The claude engine holds the flush across a slash command.** The CLI matches `/compact` and
  friends on message text, and a leading caveat block would break the match or lose the output, so
  `sendMessage` skips the flush for text matching `/^\s*\/[A-Za-z]/` and waits for the next plain
  message. Codex and provider have no slash commands and flush unconditionally.
- **One child per session, killed by process group.** A second `shell_command` while one is running
  is rejected, not queued. The child is `spawn('/bin/sh', ['-c', cmd])` (never `shell: true`),
  `detached: true` so it leads a process group; timeout, `session_closed`, park and server shutdown
  all `SIGKILL` the group, since a bare `child.kill()` leaves grandchildren (`sleep 9999 &`)
  running past the session. Output is a shared head-keep budget across both streams with an
  explicit truncation marker; the cap does not kill the process, the timeout bounds time.
- **The transcript row is a synthetic `user_message` carrying exactly one
  `<local-command-stdout|stderr>` element**, the shape `react`'s reducer turns into a `notice`.
  Marking it synthetic zeroes `transcriptActivity`/`transcriptProse` so a `!ls` never badges a
  session unread. Two reducer rules follow: the local-command check sits ahead of the
  `!event.synthetic` guard (inside it, a synthetic message renders nothing), and a message whose
  first text block starts with `<local-command-caveat>` is split into notices with the user's own
  text still drawn beside it, because on resume the SDK hands the flush and the next message back
  as one message, which `isSyntheticUserText` marks synthetic whole.
- **iOS mirrors all of it**: `SessionCommand.shellCommand`, `AttachedFrame.shell`, and both reducer
  rules in `Transcript.swift`. A fix on one side alone silently diverges the clients.

## Message attachments (`/v1/sessions/:id/attachments`)

- **The bytes never ride the protocol.** A session's event log is an unbounded in-memory array
  replayed to every attaching client and captured verbatim into parking snapshots; base64-inlining
  a photo into `user_message` would be paid for on every attach, forever. An attachment is uploaded
  first, the command names it by id, and what lands in the log is a `MessageAttachment` reference.
  `SessionRunner.sendMessage` builds the content blocks from the bytes and emits the refs. Never
  put `data` on a `SessionEvent`.
- **The attachment store is in-memory, so a restart outlives it.** The `MessageAttachment`
  reference survives in the log, but `GET {basePath}/sessions/:id/attachments/:attachmentId` 404s
  afterwards: a message can outlive the bytes it names.
- **An unknown attachment id fails the whole command**, rather than sending the message without it:
  a message that quietly lost its picture reads as the model ignoring it.
- **Only three shapes reach a model; the fourth is refused at the door.** Images (jpeg/png/gif/webp)
  become image blocks, PDFs become document blocks, anything textual is inlined in a
  `<attachment name=... type=...>` envelope, everything else is a 415 at upload. `pnpm smoke:media`
  verifies the server *builds* the blocks against a fake `queryFn`, never that the real CLI accepts
  them on streamed input.
- **`image/heic` is not on that list, and it is what an iPhone shoots.** Transcoding is the client's
  job (`AttachmentNormalizer` in iOS), which also downscales to 1568px, roughly a vision model's
  own resize target. The browser composer downscales too, to the same longest edge
  (`useAttachments`' `prepare`), re-encoding as JPEG at 0.85. The constant is spelled once per
  client with nothing shared (`MAX_IMAGE_EDGE`, `ComposerAttachments.maxImageEdge`); tune one and
  you've broken a pair. GIFs are exempt (a redraw keeps one frame of an animation); anything the
  browser cannot decode is uploaded as-is so the gateway answers with its own 415.
- **The store is memory, for the session's lifetime, exactly like `/files`.** An attachment 404s
  after a restart; the message is unaffected since the model saw the bytes at send time.
- **A text attachment's name is put in front of the model.** `safeName` strips path separators,
  control characters and the envelope's own `<`/`"` delimiters: it is client-supplied text crossing
  into both a response header and a prompt.

## Produced files (`/v1/sessions/:id/produced`)

- **This route has no roots and no byte cap, and that is a different claim from `/fs/*`, not a
  relaxation of it.** `/fs/*` gates paths the agent may have authored, hence a root allowlist and
  realpath containment. A `file_produced` event is authored by the runner about a file the engine
  itself just wrote, and the store is built from nothing else: the allowlist is "the exact paths
  this session's own runner announced." The byte cap is absent because a generated PNG is routinely
  1-2 MB and `/fs/read`'s 1 MiB default refused the common case.
- **Only files the engine *wrote*. Never files the agent *read*.** Codex's `imageGeneration`
  reports a `savedPath` its own tool created, a produced file. `imageView` reports a path the model
  chose to look at, an agent claim about an arbitrary location; that stays on `/fs/read`. For a new
  `file_produced` emission the question is "did the engine write this," not "is this a file we'd
  like to show."
- **`fileId` is derived from the path (sha256, truncated), never minted.** Codex reports the same
  `savedPath` on the progress item and the completed one, so a derived id makes the second a no-op
  instead of a duplicate; a session rebuilt from a park re-derives the same ids, so a client's
  cached URL still resolves.
- **The store subscribes from seq 0**, the opposite of `SessionNotifier`. Replaying a permission
  request is a spurious notification; replaying a `file_produced` is how a rebuilt session
  re-learns what it already produced. Registration is idempotent, so replay is free.
- **The path is re-checked at serve time, not trusted from the announcement.** A file can move, be
  deleted, or become a directory between the event and the fetch: those are 404s, and the
  transcript still shows the path. Bytes are streamed; with no cap on this route, buffering would
  put the file size into the gateway's heap.
- Serving is `nosniff` + `content-disposition: attachment`, like `/files` and `/attachments`:
  model-authored bytes must never render as a document on the gateway's origin. An `<img src>` is
  unaffected, disposition does not apply to subresources.

## Skills (the `skills` event, `skillsList`)

- **A skill is not a slash command, and the protocol keeps them apart.** A command is wire syntax
  the CLI parses out of the message; a skill is a capability the model chooses from its
  description, there is no `/skillname` any engine recognises. Skills ride their own `skills` event
  and `skillsList` capability, never `capabilities.commands`. A client may list or offer them as a
  typing aid; it may not render them as command chips.
- **Skills complete on `/`, alongside commands**, in one ranked list built by `mergeComposerRows`
  in `packages/ui/src/components/agent/composer-commands.ts` from three sources: engine commands,
  host client commands, and skills. They used to complete on codex's own `$` convention, dropped
  because it made the composer engine-dependent.
- **The merge is one list but not one behaviour, and the row must say which before it is picked.**
  An engine command resolves to a chip (the CLI really parses `/name` out of a message); a skill
  resolves to a `$name` chip followed by its default prompt as editable text; a client command
  resolves to a chip and is intercepted at send (`requiresArgs` rows to `/name ` text instead).
  Skills carry a `Sparkles` icon and `Skill ·` prefix, client commands a `SlidersHorizontal` icon.
  The vendored prompt-area's `TriggerConfig.insertAsText` and `chipOptions` are per-suggestion,
  letting one dropdown mix chip rows, text rows, and chips that serialise with a sigil other than
  the trigger that opened the menu (`ChipSegment.sigil`, carried as `data-chip-sigil`).
- **An engine command suppresses a client command of the same name, including via its aliases.**
  Claude's real `/compact` must win over any host imitation; the same client command must still
  appear on codex, which has no engine commands at all.
- **Picking a skill inserts `$name`; it does not send.** That is codex's own mention token: its
  system prompt tells the model to use a skill the user names with `$SkillName`, and the runner
  turns every `$name` matching a listed skill into a `{ type: 'skill', name, path }` item on
  `turn/start`, which codex core expands into the SKILL.md body deterministically. `skillPrompt`
  is `$name` plus `interface.defaultPrompt` with the token taken out (a skill with no prompt is
  the bare `$name `); VS Code inserts that string, the web composer inserts the chip form of it.
  The runner re-resolves mentions right before `turn/start`, because the first turn's input is
  built before the connection's own `skills/list` has answered.
- **`$name` is styled in a sent codex message, but only for a listed skill.** `scanPromptTokens`
  takes the session's skill names (`Transcript` provides them from `state.skills`), so `$10` is
  never a badge and a session with no skills never badges. Swift's `PromptTokens.scan` still skips
  `.skill`, pinned by a test; iOS has not caught up.
- **Codex has skills and no commands; Claude has commands and no listable skills.** Claude's CLI
  reports skill names on `system_init` and nothing else (no descriptions, scope, or suggested
  prompt), not enough to fill a picker honestly, so `skillsList` is false there. The SDK's
  `supportedCommands()` documents itself entirely in terms of skills, so claude's skills already
  arrive inside `capabilities.commands` and submit as `/name`. Do not add a second claude skills
  source.
- **Claude pushes `system`/`commands_changed` mid-session** when skills are discovered; the SDK
  instructs clients to replace their cached list, and `SessionRunner` re-emits `capabilities` with
  the cached models. A push arriving before the first fetch resolves is ignored, since
  `supportedCommands()` tracks the latest push regardless. `capabilities` is deliberately not in
  `replayCoalesceKey`, its reducer case is not a plain replace (`defaultModel` falls back to the
  previous value).
- **Clients gate the skills affordance on the `skills` event having arrived** (`state.skills`
  defined), never on `capabilities.skillsList` alone: the flag says the engine can answer, the list
  says it has, and the list is always asynchronous to the capability.
- **A promptless session lists skills over a throwaway connection.** A codex session otherwise
  spawns nothing until it has work, so `CodexRunner.start()` spawns a child, asks `skills/list`,
  and closes it rather than parking a real process behind every unstarted session. Skipped when a
  prompt or resume means a connection is coming anyway (one connection, not two); the session's
  real connection re-lists on arrival, and the fingerprint compare makes that a no-op.
- **`skills/list` must be given `cwds` explicitly: the empty case is a trap.** The schema documents
  it as defaulting to "the current session working directory," which reads like the thread's.
  Measured against 0.146.0: with no `cwds`, even after a `thread/start` carrying the session's cwd,
  the response comes back keyed to the app-server child's own process directory and reports no
  repo-scoped skills at all.
- **Repo skills live at `<cwd>/.codex/skills/<name>/SKILL.md`** and come back with `scope: 'repo'`.
  `interface` (and so `defaultPrompt`) is a plugin concept, read from a `.codex-plugin/plugin.json`
  manifest, not from anything beside a `SKILL.md`. A `SKILL.json` next to a `SKILL.md` is ignored
  outright, so every hand-written skill takes the clients' own fallback opener.
- **`skills/changed` carries no payload: it is an invalidation signal.** The runner re-runs
  `skills/list` and republishes only when the result differs (a fingerprint compare); the watcher
  fires per touched file, and concurrent refreshes coalesce onto one in-flight request.
- Everything about the listing is best-effort: a binary too old to know the method, a broken
  manifest, a child that died mid-call, none fails a session, the panel just never appears.

## MCP status (`/v1/sessions/:id/mcp`)

- **`mcpStatusInfo` drops `env` and `headers`, and must keep doing so.** The SDK's
  `McpServerStatus.config` carries a stdio server's environment and an HTTP server's headers
  verbatim, routinely API tokens; this route must never become a way to read the operator's
  credentials off their own machine. `args` is forwarded (the operator's own client shows it), so
  keep secrets out of argv, not out of this response. A server test asserts both omissions.
- **Tool parameters are engine-dependent, and both halves must be said.** The Agent SDK's status
  payload names and describes each tool with no input schema; codex's `mcpServerStatus/list`
  returns the full JSON Schema per tool. `McpServerToolInfo.inputSchema` is optional; the "not
  available" copy is conditional, not universal.
- **Listing and acting are separate capabilities.** `mcpStatus` says the engine can list;
  `mcpServerActions` says it can reconnect/enable/disable one server. Codex has the first and not
  the second: its reload RPC is server-wide, and enable/disable would mean writing the operator's
  `config.toml`, a different act from Claude's session-scoped switch.
- **The route 501s a POST the runner cannot serve, and that check is load-bearing.** `handleMcp`
  dispatches through `runner.reconnectMcpServer?.(...)`, optional chaining, so a missing method
  would otherwise no-op and answer 200 with the unchanged list, a button reporting success having
  done nothing.
- **Codex answers MCP status before the session has connected, over a throwaway child**, same
  device as the skill list: the session spawns nothing until it has work, and a panel reading "No
  MCP servers configured" until the first turn states something false. `mcpServerStatus/list`
  blocks until the servers are enumerated (measured: complete on the first call, ~2s from spawn).
  The dialog stops falling through to its empty state when the request failed: a 501 gives no
  standing to claim nothing is configured.
- **Codex's list response carries no status at all.** Which servers exist and what they expose
  comes from `mcpServerStatus/list`; whether one is up arrives separately on
  `mcpServer/startupStatus/updated`, which `CodexRunner` accumulates and merges in. Those
  notifications only fire for servers that come up while attached; a server already running sends
  none. So tools imply connected: a server with neither a notification nor tools stays `pending`,
  genuinely ambiguous between not started and disabled in config. `authStatus: 'notLoggedIn'` beats
  a missing notification and maps to `needs-auth`.
- **The three actions are session-scoped where they exist.** `reconnect`/`enable`/`disable` go to
  the running CLI; nothing is written to a `.mcp.json`. The iOS screen's footer says this.

## Checklist (the `checklist` event, `SessionInfo.checklist`)

- **`checklist` is the engine's list; `tasks` is the product concept, and they are deliberately
  different words.** The field carries only what the engine itself wrote (Claude's `TodoWrite` or
  its `TaskCreate`/`TaskUpdate` successors, codex's `turn/plan/updated`); clients draw `sessionTasks(info)`, that list unified with the
  untyped `Task` spawns `isAgentRecord` rejects. Naming the field `tasks` invites
  `info.tasks !== sessionTasks(info)` bugs; the pairing mirrors `subagents`/`sessionSteps`.
- **The `TaskCreate`/`TaskUpdate` half is incremental, and the id is minted in the result.** The
  current CLI replaced `TodoWrite` with `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`;
  `TaskCreate`'s input carries no id, the id comes back as `Task #N created successfully: ...` in the
  tool_result text, and `TaskUpdate` is `{taskId, status?, subject?, activeForm?}` with `deleted` as
  a status. `TaskChecklist` (`core/src/lib/checklist.ts`) holds a create pending until its result
  names the id, applies updates only to tasks it has seen created, and reads the id from the result
  *text* so the resume backfill (which carries no `tool_use_result`) rebuilds the same list. The
  SDK's `task_started`/`task_updated` system messages are background tasks (agents, bash), not this
  list; `task_subject` exists only on hook inputs. A `TodoWrite` from the same session resets the
  task fold: the whole-list vocabulary wins whenever it appears.
- **It is a fold of the event log, not a tracker.** `EventLog` folds it beside `activityCount`,
  `proseCount` and `contextUsage`; all three runners' `info()` read `this.#log.checklist`. The event
  serves the attached transcript, the `SessionInfo` field serves polled list surfaces. `restore()`
  must reset `#checklist` along with the other three counters before re-folding.
- **The emit must follow the subscriber fan-out, never come from inside `SubagentTracker.observe`.**
  An emit from the observer appends seq n+1 and delivers it before seq n reaches subscribers, and
  every reducer's `seq <= lastSeq` dedupe silently drops the `assistant_message` that carried the
  tool call. A core test pins that the `checklist` event's seq is strictly greater than the message
  that produced it. Recursion is one level: `checklistFromBody` of a `checklist` body is `undefined`.
- **Changed-only emission is compared against the log's own fold, not a private fingerprint.** A
  `TodoWrite` rewriting an unchanged list emits nothing; because the comparison reads the fold, a
  `/clear` automatically re-arms emission for an identical post-reset list.
- **A well-formed empty `todos: []` is a clear; only malformed input is `undefined`.** `todoPreview`
  has its own empty-list guard so the renderer can still show the generic tool preview for an empty
  list while core hears "the plan is gone."
- **Nothing sweeps it at a turn boundary.** The list survives `turn_result` and
  `status_changed(idle)`; the next write wins. `sessionState` does not read the checklist, so a
  standing list cannot make a session look busy.
- **`conversation_reset` clears it, with no explicit empty event**, the `contextUsage` pattern. Both
  reducers clear on the same arm, so replay ordering is correct without one.
- **`replayCoalesceKey` is the constant `'checklist'`**, because every write is the whole list and
  last-write-wins is the fold. `transcriptActivity`/`transcriptProse` are 0 (engine housekeeping
  must never move the unread badge); `transcriptContent` is false (it replays across a `/clear`).
- **Only the root thread's list counts.** A nested `assistant_message`
  (`parentToolUseId != null`) is a sub-agent's own checklist and is ignored. On codex the equivalent
  guard was missing: `turn/plan/updated` was not in `THREAD_SCOPED_NOTIFICATIONS`, so a sub-agent's
  plan was published as the root's; harmless only because the old `codex.todo_list` `sdk_event` had
  zero consumers repo-wide.
- **A codex session that wakes from dormancy reports no checklist until its next plan update.**
  Thread history carries no plan notifications to rebuild from; the app-server's `plan` ThreadItem
  is proposed-plan prose, not the step list. Claude rebuilds from its resume backfill.
- **The parked record's copy is a snapshot**, the same guarantee `subagents` has. It rides
  `ParkedSessionRecord.info`, rewritten on `system_init`, every non-park `status_changed` and
  `conversation_reset`, lagging at most one turn. It is a fold and must never be copied into
  `config`/`meta`.
- **`SessionInfo` alone cannot serve an attached session's status bar.** `packages/react` seeds
  `state.session` at attach and never re-seeds it, so the checklist half of the Tasks surface reads
  `state.checklist` (live) while the spawn half reads whatever `subagents` snapshot the host
  supplies.

## Tool titles (the `tool_titles` event)

- **A transcript row's label is a resolution, not a field.** `TranscriptItem` carries the wire name
  only; the title is looked up at render time through `toolTitle(name, state.toolTitles)`. Baking a
  title onto the item would put display text inside the identity the terminal variant folds runs by
  (`foldsTogether`, `runSummary`, `replayCoalesceKey`), which must stay the wire name.
- **The event carries only what a client cannot derive.** Host-declared titles
  (`HostToolDefinition.title`) and MCP-declared ones. Capability tools (`fs_write`, `eval_script`,
  `web_fetch`, ...) and the synthetic Codex names resolve client-side from `BUILTIN_TOOL_TITLES`, no
  bytes, works in replay. It is deliberately not in `replayCoalesceKey`: the reducer merges each
  event into what it already holds, and coalescing would keep only the last, a disagreement between
  live and replayed state the moment a session has two producers.
- **An engine's own tool names are deliberately untitled.** `Bash`, `Read`, `Task` are the CLI's
  published vocabulary; retitling them would rename the thing rather than explain it. The table
  covers only names we or the sandbox invented.
- **Never derive a title from the wire name.** `atomic__AppContext` -> "App Context" is worse than
  the wire name because it looks authored. No title means the wire name renders, unchanged.
- **A title is untrusted display text.** It arrives from a remote MCP server, so
  `sanitizeToolTitle` flattens it to one line, drops control characters, clamps it, and refuses a
  title that only restates the name. It is a label, never an identifier: the permission prompt keeps
  its own SDK-supplied `title`/`displayName`, and the wire name stays reachable in the transcript.
- **Only the provider engine recovers MCP titles reliably.** `@ai-sdk/mcp`'s `tools()` builds the AI
  SDK `ToolSet` and drops everything MCP-specific with it, so `connectMcpTools` also calls
  `listTools()` and joins by name, which is also where the annotation hints come from. The Agent
  SDK's `McpServerStatus` tool type stops at the three hints and has no title at all, so the claude
  engine probes for one and reports it only when the CLI happens to forward it.

## Attach replay (the hold, the cache, the five filters)

- **Only a fresh attach (`replayingFrom === 0`) yields a hold target; the reconnect's `undefined` is
  load-bearing.** A reconnect replays into a transcript the reader is already looking at, and
  blanking it mid-turn would be worse than the flicker the hold fixes. `useClaudeSession` sets the
  target unconditionally on every `attached` frame, so a reconnect's `undefined` also releases a
  hold whose replay a socket drop cut short. Guarding that set with "only when defined" silently
  re-creates the blank window.

Five filters sit on the replay/live path, and compose. Keep them distinct:

1. **Drop-below-reset**: `subscribe()` skips transcript content strictly below the latest
   `conversation_reset`.
2. **Drop-below-afterSeq**: skips events at or below `afterSeq`.
3. **Coalesce** (opt-in, `coalesceReplay` -> `replayCoalesceKey` -> `staleReplaySeqs`): skips state
   readings superseded later in the same replay. Sound only for a last-write-wins consumer;
   `parking.ts` subscribes from seq 0 and branches on `status_changed`, so a global default would
   silently skip a park side effect. The WS attach in `server.ts` is the one caller.
4. **Truncate results** (`truncateResults`, replay-path only): a `tool_result` block over
   `TOOL_RESULT_HEAD_CHARS` (8,000) is delivered as its head with `truncated`/`total_chars` set; the
   rest is one `GET /sessions/:id/events/:seq/result?toolUseId=` away. `replaySlice` copies, the
   stored log is never mutated. Opt-in from the rendering unit only (`useClaudeSession`, iOS's own
   attach), since a caller that asked for heads without knowing how to fetch them back would show
   one as the whole result. The head is chosen against the clients' own display budgets (~400
   collapsed, 2,000 open), so un-pressed states are byte-identical to an untruncated attach
   (`packages/ui/test/result-budget.test.ts`). The highest-seq event is exempt from dropping but not
   from truncation; the marker outlives the clip (affordance is `clipped || truncated`, never
   `hidden > 0`).
5. **Image refs** (`imageRefs`): a `tool_result`'s base64 `image` parts are delivered as `image_ref`
   addresses (`media_type`, decoded `bytes`, `part_index`); bytes come back from filter 4's own
   route, with `?part=N`. The only filter that also applies to the LIVE path (`SubscriberSet`,
   `packages/core/src/lib/subscribers.ts`, the single place that resolves which filters reach live
   events). Measured: 91% of tool-result payload across 214 local sessions is base64 no client
   rendered, a real attach falls 4,548 KB -> 1,275 KB. A new part type, never a hollowed-out `image`
   (an image with no bytes is not a smaller image, and an unfamiliar type falls through every fold
   safely). Targets `image` with a base64 source, never "non-text" (the corpus's only other
   non-text part, `tool_reference`, totals 122 KB). `part_index` is stamped from the stored array,
   not the delivered position, since `headOf` drops non-text parts while building a head, refs are
   applied before truncation, and `headOf` keeps an `image_ref`. Its own flag, because the family's
   additive-on-this-protocol argument rests on "a client that never asked cannot receive one," which
   a flag whose meaning grew after shipping would destroy. On the live path, bytes have only two
   worse fates than an address: discarded, they cost 335 KB median per attached watcher for
   nothing; kept, they need a second decode-from-event render path that pins base64 inside
   `TranscriptState`, which the transcript LRU then retains across session switches.

- **The client end of an image ref is a bounded, promise-keyed cache, and eviction must revoke.**
  `useToolResultImages` caches the pending promise per address, not the resolved URL, since a
  transcript row re-renders on every streamed delta. The key is the whole address
  (`sessionId:seq:toolUseId:partIndex`): a dormant wake restarts the seqs, and a cached address that
  outlived its log must miss rather than serve another call's pixels. Budget is **64 MB of decoded
  bytes** (`CACHE_BUDGET_BYTES`), around 190 images at the corpus's 335 KB median. `evict` drops
  oldest-first (`Map` insertion order, a hit re-inserts) and must `URL.revokeObjectURL` as it goes:
  an object URL pins its blob until revoked, so freeing only the `Map` entry frees nothing. Opposite
  of `useProjectIcons`, which never revokes because its URLs *are* the cache. Loading is deferred
  `MOUNT_SETTLE_MS` (150ms) after a row mounts, with no `IntersectionObserver` beside it (the
  transcript is virtualized, a mounted row is already within an overscan of the viewport). A started
  load runs to completion; an aborted fetch re-pays the whole image on the return visit.
- **`truncateResults` cuts text, and text is not where the bytes are, measured.** A truncating
  attach on the reference session came out at 3,092 KB against 3,101 KB untruncated: 0.3%. Of 176
  `tool_result` blocks, only four held more than 8,000 characters of text (8 KB between them); the
  giant frames were base64 image parts, which `truncateResultBlocks` deliberately does not touch
  since slicing one corrupts it. Across local session logs: 44 MB of tool-result text against 458 MB
  of base64, two thirds produced by `Read` (an agent looking at a PNG) rather than a browser tool.
  Do not restate an "N% of an attach" figure that measured `JSON.stringify(content).length`, which
  counts base64 as text.
- **A stale `sourceSeq` must be refused, not guessed.** The fetch route requires `toolUseId` and
  verifies it against the block it found. A woken dormant session has a fresh log with fresh seqs,
  so a cached seq can name a different event entirely. 404 means "re-attach"; `loadFullResult`
  answers `false` rather than throwing, since the caller is a press on a row with nowhere for an
  exception to go.
- **Coalescing must never drop the highest-seq event, and cannot by construction**: the
  globally-last event is by definition the last of its own key. `useClaudeSession`'s replay hold
  waits for `state.lastSeq` to reach the attach frame's `session.lastSeq`, so a coalescer that
  swallowed the final event would hang the panel blank forever. If extending `replayCoalesceKey`,
  the property to keep is that folding the full log and the coalesced log through `applyEvent`
  yields identical state (`packages/react/test/replay-coalesce.test.ts`). Three kinds look eligible
  and are not: `capabilities` (`defaultModel ?? base.defaultModel` is a fallback merge),
  `model_changed` (`undefined` means "keep the last known model"), and `system_init` (the server's
  `watchAuthSource` reads the first one).
- **A cached `afterSeq` against a rebuilt log fails silently.** Attaching at `afterSeq: 500` against
  a runner whose log holds 12 events delivers nothing, so the client sits on a stale transcript with
  no error, no spinner, no reconnect. The log resets routinely: a dormant session is rebuilt with a
  brand-new runner starting at seq 0. `staleAttach` in `use-session.ts` guards on two signals:
  `frame.session.lastSeq < held.lastSeq`, and a `createdAt` mismatch (all three runners stamp
  `createdAt` at construction; `AiSdkRunner` restores it exactly when it restores the event array).
  Reachable even before any cache existed: a `SessionHandle` reconnect after a gateway restart
  re-attaches with its own advanced `#lastSeq` and freezes the same way.
- **Recovering from a stale attach has three traps.** Unhook the event listener before resyncing (a
  rebuilt log advanced past the held seq must not compose new-log events into old-log state in the
  same tick); seed the reducer back to `initialTranscriptState` (`applyEvent`'s `seq <= lastSeq`
  dedupe would otherwise swallow the fresh replay); and do not let the effect cleanup write the
  condemned state back to the cache, or the retry re-poisons what it just discarded. The retry
  attaches with `afterSeq` 0, for which `staleAttach` is false by definition, so it cannot loop.
- **The hold's placeholder must not become the next flicker.** The hold hides the transcript by
  `visibility` (never unmounting: rows must lay out so the virtualizer measures and the reveal is
  one paint) and draws a `Loading...` line. `wd-hold-appear` holds it at `opacity: 0` and fades it
  in only after 600ms, so a healthy attach never paints it. `visibility` is also the one hiding
  property a descendant can turn back on, which is how that line stays visible inside a hidden root.
- **The reveal must paint already at the bottom, and the follow spring cannot do it.** Even
  `scrollToBottom('instant')` defers behind a `requestAnimationFrame` (measured: revealTop 33,037
  against a final 34,459 on a 600-row fixture, a visible jump). What lands in the same frame is a
  layout effect on the hold's falling edge pressing `use-stick-to-bottom`'s own `state.scrollTop`
  setter, recorded in `ignoreScrollToTop` so the write is not read back as user intent.
- **The two "+N chars" markers are indistinguishable on screen, but only one fetches.** A result
  that arrives while you watch is never truncated (the head budget sits above both display budgets,
  so cutting a result already on screen buys a fetch for nothing). A live row's marker is the
  renderer's own display clip (no network); a reloaded row's marker is the wire truncation (only
  that one fetches), and only the wire one's label carries the `fetch the rest` suffix. Verify by
  attaching cold and watching the network panel; reading the transcript proves nothing.

## The unread badge (`proseCount`, watermarks)

- **The badge counts prose, not activity, and the two counters must not be confused.**
  `SessionInfo.proseCount` (scored by `transcriptProse`) is what `unseenCount` diffs against a
  watermark; `activityCount` is every content block and is what sorting, "has anything happened at
  all," and dormancy read. Repointing either at the other undoes one of the two features. A session
  that ran forty tools and said nothing badges zero, on purpose.
- **A watermark written before this shipped has no `prose`, and that absence reads as caught up.**
  Reading it as 0 instead would badge every previously-visited session with its entire prose history
  the first time it polls after an upgrade. Same rule in the Swift mirror (`Watermarks.swift`).
- **A caller that knows nothing about prose must pass `undefined`, never 0.** `Watermarks.mark`
  keeps the previous `prose` when the argument is absent; a gateway without the field reports no
  `proseCount`, so a mark of 0 would walk a real prose watermark back and re-badge everything the
  operator had read. The field is additive on purpose and cost no `PROTOCOL_VERSION` bump.
- **A `user_message` scores zero prose: the human wrote it, so it cannot be unread by them.**
  Counting it badged the sender's own prompt, because the watermark only advances when the polled
  sessions list ticks while the session view is mounted and visible: send, navigate away inside that
  window, and your own message came back as one unread.
- **The badge's colour answers "is this waiting for me", which a working session is not.** Grey
  while `state === 'working'`, accent once it has stopped, and accent for `attention` because a
  pending approval does want a person. Painting a working session accent made every mid-turn
  increment look like a finished turn.
- **The badge cannot flip mid-stream, and that is a wire fact.** Unread is derived entirely from the
  polled REST rollup; `transcriptProse(stream_delta)` is 0 exactly as `transcriptActivity`'s is, and
  `assistant_message` is emitted per completed message. The badge is correct within one poll (<=2s
  busy) of a message completing. Making deltas count is precisely what those zeros exist to prevent.

## Terminal theme (`transcriptVariant: 'terminal'`)

- **The free-text prompt field grows by whole lines only because it has no padding.** `PromptInput`
  (the question card's "Other..." and the permission card's deny reason) is a `textarea` with
  `field-sizing: content`; its `line-height` is `--term-line` and the field sets no padding, so
  every height it takes is an exact multiple of the cell. Adding vertical padding, or a pixel cap
  instead of `calc(8 * var(--term-line))`, takes it off the grid. Where `field-sizing` is
  unsupported (Firefox) it degrades to a one-line scrolling box, which is the intended fallback.
- **Enter sends and Shift+Enter is the newline, in the prompts as well as the composer, and the
  `isComposing` guard is not optional.** Without it an IME's candidate-confirming Enter submits a
  half-typed answer.
- **Selectability is declared, never inherited.** `.term-press` sets `user-select: text` explicitly
  because a transcript is read far more often than it is opened. The user band (`.term-user`) must
  do the same: a block with no declaration inherits whatever the host gives it (selectable on web,
  not selectable in the VS Code webview), and a block that cannot host a selection endpoint doesn't
  refuse the drag, it makes the selection jump to the next valid position above it, which reads as
  a layout bug rather than a missing declaration. Anything neither `.term-press` nor ordinary text
  must state both `user-select` and `cursor`. A user prompt renders inside `StickyPromptLane`,
  which is `pointer-events: none` so the head overlay can't trap the pointer; the prompt sits
  *inside* that lane, so it inherits `none` and can't take a mousedown unless
  `[data-sticky-lane] > [data-index]` hands the pointer back to the real row.
- **The gutter markers are the CLI's, and they are the whole of a row's identity.** `❯` is what you
  typed, `●` the model or a tool call, `⎿` that tool's output one level in, `✻` thinking, `!` a
  runner notice. Every renderer in `terminal/items.tsx` answers exactly two questions, which marker
  and what the body says; spacing, radius and border belong to `Row`/`Blank`/`Band`. `❯` is also
  `PROMPT_GLYPH`, shared with the composer's gutter, so both spellings keep the caret on the same
  column.
- **A run of exactly one tool call draws as the call itself, never as a one-line summary.**
  `RunRow` (`terminal/items.tsx`) falls through to `ToolRow` when `items.length === 1`; a run of
  two or more still draws `ToolRunRow`'s `runSummary(...)` row. This is a rendering rule only, the
  block model (`RunBlock`, its key, indices, expansion state) is untouched, and `blockHeight`
  (`height.ts`) prices the run-of-one case as `itemHeight(block.run[0], m)` to match. Shared with
  iOS: `planRun` in `TerminalPlanner.swift` falls through to `planToolCall` for the same case,
  because the summary would occupy the same one row while throwing away the tool's name, input and
  result preview.
- **`--term-font-size` and `--term-line` must be whole pixels.** A line height of `1.5 x 13px` is
  19.5px: every second row of a long transcript lands on a half-pixel, text visibly softens, and
  diff bands show a seam along their edge. `TerminalSurface` rounds what it is handed rather than
  passing it through.
- **`--term-bleed` is a contract between the scroller and every band.** A full-bleed run of rows (a
  diff hunk, the user's prompt band, a hover fill) cancels it with matched negative margin *and*
  padding, so its value must equal the scroller's own horizontal padding. `TerminalSurface` sets
  both together; a host that pads the scrolling element itself sees every band stop short of the
  edge with no error.
- **A diff's line numbers come from the wire, never the client.** They are protocol's `FilePatch`
  hunks; a patch whose hunks all start at `0` is the pre-approval case, and `TerminalDiff` renders
  it **without** a number column rather than a column of zeroes (`patch.hunks.some(h =>
  h.newStart > 0)`).
- **The card components have no terminal branch at all.** The terminal theme is a separate renderer
  the shell mounts *instead* of them, so nothing under `components/agent/` asks which variant it is
  in. The composer is the one exception: it lives outside the scroller, reads the variant from the
  panel-wide context, and draws its own terminal form.
- **The blank line between blocks is a row, not a margin, inside the virtualizer.** The virtualizer
  measures one element per item, so space between two items must be *part of* one of them or it
  goes unmeasured and the scrollbar drifts. Hence `term-row-gap` as padding on the measured
  wrapper, applied conditionally via `needsBlank` so a tool call and its output stay flush.
- **Affordances must cost no layout.** The hover fill is a background and the copy actions are
  absolutely positioned overlays one line tall, so `affordances={false}` changes no glyph's
  position; a new affordance may not be added as anything that occupies space.
- **`ch` is measured off the live surface, never derived from the font size.** `CellMetrics.ch` is
  the advance of `0` in px (7.83px at 13px JetBrains Mono, not `13 * 0.6`), read by `measureCh` from
  an absolutely positioned probe. Every wrap column count in `height.ts` divides by it, so a derived
  value is wrong by a fraction of a cell per row.
- **A tool result's image is a fixed box of whole lines, reserved before the bytes arrive.**
  `IMAGE_BOX_LINES` (12, about 240px at an 18px line) is the box in all three states, pending,
  loaded, failed, because an image's intrinsic size is unknowable until fetched and a mount-
  corrected row brings back the growing scrollbar the height calculator exists to kill.
  `image-box.ts` is its own module so `items.tsx` (draws it) and `height.ts` (predicts it with no
  DOM) can't spell it twice; `test/image-box.test.ts` pins the spelling.
- **Verify against the real renderer, not the model.** jsdom has no text layout, so only a browser
  can check terminal-theme geometry. The playground is `cd packages/ui && pnpm dev`, port 5193,
  with console hooks including `__wdAudit` (height audit), `__wdCheckMapping`, `__wdPerf`,
  `__wdStream`/`__wdPinTrace`/`__wdReplay` (scroll-pin checks), and the "audit grid" button. Re-run
  after any change to row structure.
- **The scrubber's right lane anchors on the answer, not the turn end.** `buildMarks`
  (`packages/ui/src/components/agent/scrubber-marks.ts`) emits the turn mark for the last
  top-level assistant message of each segment and lets a `turn_result`, where one exists, decorate
  it (failed colour, `doneLine`). Building marks from `turn_result` items alone is history-blind: a
  resumed session, or one replayed after a gateway restart, carries no `turn_result` at all, and the
  right lane comes back empty while the left lane survives, which reads as a rendering bug rather
  than a missing input.
- **What pins the sticky prompt is a one-line `overflow: hidden` head, and the browser does the
  pinning.** The head re-renders the same row laid exactly over the real row's first line,
  `aria-hidden`, no pointer events. Each prompt row renders inside an absolutely positioned lane
  spanning its turn, with the head `position: sticky` inside it: `sticky` is inert on an absolutely
  positioned element itself but works on a child of one. A JS-written pin instead runs behind the
  compositor and wobbles under momentum scroll. Three edges: the head must be in its own absolutely
  positioned sub-lane, never in flow with a negative bottom margin (sticky confinement clamps the
  margin box, so a zero-height margin box lets the head overshoot the lane and puts two pinned
  prompts on screen during handoff); the lane is positioned with `top`, never the `translateY`
  every other row gets (sticky resolves at layout time, a transform is paint-only); and
  `rangeExtractor` must compute the active prompt from the virtualizer's own offset, not a ref,
  because the range pass runs before the render that would refresh it.
- **A focus-takeover guard keys on where the keyboard IS, not on how many times an effect ran.** A
  `mounted` ref (refuse first pass, follow after) is unsafe under React StrictMode: the dev-only
  remount preserves refs, so the second pass sees `mounted === true` and steals focus from a
  half-written message. `isTyping` must test the field's *content*, not its focus: VS Code keeps
  the composer focused at all times, so guarding on focus alone means the approval prompt can never
  take the keyboard.
- **The pulse frames `⋄ ◇ ◈ ◆` (U+25C6/7/8) are East-Asian ambiguous width.** Under an East-Asian
  locale a terminal may render them double-width and shift the line, so they are safe only inside a
  fixed-width box, which is exactly `.term-gutter` (one `--term-cell` wide). Anything writing to a
  real terminal must use the ASCII set instead. Frames are 150ms (one cycle of the 0.6s clock
  `icon-loading.svg` pulses on) and the rest frame is the complete mark, so stopping never lands
  mid-glyph.
- **The vendored prompt-area's list continuation rewrites `- ` to `• ` in the MODEL, not just on
  screen.** A bulleted message would reach the agent as `• item`, which no markdown parser reads as
  a list and which the character grid has no cell for; it is switched off in `Composer`.
  `insertListContinuation` keys on `[•\-*] ` and reuses the line's own marker, so Enter after
  `- item` still inserts `\n- `. The terminal composer's gutter interrupt is `✕`, not `■`: the
  square would read as a *state* in a column where `●` and `◆` really are states, and `✕` is one of
  the few candidates that measures exactly 1ch in JetBrains Mono (`⏹`/`⏸`/`⏻` are 1.05-1.31 cells
  and break the grid).
- **iOS: a tap that stopped a scroll is not a press.** `TerminalRowCell`'s `UITapGestureRecognizer`
  measures movement in window coordinates, so during momentum scrolling the finger can be
  perfectly still while content slides under it: zero movement, tap recognizes, whatever drifted
  under the thumb expands. `handleTap` needs both signals: the scroll was already
  dragging/decelerating at touch-down (touching kills deceleration, reading it at tap time is too
  late), or `contentOffset` moved between touch-down and lift. `allowableMovement` stays at UIKit's
  default 10pt, and the tap recognizer must not recognize simultaneously with the pan recognizer,
  only with the text view's own.
- **Green means sub-agent in the transcript, and it is spent twice.** A settled mutating tool is
  already green on the gutter glyph (`items.tsx`, `TerminalPlanner.toolTone`), so sub-agent green
  goes on the Task's body instead, keeping green meaning "wrote to the workspace" on the gutter.
  Constraints on any change here: the summary strings in `tool-run.ts`/`height.ts`/`ToolRun.swift`/
  `TerminalPlan.swift` are rendered verbatim and are what the height calculator wraps, so a colour
  change is safe only while it changes no characters. iOS's `TermLine` carries one `tone` for the
  whole range (only `.font` is merged per-range), so "green label, dim tail" needs a
  `TerminalTextRun.make` change. Consecutive same-parent calls fold into a `RunBlock` with no
  `Agent(...)` label left to colour (accepted: a Task folds into a run only when childless). The
  spawner set is already spelled three times (`SPAWNER_NAMES`, `tool-icon.ts`,
  `JSONValue+Display.swift`), so the colour rule keys off block shape instead of a fourth spelling.
- **iOS: a selectable `UITextView` eats the first tap, and `cancelsTouchesInView` does not save
  you.** `BodyTextView.isSelectable = true` installs its own tap recognizer; the press recognizer
  lives on the cell's `contentView`, a superview, and UIKit resolves that conflict in the inner
  view's favour, so the first tap makes the text view first responder and never reaches
  `handleTap`. The fix is `tap.delegate = self` with `shouldRecognizeSimultaneouslyWith` returning
  `true`. That then breaks a guard: `handleTap` refuses a press while a selection stands (to avoid
  collapsing the block with the selection in it), but running simultaneously, the text view may
  have already cleared the selection by the time the handler fires. The selection length is
  therefore snapshotted at touch-down in `gestureRecognizer(_:shouldReceive:)`, and both readings
  must be zero.
- **iOS: gestures are the one surface no agent can test.** The simulator will not accept synthetic
  touches from an agent shell and the app target has no test host, so tap/press/selection rules are
  verified by a human thumb or not at all.

## Catch-up mode (the `unseen` boundary)

- **The setting gates the recap, not the send.** A message typed mid-turn always goes straight
  through for the engine to fold into the running turn; there is no Agent SDK option to hold it and
  no client offers to. Catch-up mode is the reading aid: the boundary row, faded rows above it, and
  the "N new rows since you were last here" bar.
- **The panel has no preference of its own: it reads `unseen`.** Off is `unseen={undefined}`, and
  the client decides. `SessionPanel` freezes the mark it was mounted with (`catchUpMark`), so
  toggling the setting only takes effect for sessions opened after.
- Each client owns its own storage: web `workerdeck.catch-up` in localStorage, VS Code
  `workerdeck.catchUpMode`, iOS `AppSettings.catchUpMode`. **The watermark keeps advancing either
  way**: it lives in its own store (`workerdeck.watermarks.v1`, `UnreadModel` on the phone) and the
  sessions-list unread badge reads it regardless, so turning catch-up off costs a marker, never a
  count.
- **iOS splices the seam twice, by design.** The phone has two renderers; the terminal path takes a
  boundary into `TerminalRows.build` and reports back the *row* it landed on (fade, rail mark and
  `jump` all need the row, not the item index), while the cards path inserts a divider before the
  boundary item. What they share is the counting (`Recap.swift`, the port of `packages/react`'s
  `recap.ts`). A takeover frame never carries the seam on any client: the boundary is a
  full-transcript index and a frame's rows are a filtered list.

## Web dashboard

- **Overriding a colour token lower in the tree needs its alias too.** `theme.css` has two tiers: a
  raw palette, then an `@theme inline` block mapping it to Tailwind's `--color-*`. Some go through a
  bridge alias (`bg-surface` -> `--color-surface: var(--surface)`, `--surface: var(--bg-surface)` on
  `:root`). A custom property is substituted where it is *declared*, so `--surface` resolves to the
  root's `--bg-surface` once and that colour inherits down; redefining `--bg-surface` on a subtree
  changes nothing for anything spelled `bg-surface`, silently. The dashboard's `.app-frame` sets
  `--bg`, `--bg-surface` *and* `--surface` for this reason.
- **`navigator.clipboard` does not exist on the origin this dashboard actually runs on.** It is
  gated on a secure context (HTTPS or localhost), and the normal deployment is plain HTTP on a LAN
  address. Copy through `copyText` (`packages/ui/src/lib/clipboard.ts`), which falls back to
  `document.execCommand('copy')` over an off-screen (not `display: none`) textarea, since a hidden
  element cannot hold a selection. Every copy affordance routes through it, including `CopyAction`,
  which gates its checkmark on the return value.
- **`crypto.randomUUID()` is gated on a secure context too**, undefined on exactly the deployment
  multi-gateway exists for (plain HTTP on a Tailscale name; `localhost` counts as secure).
  `newHostId()` (`packages/web/src/lib/hosts.ts`) falls back to building a v4 from
  `crypto.getRandomValues`, which carries no such gate.
- **The sub-agent frame round-trips through the URL, and three rules keep it from looping.**
  `SessionView` navigates `?subagent=<toolUseId>&sn=<n>` into the panel and folds the panel's
  `onSubagentChange` report back into the same param, so the URL stays the one truth about what is
  on screen. (1) No-op on match: the commonest report is the echo of our own request, so navigating
  again for it starts a cycle. (2) `sn` rides through unchanged when the panel entered a frame the
  URL didn't ask for (a Task row pressed in the transcript): the panel's request effect keys on the
  nonce, so a fresh nonce per report would re-request the frame it's merely describing. (3)
  `replace`, never `push`: a report is bookkeeping about state already on screen, so Escape does not
  mint a history entry. Consequence: a frame entered from inside the transcript leaves no history
  entry, so Back from it exits the page, not the frame; the strip's Back and Escape are the frame's
  own way out. `?reveal=<toolUseId>&rn=<n>` is a separate pair: a task has no agent behind it, so
  framing its tool-use id would select no items.
- **The VS Code webview stamps its first paint into the HTML, and declares no `connect-src` at
  all.** Every byte to a gateway rides postMessage. `img-src` allows http(s) for inline images on
  keyless gateways only, because header auth cannot ride an `<img>`. Everything the first paint
  needs (font mode, density, variant, terminal cell, affordances, panel font size) is stamped on
  `<html>`/`#root` rather than pushed over the bridge, because a postMessage arrives one tick late
  and these values decide every row's height; changing any of them re-renders the HTML.
- **The dashboard is a build artifact; the packages are not.** `pnpm dev:server` serves
  `packages/web/dist/` while every other package resolves to source through the
  `@workerdeck/source` condition. A long-running `pnpm dev:server` keeps serving the JS it started
  with, so a UI change needs the server restarted or `pnpm dashboard` re-run.
- **A Tailwind theme token cannot be re-pointed on a subtree, and `font-family` is not a token
  lookup at all.** `SessionPanel`'s `transcriptFont` stamps `data-agent-font='mono'` on its root;
  redefining `--cw-font-sans` there does nothing. First, `--font-sans: var(--cw-font-sans)` is
  declared in `@theme` at `:root`, and a `var()` inside a custom property resolves against the
  element that *declared* it, not the one that inherits it, so `--font-sans` carries the
  root-resolved sans stack down forever. Second, `body { font-family: var(--cw-font-sans) }`
  resolves once at `body`, and every descendant inherits the resolved stack, not the token. The fix
  sets all three: both tokens and `font-family` itself. The VS Code webview's equivalent gets away
  with tokens alone only because its override sits on `html`, the same element `:root` declares
  them on.
- **A flex container hands its parent its first item's baseline, not its text's.** The status bar's
  `items-baseline` alone was not enough: a rate-limit meter was `inline-flex` with a 13px
  `ProgressRing` as its first child, so the row took the circle's baseline and the number sat
  2.5px high. Meters are plain inline text now (the ring is `inline-block align-middle`), and
  `Badge` takes `items-baseline` with `self-center` on its dot/spinner. Rule: if a row must align
  on text, nothing decorative may be the first flex item.
- **The transcript is virtualized, and two things want to write `scrollTop`.**
  `use-stick-to-bottom`'s follow spring owns staying at the bottom; `@tanstack/react-virtual` wants
  to correct the offset whenever a row measures differently from its estimate. Split by regime in
  `TranscriptRows.tsx`: pinned, corrections are suppressed outright, since a correction that moves
  the viewport up reads to the follow logic as the user scrolling away and silently breaks the
  lock mid-stream. Escaped, the virtualizer corrects so scrollback holds still. `anchorTo`/
  `followOnAppend` stay at their defaults, and supplying `shouldAdjustScrollPositionOnItemSizeChange`
  *replaces* virtual-core's own default rules, so a major bump needs a re-read. A programmatic
  `scrollTop` write does not escape the bottom lock, only a real input event does (`handleScroll`
  reads user intent), so a test that "scrolls up" by assigning `scrollTop` proves nothing; escape
  it with a synthetic `WheelEvent`. Separately, the library's resize guard watches the *content*,
  while a composer that grows resizes the *scroller* (siblings in the panel's flex column): that
  class of size change the guard structurally cannot cover, hence a `ResizeObserver` of our own on
  the scroller's box, re-pinning only when already pinned.
- **The send re-pin is a held pin, not one `scrollToBottom('instant')`: a trackpad's momentum tail
  kills the one-shot.** On macOS a scroll-up keeps emitting wheel ticks for over a second after the
  fingers leave, and `handleWheel` reads any `deltaY < 0` as escape intent. One such tick landing
  after send unpins in the gap before `scrollToBottom`'s first rAF, whose `!state.isAtBottom` check
  then aborts the animation, so the send visibly does nothing. `repinToBottom`
  (`use-transcript-jumps.ts`) does four things a bare call does not: clears `escapedFromLock`,
  passes `ignoreEscapes` with a `duration` so the pin outlasts the tail, seeds `state.animation` by
  hand (the library installs its `ignoreEscapes` record only inside the first rAF, one frame too
  late for a tick in the send's own task), and presses `scrollTop` synchronously. Deliberate detach
  still wins: `stopScroll()` and drag-selection run ahead of the guard, and the hold expires before
  a reply's first row can arrive. `test/repin.test.ts` pins the synchronous-state contract.
- **A new height epoch invalidates every remembered size, the measurements included**, since they
  were taken at the old width. `virtualizer.measure()` clears the size cache, but a row re-enters
  it only when its ResizeObserver fires, which needs a size *change*: a mounted row whose height
  survives the width change keeps its stale estimate forever, growing a phantom scroll tail. Two
  edges: `resizeItem` diffs against `measurementsCache`, which right after `measure()` is still the
  pre-wipe array, so an unchanged row diffs to zero and the write is skipped unless something reads
  a measurement first (e.g. `getTotalSize()`) to rebuild the array from estimates. And use
  `resizeItem` directly, never `measureElement(element)`, which is gated on scroll state and
  silently drops a measure that lands while a scroll is still hot, which a resize's own scroll
  anchoring makes routine.
- **`useFlushSync` looks like dead weight and is not.** Turning it off silences a React
  "flushSync was called from inside a lifecycle method" warning (corrections fire from
  `measureElement`'s ref callback, inside the commit) but costs anchoring: over the same walk up
  through unmeasured rows, on holds the scrollback to the pixel, off let a step slide 112px under
  the reader.
- **A row the reader cannot see is not in the DOM.** Find-in-page and select-all reach only mounted
  rows, and a row's transient UI state (an expanded tool card) resets on unmount. Anything that
  needs to find a row must go through the virtualizer, not `querySelector`; catch-up's "jump" is a
  closure the transcript fills in (`jumpToRecapRef`) that re-aims after scrolling, since the offset
  it first targets is only a sum of estimates.
- **The transcript variant is a panel-wide context, not a transcript one.**
  `TranscriptVariantProvider` wraps `SessionPanel`'s whole tree, because the composer and the
  approval/question prompts render outside the scroller and still need to know. Scoped to the
  transcript alone, the prompts silently render as cards inside an otherwise terminal panel, with
  nothing erroring.
- **Pieces outside the transcript are separate `TerminalSurface`s, so they need the metrics passed
  too.** A surface sets the cell; one handed no `fontSize`/`lineHeight` falls back to the CLI's
  13/18. A host running the transcript at its editor's size while leaving the composer at the
  default gets a caret on a different column from the conversation. `SessionPanel`'s
  `terminalMetrics` is one prop feeding all three.
- **The markdown renderer puts list markers in the gutter cell, not in CSS list styling.**
  `components/terminal/markdown.tsx`'s `li` component renders a `.term-gutter` marker cell plus a
  `.term-body`; `terminal.css` sets `.term-md .term-list { list-style: none }` and the marker comes
  from `.term-li > .term-gutter::before` (content `-`, or the ordinal counter for `term-list-
  ordered`), so it costs grid columns (`- ` is 2, `1. ` is 3) rather than a typographic indent that
  would misalign wrapped lines. This goes through a Streamdown component map rather than overriding
  the renderer's default classes; `cards` keeps the renderer's defaults on purpose.
- `SessionPanel`'s `header` prop takes a function when an embedder wants the session-actions (`⋯`)
  menu in its own chrome: called with the menu and the status bar, then rendered without them. The
  menu can only be built inside the panel (capability record, host-file verdict, dialog state), but
  an app with its own top bar wants it there, hence the seam rather than a second menu.

## APNs push (the CLI's forwarder)

- **`apns.topic` must equal `PRODUCT_BUNDLE_IDENTIFIER` in `apps/ios/project.yml`.** No shared
  constant, no validation; a wrong topic just gets a rejected push. `keyFile` is a path resolved
  relative to the config file, never key contents (the `.p8` belongs in a password manager, not
  gitignore; it downloads once, and a team gets only two active keys). There is deliberately no
  `environment` config key: environment is a property of each device token, not the server.
  `examples/dev-server.config.mjs` is the worked example.
- **The push `category` is a wire contract with the iOS app.** `forwarder.ts`'s `CATEGORY` sends
  `PERMISSION_REQUEST` / `SESSION_EVENT`; the app registers Approve/Deny under those exact
  strings (`PushPayload.swift`). Neither side errors on a mismatch, the notification just arrives
  with no buttons. Renaming one half means shipping both; an older app keeps the old string. Same
  reason `pnpm smoke:push` builds its payload through `buildPush` rather than by hand: a
  hand-rolled payload has no `sessionId`, `PushPayload.init?` returns nil, and the tap goes
  nowhere.
- **A Live Activity is a different push type AND topic.** `apns-push-type: liveactivity` pairs
  with `apns-topic: <bundleId>.push-type.liveactivity`; `ApnsRequest.pushType` defaults to
  `'alert'` so existing callers are unaffected, and `topicFor` is the only place the suffix is
  added.
- **Three tokens, two registries.** The alert token and the Live Activity push-to-start token are
  device-level, in `apns-devices.json`. Per-card update tokens churn every turn and live in
  `apns-activities.json`, keyed `(deviceToken, sessionId)`. `POST /apns/devices` treats
  `liveActivityStartToken` and `notify` as three-state: omitted leaves the record alone (so an
  app built before the field ships doesn't erase it on every launch), `null`/absent-array clears
  it. **`[]` is a real answer** ("no alerts at all") and must not collapse with "field absent."
  Absent `notify` falls back to `DEFAULT_NOTIFY` (`devices.ts`): every type but `session_closed`.
- **Filtering is per device, in the forwarder, not the emitter.** `SessionNotifier` emits all four
  types; `deliver` in `forwarder.ts` drops them per `DeviceRecord`. Webhooks have their own
  `events` list. A device that wants nothing keeps its token registered, so turning notifications
  back on is one POST, not a re-registration.
- **Every push collapses per session, per kind.** `buildPush` sets `collapseId:
  <COLLAPSE_PREFIX>:<hash(sessionId)>` (`p`/`t`/`e`/`c` per type), so a session with five pending
  tool calls shows one banner, not five; the requests themselves are still pending. **The
  per-kind prefix is load-bearing**: collapsing on session alone would let an approval silently
  overwrite a "turn finished" banner for the same session. `thread-id` only groups in
  Notification Center; it collapses nothing.
- **`canImport(ActivityKit)` is true on macOS, but `ActivityAttributes` is unavailable there.**
  `WorkerDeckActivity`'s conformance needs `#if canImport(ActivityKit) && os(iOS)` or `swift test`
  fails to compile, the only place the payload contract is tested.
- **`Activity` is not `Sendable`.** Every ActivityKit call from `@MainActor` is a Swift 6 "sending"
  error. `ActivityCoordinator` keeps stream handling `nonisolated`, passes only Strings to the
  actor, and the per-card watchers re-look-up the activity by **id** rather than capturing it.
- **The card's `agents` line is additive, and the first thing `shrink` gives up.** `ActivityAgent`
  is `{name, state}`, at most 4 running-first entries off `SessionInfo.subagents`; the Swift
  `ContentState.agents` is optional so an older app and an older gateway both degrade to no line.
  Answer buttons still go first, then agents, then any of the card's own text.
- **A running card's hero is the checklist step only when exactly one is `in_progress`.** The first
  of several would be a confident wrong answer, so two in flight say "Working…" instead.
- **A Live Activity's content state must carry dates as epoch-millisecond numbers, never `Date`.**
  ActivityKit decodes a pushed content state with a default `JSONDecoder` (seconds-since-2001
  strategy); a Unix timestamp in a `Date` field draws a countdown from the wrong century. For the
  same reason `phase` and `kind` are `String`, not enums: a Codable enum throws on an unknown
  value and the whole update is dropped, freezing the card instead of degrading it.
- **A Live Activity button has no `.authenticationRequired`.** The notification's Approve is a
  `UNNotificationAction` gated behind Face ID; the card's Approve waits for an unlocked phone only
  via `AppSettings.approveWhileLocked` (default), the only guard between a locked phone and an
  approved tool call. Deny is always allowed.
- **The buttons run in the app process, not the widget extension** (`LiveActivityIntent`
  conformance), so the extension holds no credential. A plain `AppIntent` with `openAppWhenRun =
  false` has a `perform()` that is silently never called. The handler installs from
  `AppDelegate.application(_:didFinishLaunchingWithOptions:)`, not a SwiftUI `.task`: a
  push-to-start wake or intent launches the process with no scene, so `WorkerDeckApp.body` never
  evaluates.
- **Sandbox and production are different token namespaces, not different URLs.** Same key, same
  phone, different token per build type; pushing at the wrong endpoint gets `BadDeviceToken`
  forever. Environment is a property of each registered device: the app reads `aps-environment`
  from its embedded provisioning profile and sends it with the token; the forwarder routes each
  token to its own host. A `#if DEBUG` guess is wrong for a Release build run from Xcode.
- **The provider JWT needs a raw `r||s` signature, not DER.** `crypto.sign('sha256', …)` produces
  DER unless given `dsaEncoding: 'ieee-p1363'`; Apple answers a bare 403 with nothing to debug.
- **Never re-sign the provider token per push.** Apple rejects one older than an hour and
  rate-limits refreshes (`TooManyProviderTokenUpdates`); the client caches for 40 minutes.
- **Apple throttles a provider that repeatedly pushes to invalid tokens**: connections start dying
  with GOAWAY and cancelled streams that look like a network fault. One bogus-token probe is a
  legitimate credential check (good JWT → `BadDeviceToken`, bad JWT → `InvalidProviderToken`); a
  loop of them is self-inflicted.
- **The session's `error` event fires a tick after the stream it kills settles**, so
  `pool.lastFailure` only carries failures that preceded the stream (a GOAWAY does; `closeSession`
  destroys pending streams synchronously and emits the session error after teardown). The stream's
  own killer comes from `error.cause`; a dial failing on every address family
  (`api.push.apple.com` has A + AAAA) can leave that cause an `AggregateError` with an empty
  message, producing `The pending stream has been canceled (caused by: ) (0)` in logs.
- **A push failure retries exactly once, only with proof Apple never processed it**: stream still
  `pending` (no stream id), `request()` threw before a stream existed, or reset was
  `REFUSED_STREAM` (RFC-guaranteed unprocessed). Everything else is never retried, since permission
  pushes carry no collapse id and a duplicate would be a second banner for the same decision. A
  still-`connecting` session whose stream died pending is destroyed so the retry dials fresh
  rather than queuing behind a doomed connect.
- **Node's Happy Eyeballs gives each address 250ms, and Apple does not always answer in it.**
  `autoSelectFamilyAttemptTimeout` defaults to 250ms; `api.push.apple.com` publishes A and AAAA,
  so a dial can walk up to six candidates. Measured during one failure burst: 0/5 succeeded on the
  default vs 5/5 with a 2s timeout, which the client now sets explicitly. `autoSelectFamily:
  false` measured no better and would strand an IPv6-only host.
- **An unmounted route is not unclaimed: the dashboard's SPA catch-all answers for it.** With no
  `apns` config, `/apns/devices` fell through to the static host, which answered a registration
  POST with 405, not the 404 the app relies on to mean "no push here." The fallback now claims
  `/apns/devices` whether or not a forwarder exists. General rule: when a surface's contract is
  "absent means 404," something must answer that 404 or the catch-all answers instead, with 405 or
  an HTML 200. Only reachable with the dashboard on; `--no-web` still 404s.
- **A `turn_completed` push replaces a session's notification rather than stacking**, via
  `collapseId: t:<hash(sessionId)>`: correct in production but hostile to a test loop, since a test
  push aimed at a live session gets silently taken over by the next real turn notification. Push at
  an idle session, force-quit first, and confirm the seq that arrived. `smoke/README.md` has the
  rules.
- **A dormant wake renumbers a session's seqs**, so a bare `seq` in a push payload can deep-link
  into a log that no longer exists. `SessionInfo.epoch` dates it: the gateway bumps it on every
  dormant wake, runners echo `config.epoch` from `info()`, the forwarder puts it beside `seq`, and
  `deepLinkSeqSurvives` refuses a mismatch, landing at the tail instead. Absent epoch on either
  side means "same log" (stays additive, no `PROTOCOL_VERSION` bump needed). The epoch travels
  through the runner's *config*, so `parking.ts` must persist the config the runner was actually
  built with or a later park resurrects the stale one; the epoch dates the seq only, nothing else.
- **`pnpm smoke:push` 401s for two reasons.** `WD_AUTH_KEY` (`<state-dir>/auth-key`) is required
  once `--auth-key` is in play, and the host must be spelled the way the gateway was started (the
  Host-header guard rejects a tailnet IP against a gateway started with `--host <name>`, and
  answers `unauthorized` rather than anything host-related).
- `fetch`/undici will not do: APNs is HTTP/2 only, hence `node:http2` directly.
- **The APNs key's environment and restriction scope cannot be changed after creation** (Apple's
  portal forces the choice at creation; a team gets only two active keys). WorkerDeck's is
  "Sandbox & Production" + "Team Scoped" so one key serves both endpoints. (Unverified against the
  tree: Apple portal behaviour.)
- **Never implement a UIKit completion-handler delegate requirement in its `async` form when the
  completion must land on the main thread.** The synthesized `@objc` thunk can call the completion
  block off the main actor; `UNUserNotificationCenterDelegate`'s `didReceive` completion drives
  main-thread-asserting work, so every notification tap crashed with
  `NSInternalInconsistencyException`. Fix: implement the completion-handler form directly, hop to
  the main actor, call the completion there. A `@MainActor` witness doesn't work (nonisolated
  requirements, Swift 6 rejects the conformance) and `@preconcurrency` just moves the crash to a
  dynamic assert UIKit doesn't promise to satisfy. Not unit-testable; the gate is the compiler plus
  a real device tap.
- **A tapped notification lands on the row it was about via a landmark table beside the reducer**
  (`TranscriptSeqIndex`), not inside `TranscriptState`, because the state is a hand-mirror of the
  React reducer and a field only one client needs would drift. Two rules: the lookup answers with
  the first item appended at or after a seq; `conversation_reset` invalidates every recorded
  landmark.
- **A shrinking item list is not necessarily a `/clear`.** A dropped streamed-thinking placeholder
  during a normal `assistant_message` also shrinks the list by one, so treating any shrink as a
  reset resolved stale seqs to item 0. `note` instead diffs the two item id lists to find where
  they diverge (an emptied list falls out as the reset case for free), guarded by an O(1) check
  (last item of `before` still at its old index in `after` means nothing moved) so a replay of
  thousands of events stays cheap.
- **The hold lifting is not the same event as the replay landing.** `ReplayHold` gives up on a
  1.5s stall or 20s ceiling, so `!replaying` on a phone over a tailnet often means "shown early,"
  not "complete." A jump landed mid-replay near the bottom of what had arrived used to pin the
  reader there, then follow every later replay event to the tail. Fixed by two pure, tested
  pieces: `deepLinkPlacement` decides completeness by `lastSeq >= session.lastSeq`, never by hold
  state, and `TranscriptScrollGeometry.pinsAfterJump` never pins an incomplete jump. A user jump or
  scrub (`complete: true`) keeps the old rule. Reproduce via the simulator loop in
  `apps/ios/README.md` § Push deep links on the simulator.
- **Closing a container must close what it contains.** iOS holds expansion beside the rows
  (`TerminalExpansion`) because every frame comes from the height book; web holds it in
  component-local `useState`, which dies with an unmounted child for free. `apply(_:subtree:)`
  closes the block's whole key set with a container; the `.call` guard inside it is load-bearing,
  since the subtree passed in is the whole block and a single result closing "its" subtree would
  collapse every sibling in the run.
- **A Live Activity does not draw while its own app is frontmost.** No lock-screen card, nothing
  in the Dynamic Island; leave the app to see it, or a working card looks like a dead button.
- **`ActivityCoordinator.reconcile()` ends any card it cannot attribute to a live session**, and
  runs from `handle()` for every card the app sees, including one raised a second earlier in the
  same process. `ActivityDebug`'s `ses_debug` session exists on no gateway, so without
  `isLocallyRaised` exempting it, the debug affordance killed its own card within a second. The
  same guard is why a real push-to-start card needs a matching `Host` entry to survive its first
  foreground.
- **ActivityKit delivers the same activity twice**: once in `Activity<T>.activities` at launch,
  again down the `activityUpdates` stream. A "have I seen this card?" guard keyed on session id
  ends the only card there is. Key on the activity **id** instead; `ActivityClaims` in
  WorkerDeckKit has the tests.
- **`try? Activity.request(…)` is never worth it.** It fails silently for Live Activities off for
  the app, off device-wide, an over-cap payload, or too many active cards, all presenting as a
  dead button. The debug raiser surfaces the error string instead.

## VS Code surfaces (the Agent panel and session tabs)

- **A session lives in at most one surface, and the panel never shows a session a tab holds.**
  Every click path goes through `selectSession`, which checks the registry first: a session with
  a tab is revealed there whatever the modifier, and opening a tab on the panel's own session
  moves it (`panel.hold`). Bypassing `selectSession` to call `panel.show` directly is how two
  webviews end up attached to one session, each moving the other's watermark.
- **Focus is sticky and only a surface can claim it.** `registry.setFocused` is called from a
  tab's `active` transition, a webview's `wd-focus`, and `selectSession`; nothing clears it. A
  panel with no session (the held info state) does not claim focus on click, or the status bar
  and every section would blank the moment the user pressed its Focus button.
- **Vitals are per surface.** `surface.vitals` replaces the old module-level `let vitals`; a
  tab streaming in the background must not repaint the status bar for the focused session, so
  the `vitals` delegate pushes only when the reporting surface is the focused one. `markSeen`
  takes the surface, not the session, for the same reason.
- **A closing tab hands its session back quietly.** `panel.show(session, { quiet: true })`
  skips the focus command that a first `show` otherwise runs, because the panel view may have
  been disposed since it held the session and materializing it would pop the dock open on every
  tab close (window shutdown included).
- **Tab restore runs before the model has sessions.** The serializer rebuilds a tab from the
  persisted `{ hostId, sessionId, cwd }` alone, titles it by short id, and lets the next
  `model.onDidChange` retitle it; a restored tab on the panel's remembered session converts the
  panel to the held state, whichever of the two restores first.

## VS Code Host Mode (the supervised `workerdeck` child)

- **Every `workerdeck.host.*` setting is `scope: "machine"`, never `machine-overridable"`.** The
  overridable variant lets a workspace win, and a `bindAddress: "0.0.0.0"` in a cloned repo's
  `.vscode/settings.json` would expose an agent runner on the LAN the moment the folder is
  trusted.
- **The auth key goes in the child's environment (`WORKERDECK_AUTH_KEY`), never its argv.** `ps`
  is world-readable, so `--auth-key` would publish the key to any local process.
- **The child writes to a log file, not a pipe.** It is spawned `detached` and `unref`ed to
  survive the window that started it; a piped detached child dies with `EPIPE` on its first write
  after the extension host exits. The Output channel is fed by tailing that file
  (`log-tail.ts`), which is also how a window shows the log of a server it merely adopted. The
  tail must decode through a `StringDecoder` (a read can land mid-codepoint; `toString` emits
  U+FFFD on the split) and must treat `size < offset` as rotation, resetting to 0 rather than
  reading garbage.
- **The port is the real lock; `vscode-host.json` only records ownership.** Adopt-whatever-answers
  is what makes a sibling window, a hand-started `npx workerdeck`, and a crash-restart all one
  case; there is no cross-window leader election, since the loser of a spawn race self-resolves
  via `EADDRINUSE` → re-probe → adopt in under a second. The lock file exists so Stop refuses to
  kill a server VS Code did not start; a lock whose pid is gone is a crash leftover, cleared on
  read.
- **Signal the process group, not the pid.** On the `npx` path the server is a grandchild, so
  `process.kill(pid)` only stops the launcher and orphans the server; `process.kill(-pid)` works
  because the spawn is `detached` (group leader). Windows needs `taskkill /T`.
- **`SIGTERM` to this CLI is a drain, not a kill.** Turns in flight finish; a second `SIGTERM` is
  the "stop now." A stop that waits and reports failure after 2s is misreading a working shutdown
  as a hang.
- **`extensionKind === Workspace` is not "am I where the files are," and gating Host Mode on it
  disables Host Mode in every ordinary local window.** A local window has no remote extension host
  to be relative to, so it reports `UI`. The correct condition for "this host is not the machine
  holding the workspace" is `env.remoteName !== undefined && extensionKind === UI`; everything
  else, local included, is the right place to run the server.
- **Host Mode does not configure profiles.** It only launches a server; profiles are managed live
  over `/v1/profiles` by the gateway-agnostic Profiles command. A settings array could only ever
  reach the local server, and expanding `~` for a remote gateway would resolve this machine's home
  against that machine's filesystem.
- **Bundling the CLI into the `.vsix` is not a size trade-off, it is impossible.** `@openai/codex`
  is 275 MB and the Agent SDK's platform package 190 MB, both per-platform.

## Build, test & packaging

- **A test's name is not its assertion; only the assertion runs.** `404s when the instance has no
  forwarder` asserted `expect(status).not.toBe(200)`, which the actual bug (a 405) passed happily.
  A negative assertion is the shape to distrust: it green-lights every wrong answer but one.
  Assert the exact status, body, or value the test name claims, or rename the test.
- **Verifying "it is really production React": check the right marker.** `grep jsxDEV` on a
  `pnpm start:prod` bundle is a false positive (a markdown library's own options check hits it).
  The real markers are `react-stack-bottom-frame` and the dev warning strings; zero of either
  means production.
- **`localStorage['workerdeck.transcript-variant']` is stored raw, not JSON.** `setItem(key,
  'terminal')`, not `JSON.stringify`; storing it quoted makes `getTranscriptVariant()`'s
  `stored === 'terminal'` fail and the panel silently stays on Cards. A fresh profile also
  defaults to Cards, so screenshot the panel before trusting any transcript measurement.
- **A heavy transcript for free: resume, don't generate.** `GET /v1/sdk-sessions?cwd=…&profile=…`
  lists what the engine store holds; creating with `resume: <id>` and no first prompt replays the
  whole thread with no turn sent and no tokens spent, useful for a perf sweep needing a real
  ~1000-row transcript.
- **`@workerdeck/ui/workspace` is a separate entry point so Monaco stays unreachable from the root
  entry**, and `sideEffects: false` does not save you: Rollup drops `CodeEditor` from a
  `SessionPanel`-only bundle, but Vite resolves Monaco's `new Worker(new URL(…,
  import.meta.url))` calls during transform, before tree-shaking, emitting ~9MB of
  language-service workers that never get retracted. `monaco-editor` is an optional peer for the
  same reason: importing the workspace entry requires installing it, importing only the root
  entry does not.
- **The dashboard aliases away Monaco's four worker-backed language services** (TypeScript, JSON,
  CSS, HTML: 8.8MB, `ts.worker` alone 6.7MB) since the pane only needs reading and small edits.
  Monarch syntax highlighting for ~90 languages is unaffected (separate main-thread mechanism).
  It's an alias rather than a hand-written entry because a hand-written entry must import
  `codicon.css`, which monaco-editor's exports map cannot resolve as a subpath. The alias regex in
  `packages/web/vite.config.ts` matches the **whole** specifier, not a suffix, since Vite
  substitutes only the matched span. `optimizeDeps.exclude: ['monaco-editor']` is load-bearing
  too: the dev optimizer rewrites the package into `.vite/deps/`, where the worker's `new URL(…,
  import.meta.url)` paths 404 and Monaco silently falls back to running on the main thread.
- A package importing a workspace sibling needs the vitest workspace-source alias (see
  `packages/core/vitest.config.ts`): the `@workerdeck/source` condition alone isn't enough, since
  vite-node externalizes siblings to their unbuilt `build/` entries.
- **Inter-package deps are `workspace:*`, and pnpm must be what packs them.** `pnpm
  publish`/`pnpm pack` rewrite the protocol to the concrete version; `npm publish` does not, since
  this workspace has no `workspaces` field in the root `package.json` for npm to resolve against,
  so it would ship `workspace:*` verbatim and break every consumer.
- **A brand-new package cannot have its first release published by `publish.yml`.** Trusted
  publishing is configured per package on npmjs.com, and that settings page only exists once the
  package does, so the first version of a new name goes out by hand (`pnpm publish --access
  public` from its directory, with 2FA), then the trusted publisher is configured, and every later
  release goes through CI. `pnpm publish -r` skips versions already on the registry and walks in
  dependency order, stopping at the first failure, so packages after a failed one never publish;
  check the registry rather than assuming the whole run failed.
- **A publish is visible to the write path before the read path.** `npm view <pkg>` and `npm
  install` can 404 for minutes after a new name publishes while the packument indexes, even though
  `GET /<pkg>/<version>` already returns 200. A re-publish answering `E403 "cannot publish over the
  previously published versions"` is proof the first one worked; don't mistake the 404 for a
  failed publish and re-run. `npm cache clean --force` clears the negative cache locally.
- **Configuring a trusted publisher needs npm ≥ 12.** The call is `npm trust github <pkg> --file
  publish.yml --repo <owner>/<repo> --allow-publish`; npm 11 has no concept of the registry's
  required `permissions` field and 400s no matter what is passed. npm's error reporting drops the
  registry's actual explanation (npm-registry-fetch appends only `body.error`, the trust endpoint
  answers with `body.message`), so read the response body yourself (npm/cli#9377). `--repo` must
  match the remote case-sensitively or OIDC rejects the token later at publish time; `--file`
  takes the workflow filename, never its path.
- **Running a trusted publish is a different version floor**: npm ≥ 11.5.1 / Node ≥ 22.14, pnpm ≥
  11.1.0 (older pnpm's OIDC support sends an unresolved `${NODE_AUTH_TOKEN}` placeholder as auth
  and 404s). A trusted publisher is bound to the workflow filename, and a tag runs the workflow
  from the tagged commit, so a tag predating `publish.yml` publishes nothing.
- **A throttled registry read is indistinguishable from a 404.** Under rapid repeated calls, `npm
  view <pkg>` answers as though the package does not exist. Any script branching on "is this
  published yet?" must retry before believing a negative.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- **Everything publishable lives under `packages/`, and that's load-bearing.** `publish.yml`'s
  tag/version gate reads only `readdirSync("packages")` and `version:set` filters
  `./packages/*` (plus `./apps/vscode` and `./apps/embedded` explicitly), but `pnpm publish -r`
  walks every non-private workspace package, `apps/` included. A publishable package placed under
  `apps/` would ship while being invisible to the version bump and tag check. This is why the
  dashboard is `packages/web`, not `apps/web`.
- The root package is `workerdeck-monorepo`, not `workerdeck`: the unscoped npm name belongs to
  `packages/cli`, and two packages sharing a name in one pnpm workspace is a conflict. The root is
  private, so its own name is cosmetic; don't "fix" it back.
- `packages/web` is published as static files with zero runtime dependencies: everything it
  builds with (React, the router, Tailwind, the workspace packages) is a devDependency, since it
  all compiles into `dist/`. Its entry (`entry.mjs`) is hand-written and outside vite's graph so
  the published entry can never drift from the published `dist/`.
- `packages/cli` gets the dashboard from a runtime dependency on `@workerdeck/web`
  (`resolveWebRoot()` reads that package's exported `dashboardDir`), not a vendored copy. In a
  checkout this resolves to `packages/web/dist`, which only exists once built (`resolveWebRoot()`
  throws with the build instruction otherwise, since dev never builds); `pnpm --filter
  @workerdeck/web run build` is a prerequisite for running the CLI from source. In
  `packages/cli/vitest.config.ts` the workspace-source alias needs an explicit `web` entry before
  the general rule, since `web` is an app with no `src/index.ts` for the regex to find.
- The dist is portable only because `packages/web/vite.config.ts` sets no `base` (assets resolve
  from an absolute `/assets/...`) and the SPA uses hash history; the dashboard must therefore be
  mounted at a domain root. Subpath mounting would be a build-time `base` decision, not a runtime
  flag.
- `packages/web`'s build drops the legacy `.woff` files `@fontsource` emits alongside `.woff2`
  (`scripts/trim-fonts.mjs`, ~660 KB), since the generated `@font-face` lists `woff2` first and no
  browser able to run the app ever requests the fallback. This runs in the producing package so
  every consumer gets one payload.
- The CLI loads `workerdeck.config.mjs` through a dynamic `import()` of a runtime path on purpose:
  it is the operator's code, not part of our module graph. Keep the specifier non-literal so no
  bundler tries to resolve it; vitest cannot load a config fixture from outside the project root,
  which is why `packages/cli/test` writes fixtures under the package.
