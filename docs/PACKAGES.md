# Packages

The per-package rules that don't follow from the types. Dispatched from `CLAUDE.md`;
the package map and the dependency rule live there.

## `packages/protocol`

wire types (events/commands/REST). Dependency-free, browser-safe, depends
on nothing and everything depends on it. Breaking → bump `PROTOCOL_VERSION`. It also owns the
few *rules* both sides must agree on rather than each guess: `transcriptActivity(event)` is
the row-count rule the react reducer renders by and the runners count with
(`SessionInfo.activityCount`) — change one, change both. A **subagent's own messages score
zero** (any event carrying a `parentToolUseId`): they render *inside* the `Task` call that
spawned them, which is itself a counted row, and one Task can outnumber everything a person
typed that day — a badge is a promise about what is on screen. It is deliberately not the
claim `transcriptContent` makes, which still counts them: a nested item mutates `items` and
must replay. `transcriptContent(event)` sits
beside it and is a *different* rule — does the reducer mutate items, which is broader than
"counts a row" (deltas and tool results count zero and still mutate): it is what
`SessionRunner.subscribe` skips below a `conversation_reset` (`/clear`) so a re-attach doesn't
resurrect a cleared conversation while state events still replay; `activityCount` stays
monotonic across the reset, because it is an unread cursor, not an item count.
`snapshotRetains(event)` is the fourth of the same family and the same shape of claim as the
coalescer: which events a *store* may drop without any client being able to tell. A
`RunnerSnapshot` embeds the whole event log and a log is mostly stream deltas — a four-character
token rides a ~180-byte envelope, sitting on disk beside the `assistant_message` that respells
it — which was affordable written once at a park and is not written after every turn. So
everything is retained except `stream_delta`, safe because a delta is superseded by construction
(both stream exits flush, the error path included) and because `transcriptActivity` scores it 0,
so the `activityCount` a restore recomputes is bit-identical and no unread cursor moves. That
last property is why this is *not* a cap on the log, which would have moved it. **Provider engine
only**: a Claude log's thinking blocks arrive empty and are backfilled from the delta stream, so
the same rule there would erase every thought — unreachable today (only that engine snapshots)
but an obligation any engine inherits with `park()`. Proof in
`packages/react/test/snapshot-retain.test.ts`, the same fold-equality property as the coalescer.
`replayCoalesceKey(event)` is the third of the same family and the same shape of claim: which
events are **last-write-wins on replay**, so the gateway can drop the fifty stale context and
rate-limit polls a long session accumulates instead of shipping them all and having the client
render each — the usage meters used to visibly count up through the session's history on every
attach. Keyed per *window* for rate limits, because the reducer stores them that way. It lives
in protocol for the usual reason (only core coalesces, only react can prove it right, neither
may import the other), and the property is testable rather than argued: folding the full log
and the coalesced log must yield identical state. It grew one case beyond the polls: an
`sdk_event` carrying the CLI's transient `system`/`status` chatter, which is the single most
numerous thing in a real log — 1,363 frames over 388 KB in one measured session, a ninth of the
whole attach, describing what the runner was doing an hour ago. Narrow on purpose, because
`sdk_event` is the escape hatch for SDK messages this version does not model and the family's
standing rule is that the safe failure is a stale row, never withheld state.
`replayRetains(event)` is the **fifth** of the family and the closest relative of
`snapshotRetains` — the same "no client can tell" claim pointed at the wire instead of at a
store, and *not* last-write-wins: these are events the reducer reads and discards, so a replay
that ships them spends the reader's network on frames whose whole effect is `return base`.
Today that is exactly one thing and it is the second-largest item in an attach: the
`stream_delta`s the reducer does not model. Measured over one 1,270-row session the delta run
was 774 KB and **~85% of it was thrown away on arrival** — `input_json_delta` (a tool call's
arguments, streamed character by character, 383 KB), `signature_delta` (153 KB) and the
`message_start`/`content_block_*` scaffolding (244 KB). `thinking_delta` is deliberately kept:
the Claude SDK sends thinking blocks whose text is `''` and the reducer backfills them from the
accumulated stream, so dropping those erases every thought — the same carve-out `snapshotRetains`
documents, which is why *that* rule is provider-engine-only. `text_delta` is kept too, being
superseded only by a lookahead nobody has needed to write for 24 KB. Proof in
`packages/react/test/replay-retain.test.ts`, the family's usual fold-equality property, and the
caller must never drop the log's highest-seq event whatever the rule says — a client's replay
hold waits for it. Two more joined it, both lifted
out of the VS Code extension once a second client needed them. `ToolResultBlock.truncated`/`total_chars` and
`TOOL_RESULT_HEAD_CHARS` are the family's **sixth** rule and the only one that changes an
event's *content* rather than deciding whether to send it: a `tool_result` over 8,000 characters
replays as its head, with the rest one fetch away. Measured, three frames of 641/463/396 KB were
68% of one session's 3.1 MB attach, and the cut is *structural* — proportional to whatever is
actually large, wherever it sits, which a row window is not. On the **block**, never the event,
because `user_message.patch` already has to caveat "only when the message carries exactly one
`tool_result`" and a message answering three calls truncates whichever of them is large. The
constant lives here so `packages/ui` can assert the relationship that matters: at 8,000 it
exceeds both clients' own budgets (~400 collapsed, 2,000 open), so both un-pressed states are
byte-identical to an untruncated attach and only the uncapped press fetches. Additive at
protocol **7** rather than a bump, and that is sound only because it is opt-in *and the opt-in
is issued by the unit that renders*: a client that never asked cannot receive one.
`ImageRefPart`/`imagePartRef` are the **seventh** and the first written *after* its measurement
rather than before it — which is the point, since the sixth's own 68% projection turned out to be
0.3% on the wire. Measured across 214 local sessions, **91% of all tool-result payload is base64
no client renders** (489 MB against 44 MB of text), present in 189 of them, and two thirds of it
from `Read` looking at a PNG rather than from any browser tool. So a base64 `image` part replays
as an *address* — media type, decoded size, and the index it holds in the **stored** block — and
its bytes come back from the same `/events/:seq/result` route the sixth rule built, now with
`?part=N`. On the wire that is **4,548 KB → 1,275 KB** on a real session, with the control (no
pictures in it) byte-identical and the text char-identical in both: the fold does not move, which
is the justification measured rather than argued. A **new part type, never a hollowed-out
`image`** — a head is a valid shorter text, but an image with no bytes is not a smaller image,
and an unfamiliar type falls through every existing fold exactly as the CLI's own
`tool_reference` does. It is **narrow on purpose**: `image` with a base64 source, never
"non-text", because the only other non-text part in the corpus is `tool_reference` and every
instance of it totals 122 KB. `part_index` is a stamped field rather than the position it arrived
at, and that is load-bearing: `headOf` drops non-text parts while building a head, so the two
rules composed renumber a block — which is also why refs are applied **before** truncation and
why `headOf` now keeps an `image_ref`. Its **own** opt-in (`imageRefs`) rather than a widening of
`truncateResults`, because this family's additive-at-**7** argument rests on "a client that never
asked cannot receive one" holding by construction, and a flag whose meaning grew after shipping
is the fact a later reader cannot recover. The one place it departs from the sixth: it applies to
**live events as well as replays**, since the render path is ref-then-fetch and bytes arriving
live would only be discarded or pinned in `TranscriptState` — which is what `SubscriberSet`
(`packages/core/src/lib/subscribers.ts`) exists for, the live half of what `replaySlice` did for
the replay.
`FilePatch`/`PatchHunk` joined
them for the same reason: a diff's line numbers are the *engine's*, carried on
`user_message.patch`, because no client has read the file and one that computed them would point
confidently at the wrong line. What rides there is only the hunks — the Claude SDK's
`FileEditOutput` also carries `originalFile`, the entire pre-edit file, and this log is replayed
on every attach and captured into parking snapshots, so that is the attachment-bytes rule again.
`SubagentInfo` + `SessionInfo.subagents` are the same family and the same trade: sub-agent work
is otherwise **attach-only** (it exists on the wire only as `parentToolUseId`, reconstructed by
the reducer), and a sessions list never attaches, so a list could not know a session was running
six agents inside one turn. A **runner-owned rollup computed at read time**, exactly
`pendingPermissionCount`'s shape — which is what puts it on the REST list, the attach snapshot
and parking snapshots for free — folded in the claude runner's `#emit`, the one chokepoint, so a
dormant rebuild reconstructs it from the resume backfill with no second path. Three rules that
are bugs if dropped: `status` is the sub-agent's **own** `tool_result.is_error`, which is now also
what `taskFailed` draws the `Task` row with — it had been "or any child's", and the argument made
here (a nothing-matched grep must not read as a failed run beside a session name) turned out to
hold just as well beside the row: an agent that ran a hundred calls, one of them that grep, came
back red claiming it had failed. Two surfaces, one rule, one spelling;
an interrupted turn **sweeps to `failed`** on `turn_result`/`session_closed`/the status coming to
rest, because a resume backfill replays no `turn_result` and a woken mid-Task session would
otherwise read `running` forever — **except a background agent**, which is *designed* to outlive
its turn: a real session ended three turns while three `Agent`s ran and the sweep re-branded all
three as failures. So the turn and idle sweeps spare a record the **live** stream marked
background (`task_started`, or the async spawn's "Async agent launched" receipt, which is a
receipt and never a verdict — settling on it reads "0 of 3 running" while three agents burn
tokens); `session_closed` and the terminal statuses still settle everything, because the process
hosting those agents is gone, and evidence that is merely *replayed* is never spared for the same
reason. A background agent's real verdict is the CLI's `task_notification` (`completed` → `done`,
any other stop → `failed`), which on a resume survives only as the `<task-notification>` wrapper
text — the `SYNTHETIC_USER_PREFIXES` argument again. The spawner name is **not** the rule
(`Task` and `Agent` are both observed, and a third spelling is caught by `task_started`, the
receipt, or the nested-event fallback); and it is **bounded** — every running record plus the newest
`SUBAGENT_HISTORY` settled, evicted by settle order and not insertion order, because this rides
every row of a 1.2s poll and lands in park snapshots (the attachment-bytes rule again). Absent
and empty mean the same thing. `sessionState` grows **no** fifth bucket for it — a new state
would split `working` for every client that has not shipped this, and sub-agents are an
*annotation* on a working row, the call the scrubber makes about errors — but it does **count**
them, and the difference between counting and assuming was a real bug. The rule used to read "a
session with agents running is already `working`", which is true of a synchronous `Task` (the
turn is in flight, so the *status* carries it) and false of the **background** agent
`SubagentTracker` goes out of its way to spare (`if (!final && record.background === 'live')
continue`): the turn ends, the status comes to rest at `idle`, and the row read Idle while an
agent burned tokens. So `working` is a disjunction — the running statuses **or** any running
sub-agent — with the terminal statuses moved *above* it defensively, since a stale `running`
record on a closed session must read `ended`; `attention` still outranks everything, a pending
approval being the one thing a person has to act on. What makes this worth reading twice is how
it survived: **no existing test built a row with `subagents` at all**, on either platform, so
the premise had a hole exactly where nothing looked — and on iOS the field had never been
mirrored, so the phone could not have been right whatever it computed.
`session-list.ts` is the
**sessions-list view model** (the `attention/working/idle/ended` buckets, the
gateway/adapter/state/**project** facets, `filterRows`/`groupRows`/`subsetSummary`/`clearFilters`, and
the scope-containment rule where a gateway-tagged root scopes only that gateway and an
untagged one only loopback), and `watermarks.ts` is the **unread model** (monotonic marks
behind a `WatermarkStore` seam, and `unseenCount`'s rows-not-turns arithmetic). They are
rules, not preferences: the extension's unread status-bar item counts the *same* rows its
list shows, so a client that filtered differently would announce work it is hiding. Tests live
in `packages/react/test/session-list.test.ts` + `watermarks.test.ts` (protocol has no
vitest of its own); Swift mirrors in `WorkerDeckKit`. `usage.ts` joined them with the plan
meters: `mergeUsage` is **which reading a client renders** — the gateway's per-profile state
(`ProfileInfo.usage`) wins every window it holds, the session's transcript fills the rest —
and the reason it is not a timestamp comparison is the rule worth keeping: the reducer stores
**one** clock for the whole map, so this session's morning `five_hour` is dated with the
afternoon's `seven_day` event and would beat a genuinely fresher profile entry, while the
tracker (fed from every session on the profile, by event `ts`) is never behind what one
transcript holds. The session half is coverage, not correctness — an in-memory map is empty
after a restart, and a session with no profile has no account state at all.
`orderUsageWindows` is the ordering-and-drop-the-unknown rule beside it, because the panel
renders windows off a merged transcript and the dashboard's profile page renders them off
`ProfileInfo.usage` with no session in sight. Tests in `packages/react/test/usage.test.ts`;
**no Swift mirror yet** — the phone still renders its session's own reading.
`ProjectInfo` (`SessionInfo.project`) is **what a folder is called**, and it is on the wire for
the same reason `SubagentInfo` is: a client cannot work it out. A `.workerdeck.json` declares a
name and an icon; the *gateway* finds it by ancestor walk from the session's realpath'd cwd,
nearest wins, because the phone and any browser talking to a remote gateway have no access to
that filesystem and a per-client reader would make the feature exist on one client. `root` — the
canonical directory holding the file — is the **grouping key**, never `name`: two repos are both
called "api", and renaming one must not empty a saved filter (which is also why
`ViewConfig.projects` holds `projectKey` output, and why it is the one *optional* facet array —
a stored config predating it must keep filtering). The icon is the attachment-bytes rule
arriving where it always does: `SessionInfo` rides every row of a 1.2s poll and lands in park
snapshots, so a base64 icon there would be thirty copies a second of something that never
changes. The wire carries a **content hash** (`{type:'image', mediaType, hash}`) and the bytes
come from a route, fetched once and cached by that hash across every session in the project;
`{type:'glyph', name}` is the other arm and costs nothing, validated by *shape* only since the
gateway has no lucide catalog — a client must fall back on a name it does not know, which
`packages/ui`'s `ProjectIcon` does by drawing `Folder`: it carries a **curated** 110-glyph table,
because a namespace import over lucide's ~1,600 measured **927 KB against 77 KB** on the VS Code
sidebar's own bundle. `projectsOf(rows)` is the filter control's source and returns
`{key, label}` pairs for the reason `projectKey` exists — the key is what `ViewConfig.projects`
holds and the label is what a person picks by, so two same-named repos stay two entries wearing
one word. Protocol
stays **7**: an optional field, absent meaning no project, which an older client ignores.
## `packages/core`

the engines, shipped as **adapters** (`src/engines/`): one `EngineAdapter`
per engine (capability record pinned by identity to protocol's `ENGINE_CAPABILITIES`, a model
catalog versioned with the release, a credential-availability probe, a runner factory), looked
up via `getEngineAdapter`. Three runners behind `Runner` (`src/runner-interface.ts`), which is
what server and queue type against: `SessionRunner` (Claude, over the SDK's `query()`),
`CodexRunner` (`engines/codex/` — the `@openai/codex` binary as an **optional peer**, driven
over its `codex app-server` JSON-RPC surface: one child per *session* held across turns, a
hand-rolled NDJSON client with zero new deps, token streaming, interactive approvals over the
server→client ask channels (granular policy under `experimentalApi`, no fallback — a codex
command approval is an *escalation after a sandbox refusal*, see `docs/GOTCHAS.md` §Codex),
complete child env always — a spawn env *replaces*, never merges; and the `ThreadItem` union in
`engines/codex/types.ts` must cover what the binary emits, because an unmapped item is
**invisible**, not merely unstyled), and `AiSdkRunner`
(provider, over AI SDK v7, built by the host's `createEngineRunner` hook — its adapter is a
pseudo-adapter). The
**model list clients see is shaped here**, not by each UI: catalogs apply
`modelOptionsFromSdk`'s rules (`src/lib/normalize.ts`) at authoring time — no `default` sentinel
row, names derived from resolved ids (`claude-haiku-4-5-20251001` → "Haiku 4.5"), newest of
each family `primary` — and the live `capabilities` event still exists for the in-session
model switcher and slash commands (both truths are load-bearing, see `docs/GOTCHAS.md`).
`src/lib/patch.ts` is where both engines' edit output becomes protocol's one `FilePatch`
(`filePatchFromToolResult` off the Claude SDK's `tool_use_result`, `parseUnifiedDiff` off codex's
`fileChange.diff`), so a client renders one shape with no per-engine branch and no diff parser of
its own. `forwardSubagentText: true` is set on the claude engine's options and is the whole
reason a subagent is visible at all: unset — the SDK's default — the stream carries only a
subagent's `tool_use`/`tool_result` blocks ("enough for a heartbeat counter"), and its brief,
thinking and final report never arrive, so the nested transcript is a list of tool names. Not a
new config field: `extraOptions` is spread last, so a host that wants the quieter stream turns
it back off. Three things were latent behind it and are fixed with it — the reducer's streaming
singleton was **per session** where concurrent agents need **per agent**
(`streaming:<parentToolUseId>`), a subagent's brief is a real non-synthetic `user_message` that
rendered as the human's own `❯` prompt row, and `transcriptActivity` counted every nested row
into the unread badge. No transport. Tool execution rides the
`ToolExecutor` seam (`QuickJsExecutor` in-process, `BrowserBridgeExecutor` to a tab,
`DeferredExecutor` for work outliving the runner); `createToolContext` builds the
capability-scoped tool set with the `sandboxed`/`authoritative` trust split, and
`createEngineSession({ tools })` is where a *host's* own tool joins it **at a stated trust** —
the only way to express a sandboxed (therefore bridgeable) host tool, since `mcpTools` is
authoritative by construction; both contradictions (sandboxed-with-`execute`,
authoritative-without) are refused at assembly rather than discovered at runtime. MCP is handed
over as a **connection**, not a tool set (`connectMcpTools` → `McpConnection.servers`, with
`required: true` to reject a failed connect instead of degrading): a profile declaring a server
that did not connect refuses to build, and `AiSdkRunner.mcpServers()` answers `/sessions/:id/mcp`
with what the host actually assembled — an empty list, never a 501, which is why
`ENGINE_CAPABILITIES.provider.mcpStatus` is now `true`. `park()` →
`RunnerSnapshot` + `restore` are the two halves of rehydration; `snapshot()` is `park()`'s value
without its teardown (one shared private builder — the gate refuses a turn in flight and pending
*in-process* calls, and allows the idle case `park()` exists to refuse), which is what lets a
provider session survive a restart at all, having no engine-side store to resume from.
`start()`'s restore branch schedules **nothing**, and that is load-bearing rather than tidy: an
interrupted turn leaves the history ending on the *user* — the catch path flushes a partial
`assistant_message` for the transcript but never pushes the model's response messages — so a
scheduled turn would pass `#runTurn`'s "already answered" guard and re-run the very turn the
user killed, unprompted, on first attach. Unreachable while `park()` was the only snapshot
source; reachable the moment `snapshot()` existed. And `seedVfs`/`id` are the two
options that make the *other* rehydration rules unmissable — `seedVfs` is ignored on a restore
(seeding over a parked turn's files destroys exactly what was preserved) and `id` is what a
session comes back as itself under. `SubscriberSet` (`src/lib/subscribers.ts`) is the other half and arrived with the seventh
rule: three runners had a byte-identical `subscribe` body *and* a byte-identical fan-out loop,
and a bare `Set<listener>` has nowhere to keep what each subscriber **asked for** — which stops
being tidiness the moment a rule applies to live events too. So a subscriber is a listener plus
its options, delivery is one method, and which rules reach the live path is stated in one place:
`coalesceReplay` is replay-only by construction (live, there is no "later"), `truncateResults` is
replay-only by decision (the head budget already exceeds both clients' display budgets), and
`imageRefs` is **both**. `replaySlice` (`src/lib/replay.ts`) is **the one replay body all three runners deliver
through** — they had a byte-identical copy each, including three copies of the comment carrying
the "never drop the highest-seq event" invariant — and it owns the fourth filter with them:
`truncateResults` hands an oversized `tool_result` block over as its head plus the markers that
say so. Per **block**, so a message answering three calls keeps the small results whole; it
returns the *same object* when nothing is over budget, because an attach is mostly small events;
and it never mutates the stored log, which the live path, the parking snapshot and
`Runner.eventAt` (the optional read side behind `/events/:seq/result`) all read. `subscribe(listener, afterSeq, { coalesceReplay })` is the
third filter on a replay and the only opt-in one, because it is only sound for a consumer whose
handling of those events is last-write-wins: the WS attach is the single caller, while
`parking.ts` — which subscribes from seq 0 — *branches* on `status_changed`, so coalescing for
everyone would silently skip a park. `src/lib/replay.ts` is the backwards scan behind it.
## `packages/sandbox`

untrusted-code boundary: QuickJS-NG WASM guest, in-memory map VFS (not a
node-fs emulation — the tab-side host runs it unpolyfilled), by-value host bridge,
interpreter-enforced limits. Leaf like `protocol`; engine variant injected, so server and
browser share one guest.
## `packages/queue`

`JobQueue` + `QueueAdapter` (in-memory bundled; `claimNext` must stay atomic
and skip future `nextRunAt`). Concurrency, token budgets, webhooks, retries, watchdog, retention.
Jobs are one-shot, but a run that parks frees its slot and stops its duration clock.
## `packages/server`

HTTP + WS gateway (`node:http` + `ws`): session registry, auth hook,
profiles served with their engine's **capability record, static model catalog, and
availability verdict** from the first request (`forResponse`; probes are adapter-run, gated on
`checkCredentials`, ~60s TTL, display-only — only the *default* model is still learned from
sessions, because it is the operator's CLI config),
**plan usage per profile** (`profile-usage.ts` → `ProfileInfo.usage`), because usage had only
ever lived in session transcripts: a session's own reading is refreshed by nothing but a turn,
so one idle since yesterday replays yesterday's number as current, and a session opened today
knows nothing of what a sibling on the same account spent an hour ago. The profile is the
account boundary, so the newest reading across its sessions is the one state worth showing.
Fed by `runner.subscribe` in `onRegister` like `profileDefaultModels`, but **last-write-wins by
the event's own `ts`, never arrival order** (it subscribes from seq 0, so a rebuilt runner's
replayed reading must not clobber a live one), and the **0%-after-reset inference happens at
serve time** — it is a function of the wall clock, and a fabricated `rate_limit` event would be
replayed from transcripts forever and captured into parking snapshots. `inferredReset` keeps
that zero distinguishable from an engine-reported one; absent stays **unknown, never 0%**.
Plus: optional `/jobs` + `/queue` routes, profiles (+ `profileStore` CRUD),
`GET /sessions/:id/files`,
message attachments (`attachments.ts` — bytes held per session so the event log carries only
`MessageAttachment` refs; **never** inline base64 into an event),
`/sessions/:id/events/:seq/result?toolUseId=` (`tool-results.ts` — the other half of a truncating
replay, and **no new store**: the bytes are already in the log, so it reads a live runner's
`eventAt` or a *parked* snapshot's own events, and a dormant record, holding no log, 404s like
`/files` does. `toolUseId` is required and verified against the block, because a woken dormant
session has fresh seqs and a cached one can name a different call),
`/sessions/:id/project/icon` (`project-icon.ts` + `services/project-info.ts` — the bytes behind
`ProjectInfo`'s image arm, and the **discovery** that produced it: an ancestor walk from the
realpath'd cwd, TTL-cached per cwd so it never runs per row of a 1.2s poll, degrading to the
folder basename for a missing, malformed or oversized file and *continuing the walk* past a
broken one — a bad `.workerdeck.json` in `packages/ui` must not shadow the repo root's good one.
Stamped at **serve time**, never persisted, which is `profile-usage`'s placement argument again:
parking and dormant records need no migration and an edited file reaches every session within
the TTL. The route takes **no client input at all** beyond the session id — it serves whatever
the gateway's own discovery resolved — so `"icon": "../../../../etc/key.png"` and a planted
symlink die on the same single check: resolve against the root, `realpath` the result *whole*,
then `contained()` from `host-files.ts`, which is reused deliberately where `cwdAllowed` is not
(see `docs/GOTCHAS.md` §Host filesystem). Every refusal is the same 404 as "no icon declared",
because distinguishing them says *why* a path outside the root was refused; scope rides the
existing `/sessions/:id/*` gate rather than a second policy that could drift, and a
project-keyed route was rejected outright — its URL would be a host path, i.e. an existence
oracle for the gateway's filesystem),
`/sessions/:id/produced[/:fileId]` (`produced-files.ts` — host files the *engine* wrote, served
with **no roots and no byte cap** because the allowlist is built solely from `file_produced`
events; a path the *agent* named is not a produced file and stays behind `/fs/*`)
and `/sessions/:id/mcp`
(status + reconnect/enable/disable, with each server's `env`/`headers` stripped),
the host-filesystem routes (`/fs/*`, `host-files.ts` + `host-file-search.ts` — operator
privilege; reads follow `allowedCwdRoots` and `hostFiles.roots` only narrows, writes opt in
separately; realpath-based containment and uniform-404 disclosure, so **do not** reuse
`cwdAllowed` there — see `docs/GOTCHAS.md` §Host filesystem),
capability-record request gating (`checkEngineGrants` 400s what the engine's record forswears;
`stripInertFields` drops `questionBehavior` where no approval channel exists),
`SessionNotifier` (`notifications.ts`) — server-wide session webhooks for the four
human-attention moments, subscribed through `SessionRegistry`'s `onRegister` so a rebuilt
parked session is covered too; transport-agnostic on purpose (no push credentials here),
**session scope** — `CreateSessionRequest.scope`, opaque string tags assigned at create,
immutable after, echoed on `SessionInfo`, and the only intra-deployment scoping primitive there
is. The split is the design: WorkerDeck stores and *enforces* the tags, the embedder's
`authorizeSession(principal, session)` decides what they *mean* — "space" and "user" are one
app's vocabulary and the next has tenants. The predicate is **synchronous on purpose** (it runs
per route and per row of every list; an expensive lookup belongs in `authenticate` and lands on
the principal), the default rule is "every key the principal pins must match" with an unset
principal scope unrestricted (`allowedProfiles`' precedent, so the operator's dashboard is
untouched), and a miss is **404, never 403**. Enforced at the `/sessions/:id/*` gate, the list,
the WS attach *before* the wake (waking rebuilds a runner and reconnects MCP — not for someone
about to get a 404), `POST /executions/:id/result`, and the job routes via `JobInfo.scope`; the
operator surfaces (`/fs/*`, `/sdk-sessions`, `/queue`, `/queue/ws`) are refused outright to a
scoped principal, because they answer about the *gateway* and there is nothing to filter. Two
guards keep it honest: `buildRunnerConfig` re-stamps the scope over the host hook's output, and
`buildRunner` — the one chokepoint for create, dormant rebuild and parked rebuild — asserts the
runner echoes it, because a runner that dropped it would be invisible to every check and
therefore visible to everyone. **Visibility is full control**, not a read level: an attach can
send `user_message`, `permission_decision`, `interrupt` and `close`. `sandboxedProviderProfile()`
is the other half — a provider profile with `capabilities: []` and `mcpServers: []` (empty
arrays, never absent, which would grant whatever the host wired), and `EngineCapabilities.hostCwd`
is what makes `cwd` optional for it: `allowedCwdRoots` is not the boundary for a filesystem-less
engine and must not be mistaken for one.
`SessionParkManager` (`parking.ts`) owning **both** ways a session outlives its runner, over the
one `SessionStore` seam (`session-store.ts`: memory + JSON-file, the file one durable across
restarts). **Parking** is deferred execution's other half and needs `Runner.park()` — which only
the provider engine has, because claude and codex run behind a binary that owns its process
state. **Dormancy** is the restart story for those two: a `DormantSessionRecord` holds no
transcript at all, just the id, the `sdkSessionId` to resume from and the config to rebuild
with, written continuously (off `system_init` + status changes, never a shutdown hook — a
`kill -9` doesn't run one) and woken **lazily on first attach**, because respawning every
session at boot is a fork bomb. **Write-through** (`parking.persistLive`, off by default — a
library must not start writing transcripts to disk because someone upgraded) is the third, and
the restart story for the engine dormancy cannot cover: a provider session has no engine store
to resume from, so its record carries the state itself, taken with `snapshot()` on
`turn_result`/`model_changed`/`permission_mode_changed` and rebuilt lazily on first attach like
a dormant one. Between them every engine survives a restart. Four things
hold it together and each is a bug if dropped: `listInfo` hides a record whose id the registry
has (or every live session lists twice), the `session_closed` discard is skipped while
`#closed` (the registry closes runners with the same 'server' reason a DELETE gives, so a
graceful shutdown would forget exactly what it was preserving), waking one feeds its config
back through `buildRunnerConfig` rather than using it as-is — `env` is never persisted, so the
profile's `CLAUDE_CONFIG_DIR` pin has to be re-derived — and a **`live` record is refreshed in
place on wake, never consumed** the way a park's is. That last one is a `kind` on the shared
`ParkedSessionRecord` rather than a new type (every other branch — rebuild, serve `vfs`, arm
`executions`, subscribe past `snapshot.seq` — is already right for both, and an older server
parses it down the parked arm, so a downgrade degrades instead of losing the file), and it is a
correctness difference: consuming it opens a window from the attach to the next turn in which
the session exists nowhere durable, so someone who opens a session, reads it and types nothing
loses it to a redeploy with no error and no trace. The write is also deliberately **not**
synchronous in the listener — `turn_result` is emitted before the turn's `finally` clears the
abort controller, so a direct `snapshot()` would see a turn in flight and refuse every time,
silently; `#queue`'s microtask hop is what puts it after. Imports no model
SDK — a provider profile is built by the host's `createEngineRunner` hook; claude and codex
profiles go through core's adapters. A Claude profile pins
`CLAUDE_CONFIG_DIR` *except* when that would be a no-op — setting it at all moves the CLI off the
macOS Keychain, so pinning the default dir breaks a working login (`docs/GOTCHAS.md`). A codex
profile's `codexHome` pin has no such trap (the auth store is chosen by config *inside* the
home) and is applied by the runner, not `buildRunnerConfig`, because codex replaces the child
env wholesale. `checkCredentials` probes each profile at launch and on a ~60s TTL, and the
verdicts serve `GET /profiles` as `available`/`unavailableReason` — display-only by design,
because a stale probe must not become an outage; `requireAvailableProfile` is the opposite
trade for a deployment with an *end user* in front of it (503 on create with the probe's
reason, and only on a definite `false` — unprobed stays allowed). `createProviderRunner(ctx,
opts)` is the 80% case of `createEngineRunner`: it forwards `restore`, adopts `id`, seeds the
VFS only when not restoring, and disposes via `onClose` — the four obligations that are
invisible in the hook's types and fail only at runtime. Its `executor` is **required**
(`ToolExecutor` or `'browser'`): defaulting it would make `@jitl/quickjs-*` a server dependency
and would silently answer an architectural question the embedder should be asked.
## `packages/client`

REST + WS client on platform `fetch`/`WebSocket`; zero runtime deps. Owns
the WS frame surface, so new frames need `SessionHandle` methods/events here. A refused REST
call throws `WorkerDeckError` (an `Error` subclass carrying `status`), which is what lets a
caller tell "this server has no such route" (404 — stop asking) from "that file was too big".
`AttachOptions.truncateResults` + `client.toolResult(...)` are the client half of the truncating
replay, and the default is off **on purpose and permanently**: only the unit that renders may ask
for heads, since a caller that cannot fetch them back would present one as the whole result.
`buildWsUrl` took an optional third parameter rather than becoming an options object, so every
existing implementation still typechecks — and a custom one that ignores it merely gets a full
replay, which is safe because every client keys its rendering off the server's own marker and
never off what it asked for.
`projectIcon(sessionId)` is the third blob-returning method beside `readProducedFile` and
`toolResultImage`, and the one whose existence a client settled rather than convenience: a VS
Code webview has **no external `connect-src` at all**, so it cannot point an `<img src>` at a
gateway even in principle and the bytes must ride the bridged fetch. Cache by
`ProjectIcon.image.hash`, never by session — that is what the hash is on the wire for.
It also owns `apiUrl`/`isLoopbackHost` (`src/host-url.ts`): what an operator types turned into
a `baseUrl`, and whether that gateway is this machine — decided from the URL, never by probing
paths. Here because every host that lets someone type a gateway address must normalize it
identically, or the same gateway saved twice is two gateways.
## `packages/react`

headless: `useClaudeSession`, the pure transcript reducer
(`src/lib/transcript.ts`, framework-free, unit-tested — keep rendering out), the two halves of
**opening a session without flicker** (the ask was "no travel, no flash, no visible DOM
append", and scroll position was never the problem — the attach replays hundreds of rows in
bursts and you watch them stream past a correctly-pinned viewport): `replaying`, a hold on the
exact signal that `AttachedFrame` arrives *before* the replayed events and names the seq they
end on — never a quiet-window heuristic, which is what the deleted `useSettled` was — bounded
by a backstop because a blank panel forever beats no fix at all; and `src/lib/transcript-cache.ts`,
a bounded LRU of `TranscriptState` keyed by *(gateway identity, session id)* so a switch-back
attaches with `afterSeq` and replays only the gap. That cache's whole risk is `staleAttach`: a
seq from a *different* log (a dormant rebuild starts at 0) delivers **nothing**, leaving stale
rows standing with no error — which was already reachable on a plain reconnect after a restart,
so the check fixes more than it costs. The two halves of **on-demand tool results** (`result.truncated`/`totalChars`/`sourceSeq`, set
only when the replay cut something, so every other item stays byte-identical — which matters on
iOS, where `ToolCallItem` is `Equatable` and half the plan-cache key; and `hydrateToolResult`,
which puts the fetched text into **transcript state** rather than row-local state, so the copy
button copies the whole thing, the cache retains it, and no later event can re-truncate it —
clearing the markers, so a hydrated result is indistinguishable from one never cut and every
renderer needs one branch, not two). `loadFullResult` on the hook is the press's other end, and
the *only* place the truncation opt-in is issued. The recap counters
behind catch-up (`src/lib/recap.ts`: `summarizeSince` + `recapLine` — **counted, never written**;
a prose recap would spend a turn on a summary nobody asked for, and would be worst in the
case that matters most, a session that failed unattended), the composer's two
companions (`useAttachments` — staging + upload, filtered by the capability record;
`useHostFileSearch` — `@file` search rooted at the session cwd, self-disabling on a 404), the
workspace's headless half (`useHostFileTree` + the pure `flattenHostTree`; `useOpenFiles` + the
pure `openFilesReducer`, which keeps `content` (disk) and `draft` (edits) apart and carries each
tab's `hash`, because `/fs/write` is conditional *always* — a 409 is a **choice** to offer
(reload / keep mine / dismiss), never a message, and nothing but `revert` and an explicit reload
may discard a draft; `useHostFileRoots` for `canWrite`, which is a *separate* server opt-in from
reading and defaults off; `useSessionInfo`, one REST record — never a second `useClaudeSession`,
see the bridge rule below; `useProjectIcons`, project icon bytes as object URLs keyed by the
icon's own **content hash** — module-scope and cached for the life of the page, because a hash
names its bytes: an entry can never go stale (an edited icon arrives as a new key), twelve rows of
one repo cost one request, and two gateways serving the same repo cost one between them. Failures
are cached too, the route's 404 being the uniform "no icon" that would otherwise be re-asked every
poll; object URLs are never revoked, which is the same decision stated twice — they *are* the
cache. The VS Code extension keeps its own copy of this three-set structure
(`src/project-icons.ts`) and cannot share this one: its webview has no external `connect-src`, so
its bytes arrive as data URLs pushed from the extension host — one design, two implementations,
for a reason that lives in the transport. `useProfileUsage`, the plan's windows as the *gateway* knows them,
a **poll** because nothing pushes them — a session's own `rate_limit` readings land only at a
turn's edges, so an idle session's meters age silently and a sibling session's spend never
reaches them at all), the
other pure helpers that both clients must agree on (`rateLimitWindows`, `scanPromptTokens` —
the mirror of the Swift `PromptTokens`), and the browser tool host (`tool-host.ts`) running
server-bridged calls in the tab. Companions must ride the hook's own `handle` — the bridge asks
the first attached client, so a second handle sees nothing. `TranscriptState.capabilities` is
always populated, and is what every surface renders from (see `docs/GOTCHAS.md`).
## `packages/ui`

styled layer (Tailwind v4 + `@base-ui/react` + cva): `src/components/ui`
primitives, `src/components/agent` components, vendored prompt-area composer (MIT). Ships source
styles (`theme.css` + `@source`-scanned classnames; wiring in its README). `SessionPanel` is the
whole session surface — transcript, composer (attachments, `/` and `@` completion), and the
panels behind its status bar and `⋯` menu (session info, context, plan usage, MCP, project
files) — each gated on the capability record, so one component is correct for every engine.
`panelSurface: 'external'` hands that dialog surface to the embedder: no dialogs, no `⋯`
menu, intents via `onOpenPanel`, live readings via `onVitals` (what lets external chrome
render context/usage without a second attach — the tool bridge asks the first attached
client). `statusSurface: 'external'` is the *separate* opt-out for the bar itself, for an
embedder whose chrome already has a status line (VS Code's window bar); it carries the `⋯`
menu's only home, so combining it with `panelSurface: 'internal'` needs a **function**
`header` to take the menu. `controlsSurface: 'external'` is the third: model and permission mode leave the composer
(which then collapses to a single growing line, attach/send beside the field) for the
embedder's chrome — the *options* ride `SessionVitals` (`models`, `permissionModes`, already
filtered by the capability record and the bypass grant) and the setters come back through
`onControls`, because the panel owns the session's one attach and nothing else may open a
second. `'status'` is the same trade for a host that has no chrome to put them in: the pickers
move into the panel's **own** status bar, at the end of the readings cluster (status → context
→ usage → model → mode) so what you can *change* sits beside the facts it acts on, and the
composer collapses the same way. With `statusSurface: 'external'` there is no bar to hold them,
so that combination falls back to the composer rather than hiding them.
The **fetch-the-rest press** is in both themes (`items.tsx` and `ToolCallCard.tsx`, so the
dashboard, the VS Code webview and `apps/embedded` all have it) and rides
`ToolResultFetchProvider`, a context whose default is a no-op returning `false` — correct for the
playground and any hand-composed row, since nothing truncates a replay nobody asked for. Only
`SessionPanel` supplies a real one, because it owns the session's one attach.
`collapsedResult` takes `totalChars` for the reason the module exists at all: computed from the
head the row would say "+7,600 chars" where the truth is 641,003, and the wrong string is a
different pixel height. `toolHost` is the
escape hatch for the panel's own browser tool host — options through to `useToolCallHost`, or
`false` for none — because the panel owns the session's one attach, so an embedder subscribing
separately would find this host already refusing anything outside its allow-list.
`readOnly` is the fourth and the bluntest: no composer and no approval prompts, for a
surface that is *about* a run rather than in it (the dashboard's job detail, where typing
would be a second operator arriving mid-run). Absent, not disabled — a greyed-out composer
says the session is busy, an absent one says this screen does not drive it — and **not an
authorization boundary**: it removes the affordance, the gateway does the enforcing.
`reveal={{ toolUseId, nonce }}` is the seam a *list* needs: sub-agent work is nested inside the
`Task` row that spawned it, so "open that sub-agent" can only mean "take me to its row". A prop
rather than a ref (the shape `jumpToRecapRef` uses) because the asker is outside the webview and
the request travels as data; **nonce-keyed**, because asking twice for the same agent is two
requests and an identical prop is a no-op; and resolved through `rowIndexForItem`, which is what
makes a nested child's id land on the folded row that absorbed it rather than on a position.
`transcriptVariant: 'terminal'` is the **terminal theme** (`src/components/terminal/`, geometry
and palette in `src/styles/terminal.css`) and it is a *renderer*, not a set of branches: it
draws every row itself and the shell mounts it **instead of** the components under
`components/agent/`, so nothing in there asks which variant it is in — if it is drawing, it is
drawing cards. Two rules hold the whole thing
up — horizontal measures are `ch` (one cell) and vertical measures are whole multiples of
`--term-line`, both of which must be whole pixels — and everything is built from three
primitives: `Row` (gutter cell + body cell, which is what gives every wrap its hanging indent),
`Blank` (one empty line, the theme's only spacing) and `Band` (a full-bleed wash). Markdown goes
through Streamdown with a **component map** rather than the sixty `!important` overrides the
retired `lines` variant needed,
`TerminalDiff` renders protocol's `FilePatch` with the engine's own line numbers (and
without a number column when the hunks start at 0 — an approval, where the edit has not
happened), and the prompts are the CLI's: one question at a time behind a chip strip, ending in
a review step, answerable entirely from the keyboard. A **run of consecutive tool calls folds
into one row** (`terminalBlocks` + `ToolRunRow`, wording in `tool-run.ts`) reading `Ran 6 tools ·
3 roam-code, 2 shell, 1 read` — or `Ran N shell commands` when the run is all shell, which is the
commonest run and was already the sentence people read. The CLI's own
compression: the calls are almost never what you came back to read, and six of them bury the
sentence that is. It was **shell-only**, and the cost of that showed up against a real session —
a run alternating `Bash` with an MCP tool folded into *four* rows, a count for every gap it could
not group, which is worse than not folding. The grouping rule was right and the membership rule
was too narrow.
*Consecutive* is the entire rule — anything the model said between two calls
breaks the run, because that sentence is the reason the second one happened — and the recap
boundary breaks it too, so a count never spans "what you already read"; `parentToolUseId` is the
one addition the wider rule needs, since a subagent's calls are drawn stepped in behind a rule and
must not be counted with a top-level one. A **failure does not break a run** — fragmenting it
around one hides the failure in a longer list rather than surfacing it — but only the run's
**last** call colours it (`runFailed`). A failure the model recovered from two calls later is how
work goes, and reddening the whole run for it paints a normal working session red, spending the
colour that should have been left for the one thing still broken; the last call is the run's
*outcome*, and an outcome is what a collapsed row can honestly claim. **If it is red in the
transcript, it is red on the rail** — one sentence, applied to a fold, and a rule the scrubber
was once exempt from: its question ("is
there anything in here worth navigating to") was held to differ from the row's ("how did this
end"), so it marked *every* failed call at 55%. Measured against a real session the exemption
did not survive — 178 tool calls, 9 failed, **8 of the 9 recovered from inside their own run**,
no failed turn and no session error, so the rail showed nine alarms for a transcript that
reddens one row, and a red mark beside nothing red sends a reader hunting for damage that is not
there. One uniform test replaces it and needs no block lookup, only `rowIndexFor`: a call is its
row's **outcome** when it is top level and no later top-level call shares its row — which is
`runFailed`'s last member for a folded run, the call itself for a lone one, and, because
children are not top level, `taskFailed` for a `Task`, the same rule spelled a third way and
agreeing. That fixed the noise and broke the other half — open a run of eight whose failures are
mid-chain and one is visibly red on its own line with nothing beside it on the rail — so the rule
is now **fold-aware** (`redItemIndices`): collapsed, a run draws one summary line and only its
outcome can be red, so only the outcome marks; **open**, every member is planned through
`planToolCall` and every failed one marks, at its own fraction of the row. A `Task` is the same
shape twice over — its header is `taskFailed` (its **own** result, never a child's) whatever it
does, and a failed child marks only once the *run inside it* is also open, because an open task
still draws its children as a folded run. This is the one rail rule that **reads `expansion`
rather than measuring the book**: a mark's extent and fraction follow from a height, but its
*existence* does not. Beside it, `expanded` is a fifth mark and the quietest thing on the rail —
a **yellow** band in the **left** lane over any block you opened, because opening is something
*you* did, and it loses every merge so an opened `Task` keeps its green. Yellow because the
opened rows themselves now carry a yellow wash (`--term-open-wash`, `uiOpenWash`), which is the
theme's **one deliberate reuse of that tone for something other than "waiting on you"**: an open
block is a state the reader put the transcript into, and the rail and the region should say that
in one colour. Kept very low (0.10 dark / 0.25 light) because it washes whole regions — at band
strength an opened run shouts louder than anything inside it. The wash crosses to `packages/ui`;
the rail mark cannot, for the `height.ts` reason below. Nothing is concealed either
way — each failure is still red on its own row, and the recap still counts every one.
**`packages/ui` has the collapsed half only, and cannot have the rest**: its expansion is
component-local `useState` per row, which is exactly what lets `height.ts` need *no expanded
branch* (an unmounted row is collapsed by definition). Lifting it to feed the rail would cost
that invariant, so the two clients share the rule and differ in how much of it they can see —
stated here rather than discovered. The same fold, one level up: **a `Task` and everything the subagent
produced is one row** (`blocks.ts`'s `TaskBlock`, `TaskRow`, wording in `tool-run.ts`), reading
`Task(Explore · permission mode parsing) · 7 tools`. A subagent is sixty rows of somebody else's
working and none of it is what you came back to read — the report is the model's next sentence.
It is **grouped by `parentToolUseId`, never by adjacency**, because parallel Tasks interleave in
the stream; that is what broke the old row-model contract, where a row covered a contiguous
`[index, index + len)` and now covers a *membership* — read `rowIndexForItem`'s contract before
touching anything positional, since an absorbed index resolves to its task's row and every jump
(scrubber mark, recap, bookmark) goes through it. **Always collapsed when unmounted** is
load-bearing rather than tidy: `height.ts` sizes the row as one wrapped `taskSummary`, so the
live signal is *in* the collapsed line (the pulse, a climbing count), never an auto-expansion.
A childless Task stays a plain call, and an **orphan child** — parent outside the slice, which is
what a recap boundary and a compaction leave — keeps its own stepped-in row rather than vanishing
into a block above the seam. **None of it renders without
`forwardSubagentText`** (see `packages/core`): a nested transcript built on the SDK's default
stream is a list of tool names. `terminalBlocks` is the
one implementation of it: the virtualized shell folds each side of the boundary through the same
function the plain `TerminalTranscript` calls, and it is what the virtualizer counts, so a run is
one measured row rather than N. The summary string lives in `tool-run.ts` and the collapsed result
preview in `result-preview.ts` for the same reason: `height.ts` wraps **those exact strings** to
predict the row's height with no DOM, so two spellings would be two different heights. Expanding is the theme's one piece of state and it has three
parts, each of which is a bug when dropped: a press is a **`Pressable`, never a `<button>`**
(`press.tsx`) — a drag that selects text out of a row ends in a `click`, so the row you were
highlighting collapses and takes the selection with it; the press is refused when the pointer
travelled or a selection stands inside it. The opened block keeps a full-bleed wash (`.term-open`)
so eighty new rows read as one block. And `useRevealOnOpen` brings its **first line** back when
the expansion pushed it above the fold — one-directional, and only on the open transition, so a
block already in view never moves. A tool result opens **clipped to a character budget** with the
rest one press away, and that is a DOM guard rather than a preference: the whole of a
hundred-thousand-character result lands in *one* virtual row, and the virtualizer mounts rows, so
it cannot help with what is inside a single one. The **collapsed** row is clipped by
`result-preview.ts` and has **two budgets, four lines and ~400 characters**, because lines alone
had an exact blind spot: a minified JSON reply — which is every MCP tool's reply — is *one* line,
so a four-line slice kept all thirty thousand characters of it, `lines.length - shown.length` came
out zero, and the row did not even offer the `+N` affordance. It reports characters when it cut
inside a line and lines otherwise, since "+0 lines" under a visibly truncated row is worse than
silence. That was the single biggest source of transcript verbosity, ahead of row count.
The open-state guard remains what it was: the whole of a
hundred-thousand-character result lands in *one* virtual row, and the virtualizer mounts rows, so
it cannot help with what is inside a single one.
**Row heights are computed, not estimated** (`terminal/height.ts`): one line height and one cell
make a row's height derivable from its item, so `estimateSize` is exact and the scrollbar stops
growing as rows mount. Measured 99–100% pixel-exact on real content; the calculator returns
`{px, exact}` and *flags* what it cannot know (CJK and other non-`1ch` advances, a table
compressed below `max-content`), which is the design — a flagged row self-corrects on mount.
Three invariants: it needs **no expanded branch** (expansion is component-local and resets on
unmount, so every unmounted row is collapsed by definition); the cache is a
`WeakMap<TranscriptItem, …>` per (width, cell) **epoch**, which self-invalidates because the
reducer replaces item objects on every mutation — streaming, results and patches all miss
naturally, with no version counter; and the epoch is rebuilt from a debounced `ResizeObserver`
on the **content** element, never the scroller (`ConversationContent` caps at 48rem, so the
panel resizes without the wrap width moving). `estimateSize` reaches terminal only — cards vary
too much for any constant to be right and the calculator has no claim there. `dev/height-audit.ts`
is the regression test and it measures against real browser layout, which is the only thing that
can check this: jsdom has no text layout, so a unit test would check the calculator against its
author's assumptions. The one genuinely unit-testable piece is `textLines`.
`scrubber` is the **overview ruler** (`terminal/scrubber.tsx`), VS Code's strip rather than its
minimap: a **12px** rail replacing the scrollbar and **two 6px lanes that are channels, not
classes** — left is what went *in* (your prompts, and **the sub-agents you dispatched**, green),
right is what came *out* (each turn's answer and its turn end as **one** merged mark, and
**everything that went wrong producing one**: a session error, a failed tool call, a failed
turn). That is the question a reader asks of a rail — "where did I say something", "where did
it go wrong" — and it is why the failures were taken *out* of the full-width class they used to
share: "alarm" is not a lane, and half the failures sitting down the middle while `turnFailed`
sat in the right lane meant no single column answered the second question. Full width is left
for what is not a channel at all: a waiting approval pinned at the foot, `scrubberMarks`
bookmarks, the recap seam. The sub-agent band is drawn from **membership, never the spawning
call's name** (`Task` is the SDK's convention and a background agent arrives as `Agent`; an id
other items nest under *is* a sub-agent), it is the folded `Task` row's one honest signal on the
rail — collapsed a tick, expanded the band the sub-agent covers — and a failed dispatch earns
**both** marks, one per channel: green says a sub-agent ran here, red says it came back broken.
The tool failure is the one that
is *routine* (a grep that matched nothing, a build fixed on the second go), which is why it
alone is drawn at 55% rather than solid and sits under `turnFailed` in `LOUDNESS`: at full
strength a normal working session paints the rail red and the two errors that actually ended
something stop standing out. Its predicate is `status === 'failed' || result?.isError` — the
same disjunction the row reddens with and the recap counts by, and both spellings are needed
(an out-of-loop execution failure sets only the status; an engine can flag `is_error` on a
call the reducer has not settled). A mark is its row's extent at rail
scale (2px floor), drawn as a solid 2px head with a 25% tail — **except an item that shares its
row**, which is a 2px tick at `ordinal / count` of the row's measured height
(`positionInRow`/`RowPosition`, mirrored in `TerminalRows.position(forItem:)`). A row covers a
membership, so a task block's absorbed child and a folded run's member inherit an extent that is
mostly other items' work: expanded, one failed child of a hundred-call task painted a solid band
down the whole rail. `sizeOfRow` is the *measurement*, so expansion is reflected without the
scrubber learning expansion state — collapsed the fraction rounds onto the row's one line and
siblings merge as before. A **singleton run keeps its extent**, which is the load-bearing
carve-out: the fold makes every top-level tool call a run of one, and shrinking those would stop
the rail reading as a map. The fraction is deliberately approximate on iOS too, where the height
book could give a child's true offset — one rule, two implementations. Marks merge under a pixel with
the loudest colour winning, and a 2px full-width cursor line rides the viewport's top edge. The
12px is the one deliberate exception to the theme's `ch` rule: the rail is chrome beside the
grid, and its lanes are hit targets rather than columns of text. Rail scale is `railScale()`
and its denominator is **`max(totalSize, viewportH)`, never `totalSize`** — the rail is
absolutely positioned *inside the scroller*, so anything overflowing it becomes real scrollable
height. A transcript shorter than its window is what proves it: 90px of content in a 906px
viewport made `railH / totalSize` ≈ 10 and a 9120px band inside a 906px rail, hanging ~8000px
of empty scroll under a three-row session. Clamped, the rail represents the *viewport* when
everything fits (the band fills it exactly), and `bandH` can never exceed `railH` for any
content. Hover peeks, click jumps, drag scrubs. Peeks render from `state.items`
and **never the DOM** — the row they describe is usually unmounted. Positions come from the
virtualizer's own offsets, which are only trustworthy *because* the calculator feeds
`estimateSize`; that is also what answered whether the rail could be a real draggable scrollbar
(it can). Two traps it is built around: a mark's item index is **not** its virtual row index
(`terminalBlocks` folds shell runs and the recap splices a row, so `scrollToIndex(itemIndex)` is
wrong by construction — go through `rowIndexForItem`), and a jump is `jumpToRow`, the generalized
form of the recap re-aim loop, not a second copy of it. Under `affordances={false}` the marks stay
painted but inert **and the native scrollbar returns** — never leave a reader with no way to
scroll. `stickyPrompt` holds the **first line** of the prompt of the turn you are reading at the
top of the scroller, the CLI's own affordance — one line and not the row, because a pasted
twenty-line prompt pinned whole covers the very answer being read. The pin is the browser's:
each prompt renders inside a **lane** (`StickyPromptLane`, an absolutely positioned strip
spanning its turn, positioned with `top` — `position: sticky` resolves at layout time and a
transform is paint-only) led by a one-line `sticky` **head**: the same row rendered again,
height-clipped, flow footprint cancelled, laid exactly over the real row's first line — a
duplicate, but the earlier rejection was of a *separate header* with its own padding and
gutter; this copy is the same component in the same column and aligns by construction. It is
`visibility: hidden` until a sentinel `IntersectionObserver` marks it stuck (an overlay visible
in flow swallows the first line's selection highlight), pointer-transparent and `aria-hidden`
throughout — the real row owns interaction — and the compositor does pin and push-off, so no
per-scroll JS (a JS-written pin trails the compositor and wobbles). The active prompt's lane is
kept mounted far above the window — exactly when it is working — through the virtualizer's
`rangeExtractor`, whose forced index is computed *inside* the callback from the live offset
(a render-fed ref is one scroll event stale). One measurement invariant nearby: the height
epoch's `virtualizer.measure()` wipe must re-feed mounted rows via `resizeItem` (after a
measurement read rebuilds the array) or a row whose height survived a width change keeps its
estimate forever and the transcript grows a phantom scrollable tail. `affordances` is the seam for what a real
terminal *cannot* do (hover fill, hover-revealed copy) and every one of them costs no layout, so
`false` is the pure article rather than a degraded mode. `terminalMetrics` is the cell, in whole
pixels, and it is **one** prop because the panel mounts **three** terminal surfaces — transcript,
pending prompts, composer — each in a different part of its flex column; hand two of them
different numbers and the caret lands on a different column from the text above it, which is the
failure the theme exists to prevent. The **composer** is the CLI's prompt under it, docked flush
to the panel edges with characters in place of the round pills. Its **gutter cell** — the one
every transcript marker sits in — holds `+` to attach, which becomes `✕` (yellow, Interrupt)
**whenever the session is working**; `↵` sits alone at the trailing edge and therefore means one
thing at all times. The busy test is `busy` alone, not `busy && !canSend`: while stop and send
shared the trailing slot, typing a follow-up mid-run replaced stop with send and left no way to
stop at all. `✕` rather than a `■`, because the square read as a *state* in a column where `●`
and `◆` really are states; it is also one of the few candidates measuring exactly 1ch in
JetBrains Mono, where `⏹`/`⏸`/`⏻` are 1.05–1.31 cells and would break the grid. With nothing to
attach the cell falls back to `❯` (`PROMPT_GLYPH`, the same constant the user rows draw — two
spellings would put the caret a glyph off the column, and it is **blue**, because coral is the
*working* mark and a prompt waiting for you is not the session working), so the column is never
empty and the typed line never shifts. A glyph *in* that cell carries `data-gutter`, which
aligns it `start` like a marker: `term-glyph`'s centring is right for the trailing `↵` and wrong
here, landing the glyph half a cell (≈3.9px) right of the column every `❯` and `●` sits on. The
field is a **contentEditable in markdown mode**, so typing `- ` builds a real `<ul><li>` — editor
DOM that none of `.term-md`'s rules reach, which left it drawing the browser's `•` and the
browser's list margins, the second of which took the typed row off `--term-line`. Its lists are
therefore styled separately and to the same numbers (`- ` at 2ch, `1. ` at 3ch, hanging indent,
markers as `::before` so nothing enters the message and `html-to-markdown.ts` still serializes
the real `<li>`s). Staged **attachments** ride above it as squared 1px cells with the `✕` tucked
*inside* each one's top-right corner (two rules, no badge hanging off an edge), and the strip
draws no rule of its own — the composer's own frame is directly beneath it, and two rules a few
pixels apart is the box this theme exists not to have. It is bracketed by **two rules**, top and bottom, both
turning accent on focus, with 8px of air inside them — the CLI's own frame for its prompt, and
the thing that makes the field its own strip of the panel rather than the transcript's last row,
without a side border that would take the `❯` off the column. The bottom rule is why
`StatusBar` draws no `border-t` under this variant: two adjacent 1px rules is a 2px rule with a
seam in it. It lives
in `Composer.tsx` keyed on the panel-wide variant context — it had been CSS overrides in the VS
Code webview, which meant only that one host had it. `packages/ui/dev/` is its playground —
fixtures, a character-cell overlay and `grid-audit.ts`, which asserts every row starts on and
spans a whole multiple of the line; it is dev-only and unpublished (`files` is `build` + `src`).
`transcriptVariant` is otherwise the fifth, independent seam: `'cards'`
(the chat convention) or `'terminal'`. It rides a **context**
(`transcript-variant.tsx`), not a prop chain, because the pieces that need it sit *outside* the
transcript — the composer and the pending prompts, which are line items of the same run — and
because a row component composed by hand gets the right treatment too.
`transcriptDensity` is the sixth seam and rides its own
context beside it — `'comfortable'` (default: one blank line between rows, what the Claude
Code CLI leaves) or `'compact'`. Separate from the variant on purpose: the variant follows
from the *surface*, density is the reader's *preference*. It reaches **`cards` only**: a
terminal has one line height, which is the premise, so its spacing is a blank *line* decided
per pair of blocks by `needsBlank`. `ROW_GAP` in `transcript-variant.tsx` is the whole feature — the
gap goes on the virtualizer's **measured** wrapper, so no pixel constant is load-bearing and
only `estimateSize` takes the `px` (scrollbar length before rows mount, replaced by a real
measurement the moment one does). VS Code exposes it as `workerdeck.transcriptDensity`,
stamped on `#root` like the font because it decides every row's height (`transcriptVariant`
is stamped beside it, along with the cell and the affordances flag — the dock defaults to
`terminal`, but it is a setting, not a
hardcode). `transcriptFont` is the seventh seam and the one with **no JS at all**:
`'sans'`/`'mono'`, one `data-agent-font` attribute on the panel root, and a rule in
`theme.css` repointing `--cw-font-sans` at the mono stack for that subtree. A subtree rule
rather than `:root` is the whole claim — a monospace agent view inside an ordinary app, so
a host's sidebars and dialogs cannot pick it up. It too is **`cards` only**: the terminal
theme is monospace by construction and takes its face from `--cw-font-mono` (which the VS Code
webview repoints at the editor font, unconditionally, for exactly that reason). Clients that
offer density and font as settings must say they are Cards-only or hide them — the dashboard
hides them, the extension documents them. The working marker is
the **brand mark's own pulse** (`pulse.tsx`: `⋄ ◇ ◈ ◆` at 150ms = the 0.6s clock in
`icon-loading.svg`), shared by the transcript's working row and each running tool row's gutter
glyph so they beat together; it rests on `◆` under `prefers-reduced-motion`, free because the
last frame *is* the mark. BRAND.md's ambiguous-width caveat is why this is webview-only: the
gutter cell centres the glyph in a fixed box, a real terminal must use the ASCII set. The
tool row has no right-edge `Spinner` — two spinners on one row is one too many. The transcript is **virtualized**
(`@tanstack/react-virtual`), and the rule that keeps it honest is that two parties want to
write `scrollTop`: `use-stick-to-bottom`'s follow spring and the virtualizer's size-change
correction. They are split by regime — **pinned, corrections are suppressed** (being at the
bottom is the whole scroll position, and a correction moving the viewport up reads as a user
scroll and breaks the lock); escaped, the virtualizer corrects so the scrollback holds still
under the reader. `anchorTo`/`followOnAppend` stay at their defaults so it never becomes a
second follow implementation. Two knock-ons: the catch-up "jump" is a closure the transcript
fills in (`jumpToRecapRef`) rather than a DOM query, because the recap row is usually
unmounted, and it must *re-aim* as the rows it crosses measure; and the card gap lives in each
row's padding, since flex `gap` cannot reach absolutely positioned children.
`SessionVitals` carries `connection` precisely so an external bar
can obey the panel's own rule — a session status held over a dropped socket is a stale
reading, and the link state has to win the slot. The VS Code extension is the reference
consumer of both. Pure formatters ship from a third entry (`@workerdeck/ui/format`) so a
non-React host spells `45.2k` and `2h 10m` the same way the panel does, without pulling React
into an extension-host bundle; `lib/status.ts` rides that entry too — `statusPresentation`
(connection outranks a stale status), the 80/95 `meterSeverity` thresholds, `tightestWindow`
(the fullest window, for a surface with *one* slot) and `usageWindow(limits, lane)` (the
`session`/`weekly`/`model` split, for one with three — because "what is closest to blocking
me" and "how much of this session have I spent" are different questions, and the single slot
answered only the first, so a weekly window at 71% permanently hid a five-hour one at 60%; the
`model` lane finds the fullest `seven_day_*` bucket rather than naming a model, since which
models get their own bucket is the plan's business),
and the lenient `[1m]`-stripping `currentModel`/`modelLabel` — typed structurally against
`SessionVitals` rather than importing it, so the React-free entry stays React-free.
`SessionBrowser` is the styled sessions list built on protocol's view model — search, facets,
grouping, the subset line, unread badges, inline rename — for a host that wants the
dashboard's look without reimplementing the rules. It draws **projects** the way the extension's
cards do, and to the same rules: `projectLabel` in the cwd-basename slot (falling back to exactly
that basename, so an undeclared project is byte-identical to what shipped), the icon inline
immediately before the name because line two is one truncating mono run, the icon again on a
project group's header, and the name **suppressed on the row when the list is grouped by it** —
the slot going back to the basename, which inside a project group is the one thing the header
cannot say. `projectIcons` is handed in rather than fetched (`useProjectIcons`), for the reason
`ProjectIcon` states: the wire carries an address and who can fetch it differs per client.
`SessionList` stays beside it for the plain fixed-set case.
The file rail reads in the **UI font, never mono** — it is workbench chrome you scan, and the
editors it sits beside set filenames in their UI face; mono is for content on a grid and nothing
in a file list is on one. It had carried a hardcoded `font-mono` since it shipped, which only
became conspicuous once a monospace transcript sat next to it. Independent of `transcriptFont`,
which scopes to the session panel alone.
`SessionWorkspace` is the VS Code-shaped layout *around* it (file rail, tabs, read-only viewer,
hand-rolled `Splitter` — Base UI ships none) and is **strictly additive**: an embedder picks the
panel or the workspace, and `SessionPanel` is untouched by it. It ships from a **second entry
point** (`@workerdeck/ui/workspace` ← `src/workspace.ts`; tsdown builds both), with
`monaco-editor` an **optional peer dep** — a host that only wants the panel (a VS Code extension
webview, say) installs neither. Keep Monaco unreachable from `src/index.ts`: tree-shaking alone
does *not* cover this. Rollup does drop `CodeEditor` from a `SessionPanel`-only bundle, but Vite
resolves Monaco's worker `new URL(…)`s while **transforming** the module — before tree-shaking
runs — and emits ~9MB of worker assets it never retracts (measured: 11M → 2.7M of output, 3682 →
2444 modules, once the subpath landed; `sideEffects: false` does nothing for it). Two invariants
there — the editor
region is *absent* from the layout when no file is open (not zero-height), and `SessionPanel`
keeps its child index across that transition, because remounting it drops the WS attach and the
whole transcript. The embedder's `header` is portalled out of the panel to the top of the
workspace, since only the panel can build the `⋯` menu it is handed. The editor is **Monaco**
(`CodeEditor.tsx`), `import()`ed so it is a lazy chunk — the dashboard's first paint is unchanged
and its ~100 language grammars load per file type. One Monaco model per path, kept across tab
switches so undo history survives. Monaco reaches its workers with `new URL(…, import.meta.url)`,
which Rollup resolves at build time but **Vite's dev dep-optimizer breaks** by rewriting the
package into `.vite/deps/` — hence `optimizeDeps.exclude: ['monaco-editor']` in `web`, without
which Monaco silently runs its worker code on the main thread. Any Vite-based embedder needs the
same line. `web` also aliases away Monaco's four **worker-backed language services**
(ts/json/css/html) — 8.8MB of build output, `ts.worker` alone being 6.7MB of TypeScript
compiler — so `dist/` is 7.9MB rather than 17MB, which matters because `npx workerdeck` ships it.
Highlighting is untouched by that: Monarch grammars (`languages/definitions/*`) are a separate
main-thread mechanism, and TS/JSON/CSS files still colour correctly. The alias lives in `web`'s
config and not behind a hand-written Monaco entry because such an entry must also import two CSS
files and monaco's exports map (`"./*": "./esm/vs/*.js"`) cannot resolve a `.css` subpath at all.
## `packages/web`

dashboard (TanStack Router, hash history); create forms are engine-aware via
`src/lib/engine.ts`, reconciling sticky localStorage choices against the chosen profile, and
the session and job forms are **one** component now (`components/RunForm.tsx`: `useRunForm`
owns the state and builds the shared `CreateSessionRequest` half, `RunFormFields` renders it
with `extras`/`actions` slots). They had been two copies that already drifted; the one
difference that is real — an interactive session pre-authorizes `bypassPermissions` because
the operator is present, an unattended job makes it an opt-in — survives as a parameter rather
than being flattened away. The layout is **four sections and a dialog**: every nav entry
(Sessions, Gateways, Jobs, Profiles) is a *list on the left, detail beside it* pair, so each
names its own sidebar in `AppShell`'s `NAV` rather than mounting one from a route —
navigating within a section must not replace the list you picked from, which is the whole
point of the shape. The frame around all four is **one surface**: `.app-frame` in
`styles/globals.css` repoints `--bg` and `--bg-surface` at `--sidebar`, so the sidebar, the
detail bar, the workspace's tab strip and file rail, the panel and the terminal transcript's
ground are the same grey. A detail pane on a different ground from the list it was opened from
reads as a second window inside the first. A token repoint rather than restyled components,
and it deliberately leaves alone everything that separates itself by *contrast* —
`--bg-elevated` (dialogs), `--bg-code`, the `row-hover` alpha, every border. It has to set
**`--surface` as well as `--bg-surface`**, and that is the trap: `bg-surface` maps to
`--color-surface: var(--surface)`, and `--surface: var(--bg-surface)` is declared on `:root`, so
it computes there once and the resolved colour inherits down — redefining only `--bg-surface`
lower changes nothing for anything spelled `bg-surface`, which was every piece of chrome in the
frame. Any override of a token with an alias in `theme.css`'s bridge block must set both halves
(`docs/GOTCHAS.md`).
`components/shell/SidebarFrame.tsx` is the chrome they share (view
header, collapse toggle, per-section persisted width in `lib/sidebar.ts`) and deliberately
owns nothing else: the rows, filtering and empty state have nothing in common beyond sitting
in the box — except the row, which is `SidebarRow`: title top-left, status
top-right, description bottom-left, hover actions bottom-right, in a rounded
inset card. **Fill means hover and only hover** — it stays on the row whether
or not it is selected, because a selected row still has to answer the pointer.
Selection is an accent bar in the gutter instead, run flush to the sidebar
edge (squared left corners) with `ml-0` handing the border the 4px the margin
was holding, so text does not shift sideways as a row becomes the selected
one. The shape is `ui`'s
`rowShapeClass`, which `SessionBrowser` draws its own rows with — one spelling,
so the sessions list cannot drift from the three sidebars beside it. The fill
is the `row-hover` token and it is **alpha, not a flat colour**: a row sits on
whatever its host paints, so a value tuned for one ground is invisible on
another. That is not hypothetical — `bg-surface-hover` on the dark sidebar
resolved to #141414 against #131313, one step of 255, and the hover state
simply did not exist. The scroll container carries **no side padding**, so the
bar reaches the sidebar's edge; everything that is not a row (the filter bar,
the subset line, group labels, empty states) pads itself. No leading glyph — an icon in front of the title pushes the one
thing you are reading off the left edge, so an engine mark goes on the
description line where it lines up *under* the title. Both lines are real
buttons and the wrapper is only styling: a `div` with an `onClick` looks
identical and is unreachable by keyboard, and one button around everything
cannot hold the actions. Every detail page wears a `DetailBar` —
breadcrumbs left, the page's actions right — so the thing telling you where
you are does not scroll away, which is what an in-body `<h1>` did. Its
`rail` is optional *and its absence is meaningful* — sessions collapse to
engine mark + state icon because that really identifies a row, jobs and profiles collapse to
the expand button rather than a column of identical glyphs. Every `+` opens a **modal** (a
create is a decision you finish and return from, never a screen you navigate to), and
**Settings is a dialog at the foot of the nav**, not a fifth section — it is a preference
sheet, and a destination that spent the whole window on four rows of selects was the wrong
trade; `/settings` survives as a redirect for bookmarks. What is left in it is only what this
*browser* holds: theme and the agent-view preferences — style (Cards/Terminal), and, **only
when the style is Cards**, density and font. Both are inert under the terminal theme (one line
height, monospace by construction), and a control that changes nothing is worse than an absent
one: it invites you to keep pressing it. A stored `lines` migrates to `terminal` rather than
falling back to `cards`, because someone who turned boxes off should keep them off. The run
**defaults moved to the profile** — `ProfileInfo.defaults` already existed and the gateway
already applies it to any field a create request omits, so a per-browser copy was a second
answer to a question that had one. The profile editor picks the model from *that profile's*
catalog (the same `engineFormOptions` resolver the create forms use) rather than a text box that
could name a model the engine has never heard of, and `useRunForm` resolves the permission mode
most-specific-first: this run's pick → the profile's default → a per-kind fallback that stays
hardcoded, because an unattended job stopping at every file write has not run. Gateways lives in exactly one place
now, its own section, having been a hover-icon strip pinned under the sessions list.
Jobs are **read-only**: a job's page is the session workspace under `readOnly`, so the
transcript streams and the files browse but nothing types into a run the queue owns —
Cancel stays, because abandoning a wait is a queue action rather than a turn. `useJobs` is a
module-scope store for the same reason `useSessions` is: the sidebar, the empty pane and a
job's page mount it at once, and three copies would be three queue sockets answering from
three snapshots. The
session runner is `@workerdeck/ui`'s `SessionWorkspace` — the dashboard adds only the header, so a
session feature belongs in `ui`/`react` and every embedder gets it too. The sessions list is
`SessionBrowser` over protocol's view model, with `useViewConfig` persisting the
filter/group/sort (minus `search`, which always starts empty, and `scoped`, which a dashboard
has no folders to mean anything against). Unread rides `useUnseen` — one module-scope
`Watermarks` over `localStorage`, because two hooks with two copies would each answer from
their own stale snapshot — and the session route both feeds it and reads it once at mount for
the panel's catch-up row. **The mark advances off the same record the badge counts from**, the
polled `useSessions` snapshots, and that is the whole rule: two other sources look right and
are not. `onVitals` fires per streamed delta and stops with the last token, but the row that
*ends* a turn reaches the registry after them, so the session you sat and watched kept a badge
for the rows it finished with; `useSessionInfo` is one GET at mount and is never polled, so an
effect on its `activityCount` fires once and never again. `onVitals` still carries `itemCount`
— the socket is its only source and the catch-up row reads it — and `document.hidden` is held
as **state** behind a `visibilitychange` listener, so returning to a tab left mid-turn clears
the badge instead of waiting for the next row. The registry poll
is adaptive (5s idle / 1.2s while anything is working or awaiting approval), re-armed on the
regime rather than per response. Rename is a gateway edit (`PATCH /sessions/:id`), reached
from the row's pencil rather than the extension's double-click: here a single click
navigates, so the first click of a double-click would already have left the page. Published
as prebuilt static files with **zero runtime deps** — React/router/Tailwind are compiled into
`dist/`, so every one of them is a devDep; the entry (`entry.mjs`, hand-written, never bundled) is
a path to `dist/`, not a component. One constraint is still baked in at build time: no vite
`base`, so it must mount at a domain root.
It is **multi-gateway** (`src/lib/hosts.ts`), the mirror of the extension's `HostStore` and
iOS's — and the browser's constraint is what shapes it. There are two kinds of host. The
**implicit** one is the gateway that served the page: same origin, so the login cookie rides
its REST *and* its upgrades, no key is stored and none can be entered. It is **discovered**
(`GET /auth/status`, shape-checked — "it replied 200" is not "it is a gateway"), never
assumed, so a standalone build starts empty rather than inventing a localhost entry. **Added**
hosts are typed in with the gateway's key, and `hostAuth()` in `packages/client` is the one
place that builds their requests: `Authorization: Bearer` on REST, `?key=` on the WS upgrade,
because a tab cannot header an upgrade and the cookie is another origin's. Cross-origin REST
additionally needs the gateway to run with `--cors-origin` (see `packages/server`'s `cors`).
The implicit host keeps the id `'gateway'`, which is what the single-gateway build used, so
existing watermarks keep counting instead of resetting to unread; routes carry the gateway
(`/sessions/$hostId/$sessionId`) because a session id is unique only *within* one, with the
old bare path kept as a redirect. Everything not yet per-gateway — jobs, profiles, the create
form's pickers — goes through `primaryClient()` and says so; `lib/client.ts` is that accessor
now, not a module-scope singleton.
## `packages/cli`

published unscoped as **`workerdeck`**, the turnkey instance (`npx
WorkerDeck`): gateway + dashboard on ONE port via the server's `fallback` hook. Single-origin
is load-bearing, not cosmetic — a tab can't put a header on a WS handshake, so a cookie is the
only credential it can present on an attach, and cookies are per-origin. `--auth-key` is one
secret over two transports (login-page cookie for browsers, header for services); a config file
supplying its own `authenticate` turns the built-in off entirely rather than layering. Browser
logins are durable (`auth-sessions.ts` → `<stateDir>/auth-sessions.json`, 0600) and the table is
keyed by `HMAC(secret, token)`, which is what makes the file worthless to a reader and makes key
rotation invalidate every cookie for free — see `docs/GOTCHAS.md`. Loopback
runs keyless; off loopback the CLI *generates* a key rather than serving open (persisted at
`<stateDir>/auth-key`, 0600), and only an explicit `--insecure` / `insecureHosts` declaration
serves unauthenticated — `insecureHosts` entries double as accepted Host headers. The
resolve/materialize seam has an assert that must stay: see `docs/GOTCHAS.md`. The web
dashboard is a real runtime dep on `@workerdeck/web` — `resolveWebRoot()` is just its exported
`dashboardDir` — so there is one dashboard, versioned in lockstep, not a vendored copy. Also
hosts `workerdeck guard`, and `src/apns/` — the **only push credential in the project**: a
hand-rolled APNs client (`node:http2` + ES256 JWT, zero deps), a device registry mounted at
`POST/DELETE /apns/devices` through the same `fallback` seam that serves the dashboard, and a
forwarder hooked to `notifications.onNotification` in-process. It lives here and not in
`server` so the OSS gateway stays credential-free; absent an `apns` config the routes 404 and
the forwarder does not exist. Environment is per device token, never a flag —
`docs/GOTCHAS.md` §APNs.
## `apps/docs`

Astro site → Pages via `docs.yml`. `examples` — dev entries with root-level deps
the packages must not take, plus `dev-server.config.mjs`, which is what `pnpm dev:server` runs: dev
goes through the real CLI, so there is no second server entry point to keep in sync (config
files here stay literal — no env indirection, they are meant to be edited). `docs/assets` —
brand assets (rules in `BRAND.md`); the mark is inlined in `BrandMark.tsx`, `Header.astro` and
both favicons — keep geometry identical.
