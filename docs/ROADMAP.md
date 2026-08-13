# Roadmap & open questions

What's shipped, what's next, and what's still undecided. Status as of 2026-08-11: **0.11.0** on
master and published — the VS Code extension, the session rename (`PATCH /sessions/:id`), the
terminal transcript variant with a virtualized scroller and keyboard-first prompts, and the Iso
Deck mark. Protocol stays **7**; 0.10.0 (codex skills and generated images, the codex MCP panel,
the session workspace and its Monaco editor) shipped before it.

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
- **Codex MCP status, read-only by design** — `mcpStatus: false` for codex turned out to be a
  stale declaration rather than a limitation: `mcpServerStatus/list` answers, and answers *richer*
  than Claude's, carrying each tool's full JSON Schema where the Agent SDK carries none. So
  `McpServerToolInfo.inputSchema` is optional and both clients render parameters where they exist.
  Two things the schema does not say, both found by probing the binary: liveness is not in the
  list response (it arrives on `mcpServer/startupStatus/updated`, which fires *only* for servers
  that come up while attached — so tools-imply-connected is load-bearing, not a nicety), and
  listing is not acting (nothing on this transport reconnects or toggles one server, so
  `mcpServerActions` splits off from `mcpStatus` and the route 501s a POST the runner cannot
  serve — it previously no-opped through optional chaining and answered 200). Both the skills and
  MCP panels now answer *before the session has connected*, over a throwaway child, because a
  codex session spawns nothing until it has work and a panel that says "none configured" until the
  first turn is stating something false about the operator's config.
- **Codex skills, and generated images that just appear** (`PROTOCOL_VERSION` 7) — two follow-ups
  from the codex engine, both found by dumping the binary's own schema rather than guessing.
  *Skills*: `skills/list` (plus the `skills/changed` watcher) reaches clients as its own `skills`
  event under a new `skillsList` capability — deliberately **not** `capabilities.commands`, because
  a skill is not a slash command. Codex has no command-listing RPC at all and never will over this
  transport; what it has is a capability the model *chooses* from its description, so there is no
  `/skillname` to send. Both clients therefore list skills in a panel and offer them under `/` as
  a **typing aid**: picking one inserts codex's own `interface.defaultPrompt` as ordinary editable
  prose for the operator to finish and send. (The vendored prompt-area grew
  `TriggerConfig.insertAsText` for it — one dropdown, some rows resolving to chips and some to
  text.) *Images*: a generated PNG used to require the operator to declare
  `$CODEX_HOME/generated_images` as a host-file root **and** raise `maxFileBytes`, so out of the
  box you saw a path instead of a picture. Now the runner emits a `file_produced` event naming the
  file its engine wrote, and the gateway serves it from `GET /sessions/:id/produced/:fileId` with
  no roots and no cap — sound precisely because the allowlist is "the exact paths this session's
  own runner announced" rather than a directory grant. A path the *agent* merely read is not a
  produced file and stays behind `/fs/*`. The web panel and the iOS tool card both render the
  picture inline; the example config's drawer grant is gone.
- **Engine adapters, capability records, and Codex as a first-class engine**
  (`PROTOCOL_VERSION` 6) — engines ship as in-repo adapters (`core/src/engines/`): each declares
  its `EngineCapabilities` record (also in protocol as `ENGINE_CAPABILITIES`, the browser-safe
  default clients render from instead of switching on the engine name), ships a model catalog
  with the release (the learned-models map is gone — `GET /profiles` serves a real picker from
  the first request, which fixed the iOS cold-start free-text bug), and probes its own
  credentials (`available`/`unavailableReason` on `ProfileInfo`, display-only, ~60s TTL). Codex
  (the `@openai/codex` binary driven over its `codex app-server` JSON-RPC surface — one child
  per *session*, held across turns) is a peer of the Claude engine:
  create/attach/watch/interrupt/resume, sandbox-mapped permission modes, token-by-token
  streaming, images via `localImage`, per-turn usage summed from `thread/tokenUsage/updated`
  and re-mapped to the Anthropic accounting convention, context occupancy and subscription
  windows off the same surface, and **interactive approvals** — the last needing two gates that
  no schema reading finds (`capabilities.experimentalApi: true` at initialize *and* a granular
  `approvalPolicy`; the plainly-named `'untrusted'` policy never asks at all). Its command
  approval is an escalation *after* the sandbox refused, not a gate before, and accepting re-runs
  the command unsandboxed — so the request carries codex's own sentence rather than a composed
  one. An exec transport (`codex exec --experimental-json`, one spawn
  per turn) came first and was replaced before release: its JSONL carries no partial messages,
  so it could never stream. Claude gained create-time `reasoningEffort` (SDK
  `Options.effort`) with per-model efforts on catalog rows. The `@ai-sdk` provider profiles stop
  being offered by default but the engine, its tests and its example stay green. `smoke:codex`
  covers what the scripted JSON-RPC peer cannot, including free auth-drift canaries pinning the
  verified codex auth matrix (CODEX_HOME login only — no env key reaches the app-server).
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
- **Session workspace — a VS Code-shaped layout around a live session.** `SessionWorkspace` in
  `@workerdeck/ui`: project tree and fuzzy search on the left, editor tabs above, the agent
  below, and the agent claiming the whole column when nothing is open. Strictly additive —
  `SessionPanel` is untouched and an embedder picks either. The headless half is in
  `@workerdeck/react` (`useHostFileTree`, `useOpenFiles`, `useHostFileRoots`, `useSessionInfo`,
  with pure `flattenHostTree` / `openFilesReducer` cores under unit test); `ui` only renders.
  It needed no new backend — `/fs/list`, `/fs/read`, `/fs/find`, `/fs/roots` and `/fs/write`
  were already there. **Editing is Monaco**, dynamically imported so it costs nothing until a
  file is opened, with saves conditional on the hash the tab read: a collision with the agent's
  own edit is a 409 offered as a choice (take disk / keep mine / dismiss), never a silent
  overwrite in either direction, and `hostFiles.write` still gates whether the editor is
  writable at all. Monaco's worker-backed language services are aliased out of the dashboard
  build (8.8MB, `ts.worker` alone being 6.7MB of TypeScript compiler); syntax highlighting is a
  separate main-thread mechanism and is unaffected. The workspace layer later moved to its own
  entry point (`@workerdeck/ui/workspace`, Monaco an optional peer dep): Vite emits Monaco's
  ~9MB of worker assets while *transforming* the module — before tree-shaking — so only
  unreachability from the root entry actually keeps them out of an embedder's build.
- **VS Code extension (`apps/vscode`, side-loaded .vsix).** Sessions in the bottom panel — the
  real `SessionPanel` on a real `WorkerDeckClient` whose `fetchImpl`/`WebSocketImpl` are
  postMessage shims executed extension-host-side (Node fetch/`ws` + `Authorization: Bearer`;
  keys in `SecretStorage`, webview CSP with no external `connect-src`, bridge refuses
  non-gateway URLs). The sidebar is native-shaped, and the rule it
  is built on is that **no webview draws its own header and no view has screens**: chrome is VS
  Code's (`view.title` plus title actions gated on a `setContext` key — a stateful title button
  does not exist, so a toggle is two commands with opposite `when` clauses). So the Sessions view
  is a list of **every gateway's sessions at once** (the gateway is a facet, not the frame) and
  nothing else — search and the facet dropdowns (scope/gateway/adapter/state, group/sort,
  persisted in webview state) sit behind the title bar's filter toggle, and one `SubsetLine`
  (`12 of 30 · <cause>` + "Show all") is the single signal that rows are hidden, shown whether
  or not the bar is open because the list is scoped to the window's folders by default. Cards are
  renameable in place (double-click). **Gateways is its own collapsible view** — a gateway is a
  mode every session belongs to, so managing them sits beside the list permanently rather than
  replacing it — and creating or resuming a session is a native multi-step **QuickPick**
  (adapter → folder → optional first prompt), which is what let the list become a list. The
  folder step asks the *gateway* for its roots (`GET /fs/roots`) and can browse a remote
  filesystem over `/fs/list`, since a remote gateway's paths cannot be inferred from this
  window. The `+` in a view title is the only way to create: no body grows a second button, so
  empty states point at it in words. Plus **four separate section views** — Session Info, Context, Usage, MCP Servers — each
  its own VS Code view off one shared bundle, so collapse/reorder/drag-anywhere are VS Code's
  own. They are **always contributed and start collapsed** rather than appearing and
  disappearing on `when` clauses — a sidebar that changes shape under the pointer as sessions
  are selected is worse than one that says "no session" in a header description — and a view
  the engine's capability record forswears renders an empty state instead of vanishing. The agent panel
  is purely the conversation: `SessionPanel` grew `panelSurface: 'external'` + `onOpenPanel`
  + `onVitals` seams in `ui`, so the panel renders no dialogs and relays intents and live
  vitals outward instead. The status bar went the same way — `statusSurface: 'external'`
  suppresses the in-panel bar and the readings are drawn as **VS Code's own** status-bar items
  (status, context, plan usage; each focuses the section view that answers it, cost and reset
  countdowns in tooltips, capability-gated and colour-coded on the same 80/95 thresholds), on
  the reasoning that the panel already sits inside a window that has a status line. That move
  is what put `connection` on `SessionVitals`: a status held over a dropped socket is a stale
  reading, so the link state takes the slot outside the panel exactly as it does inside.
  The list is **scoped to the window's open folders by default** — the folder is a facet
  alongside gateway/adapter/state, matched only where the gateway could actually be in it (a
  local folder scopes loopback gateways; a `workerdeck://` mount scopes its own), announced
  above the list and one click from "show all", because a filter nobody chose has to be a
  filter everybody can see. The new-session form is also the resume picker, the same
  `listSdkSessions` → `createSession({ resume })` pair the dashboard offers, per directory and
  per profile and gated on the capability record.
  Sessions data is REST rollups on a poll with an
  awaiting-approval badge (`pendingPermissionCount` — already in the protocol, no addition
  needed); notifications for permission asks tapped from frames already crossing the bridge,
  answered over REST `resolvePermission`, no second attach anywhere (interrupt from a card is
  the one deliberate exception: a transient attach that sends the frame and detaches). Remote gateways mount as
  a `workerdeck://` FileSystemProvider over `/fs/*` (conditional writes, 409 = the agent got
  there first; no mkdir/delete/rename routes → NoPermissions), and `extensionKind:
  ["workspace","ui"]` makes Remote SSH windows the full-fidelity tier with zero extension
  code. There is no implicit localhost gateway: an unconfigured install shows an empty list
  with an add affordance (prefilled with the loopback URL) rather than a phantom entry that is
  usually unreachable. Renaming a session is a gateway edit, not a local one —
  `PATCH /sessions/:id` (`UpdateSessionRequest`, `Runner.setTitle`) writes `meta.title` and
  `null` restores the derived title, so the dashboard and the phone see the same name.
  The panel then went **terminal**: `transcriptVariant: 'lines'` in `ui` (full-width
  transparent rows behind a fixed gutter glyph, markdown snapped to one line height, fenced
  code and tables flattened out of their cards, payloads highlighted through the renderer's own
  shiki), the editor font by default (`workerdeck.fontFamily`), a transcript density
  (`workerdeck.transcriptDensity` — `comfortable` leaves a blank line between messages the way
  the Claude Code CLI does; both settings are stamped on the webview root because they must be
  right on the first paint), the brand mark's own four-state pulse as the working marker
  (`⋄ ◇ ◈ ◆` at 150ms — the 0.6s clock `icon-loading.svg` runs), and `controlsSurface:
  'external'` moving model and permission mode into the window status bar as command →
  QuickPick items — which is what lets the composer collapse to a single growing line. Two
  seams came out of that pair: `onControls` hands the embedder the session's setters (the
  panel owns the one attach, so commands travel *in* rather than a second attach going out),
  and `SessionVitals` grew the options themselves.
  **"What's new" is answered in one unit across every surface.** `SessionInfo.activityCount`
  (new, additive) counts transcript *rows* server-side using `transcriptActivity()` in
  `protocol` — deliberately the react reducer's own row rule, because `numTurns` undercounts
  a turn that ran five tools and `lastSeq` counts every stream delta. The extension keeps a
  per-session watermark (globalState, written only while the panel is visible and showing that
  session), which becomes an unread badge on each card, the same count summed on the
  activity-bar icon (over the rows the filter is actually showing — the webview mirrors its
  view config to the host for exactly this), and, on returning, **catch-up**: a `※ recap:` row
  at the boundary counting what happened, everything above it dimmed, and a jump/dismiss bar.
  The recap is counted, never written — `summarizeSince`/`recapLine` in `react` — because a
  prose recap would spend a turn on a summary nobody asked for and would be least trustworthy
  for the session that failed unattended.
  The dev loop is the extension's own: in development mode it watches its `dist/`
  (`src/dev-reload.ts`) and re-renders the webviews in place on a webview rebuild, reloading
  the window only when the extension-host bundle changes; `pnpm dev:host` opens an Extension
  Development Host from a terminal. Not yet: live-verified end to end (a real gateway in a dev
  host), agent→IDE tools (PRD §7), Marketplace publishing. PRD in
  `_docs/plans/VSCODE-EXTENSION-PRD.md`.

### Cross-client parity (unreleased)

The extension's list model, generalized and taken to the other two clients. The rules moved
into `protocol` (`session-list.ts`, `watermarks.ts`) rather than being copied, because they are
rules and not preferences: the extension's activity-bar badge counts the *same* rows its list
shows, so a client filtering differently would announce work it is hiding. `apiUrl`/
`isLoopbackHost` moved to `client` (there were two copies and a third was coming) and the status
presentation rules to `@workerdeck/ui/format`; the extension now consumes all of it, and its
`view-config.ts` is down to the one thing that was genuinely its own.

- **Dashboard**: `SessionBrowser` (in `ui`, so any embedder gets it) — search, gateway/engine/
  state facets, grouping, sorting, the subset line, per-row unread badges, inline rename. Plus
  catch-up (`unseen` into the panel, marks written only while the route is mounted and the tab
  visible), an adaptive registry poll (5s idle / 1.2s busy) replacing the flat 5s, transcript
  **style and density as settings** (`cards`/`lines`, `comfortable`/`compact`), a persisted file
  rail, jobs search + an active-only filter, and one shared run form behind the session and job
  screens instead of two that had drifted.
- **iOS**: one list across every configured gateway — gateway as a facet, not the frame, so the
  server switcher stops being a mode — with the same facets, subset line, unread badges, an app
  icon badge summed over the rows the filter is showing, and rename. `SessionList.swift` and
  `Watermarks.swift` mirror the protocol modules the way `Transcript.swift` mirrors the reducer.
  The workspace scope is inert on a phone by construction rather than by a fake scope.

Alongside it, the public surface was rebuilt around the fact that there are now **four** of
them. "Claude Code sessions" is retired as the product-level noun — it named one engine on a
three-engine product — in favour of **coding agent sessions**, across the banner, the README,
the site and every package description; the auth guide became "Auth & the providers' terms" for
the same reason. The README leads with a quickstart and a showcase table (four client cards over
one server slab, rendered from HTML like the banner) and carries no code snippets — those belong
in each package's own README. The site homepage gained the same four-ways-in section, and the
docs finally have a social card: there was no `og:image` at all, so every shared link rendered
bare. VS Code and iOS had been invisible on the entire public surface until now.

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
1. **Finish the VS Code extension.** The surface is built and side-loadable, but three things
   are open, in order: (a) a live end-to-end run against a real gateway in an Extension
   Development Host. Partly done as of 0.11.x: a side-loaded build has been driven against a real
   remote gateway, which is how the new-session QuickPick's folder step was found to be empty
   there (no candidate source survives a non-loopback gateway with no sessions) and fixed. Still
   unobserved: the virtualized transcript on a long session, the unread badge clearing with the
   list closed, and the keyboard-first approval prompts — `apps/vscode` has no test suite, so
   these can only be checked by hand; (b) agent→IDE tools (PRD §7), the thing that makes it more than a
   webview — selection/diagnostics/open-file as context, and edits arriving as VS Code edits
   rather than filesystem writes; (c) Marketplace publishing, which is a packaging and
   naming decision, not code. CI already uploads the `.vsix` as an artifact.
2. **Shared-backend `QueueAdapter`** (BullMQ or plain redis) — the reason the adapter contract
   exists. `claimNext` must stay atomic (BullMQ free; raw redis needs LMOVE/Lua) and honor
   `nextRunAt` (BullMQ delayed jobs); daily counters map to `INCRBY` on a dated key with TTL.
   Caveat: `JobQueue` assumes the claiming process runs the job — multi-worker deployments need a
   claim-lease/heartbeat so a dead worker doesn't strand jobs in `running`, and webhook ordering
   is per-process.
3. **Promote the remaining `sdk_event` passthroughs** UIs care about: tool progress,
   task/subagent events, todo lists — for both engines at once (Codex todo lists currently ride
   `sdk_event` as `codex.todo_list`).
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

**Scoped embedding is not multi-tenant SaaS**, and the distinction is worth stating rather than
leaving to inference. `CreateSessionRequest.scope` plus `authorizeSession` let a gateway embedded
in one app keep its end users out of each other's sessions — one gateway, one trust domain, one
operator, with sessions belonging to something narrower than the gateway. What stays a non-goal is
mutually-distrusting customers sharing infrastructure: the host's own edge is the authorization
boundary, and scope is defense in depth behind it. See `docs/ARCHITECTURE.md` §Embedding.

## Open questions

- **Compliance posture.** Legal/compliance review of the auth stance is in progress — see
  [Auth & the providers' terms](https://workerdeck.github.io/workerdeck/docs/guides/auth/).
  That section stays honest as things settle. The same question now exists for Codex: whether
  OpenAI's terms restrict headless/gateway use of ChatGPT-subscription codex auth the way
  Anthropic's restrict claude.ai logins is unresolved — the posture mirrors the Anthropic one
  (surface honestly, never circumvent) until answered.
- **Returning `@ai-sdk` providers as bespoke adapters.** New union members (a versioned protocol
  event) or per-profile capability overrides under `'provider'` — the record supports both, so
  the choice stays deferred without penalty.
