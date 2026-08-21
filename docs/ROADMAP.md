# Roadmap & open questions

What's shipped, what's next, and what's still undecided. Status as of 2026-08-20: **0.16.0** is
tagged and on npm — the terminal theme adopted everywhere, terminal navigation (scrubber, sticky
prompt, computed row heights), and per-account plan usage. A substantial body sits on master
above it, unreleased and deliberately so; the ledger for it is in `docs/RELEASING.md`, and
`_docs/VERIFICATION-DEBT.md` is what gates the next bump. Protocol stays **7** and has since
0.9.0.

The registry goes 0.13.0 → 0.15.0 with no 0.14.0, and that gap is deliberate: 0.14.0 was bumped
and committed but never tagged, so nothing under that number ever reached npm and its content
ships inside 0.15.0. Do not publish a v0.14.0 after the fact.

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
  (adapter → folder → model), which is what let the list become a list. Each step arrives
  pre-answered — the folder from this window's open folders, the model and permission mode from
  the session that adapter ran last — so the common path is three `enter`s. The
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
  The panel then went **terminal**: `transcriptVariant: 'lines'` in `ui` (since replaced by the
  real `'terminal'` renderer in 0.16.0, which deleted `lines` — this is the 0.11.0 story) (full-width
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
  session), which becomes an unread badge on each card, the same count summed into a window
  status-bar item (over the rows the filter is actually showing — the webview mirrors its
  view config to the host for exactly this), and, on returning, **catch-up**: a `※ recap:` row
  at the boundary counting what happened, everything above it dimmed, and a jump/dismiss bar.
  The recap is counted, never written — `summarizeSince`/`recapLine` in `react` — because a
  prose recap would spend a turn on a summary nobody asked for and would be least trustworthy
  for the session that failed unattended.
  The dev loop is the extension's own: in development mode it watches its `dist/`
  (`src/dev-reload.ts`) and re-renders the webviews in place on a webview rebuild, reloading
  the window only when the extension-host bundle changes; `pnpm dev:host` opens an Extension
  Development Host from a terminal. Not yet: live-verified end to end (a real gateway in a dev
  host), agent→IDE tools, Marketplace publishing — see **Next** below for all three.

### Cross-client parity (0.12.0)

The extension's list model, generalized and taken to the other two clients. The rules moved
into `protocol` (`session-list.ts`, `watermarks.ts`) rather than being copied, because they are
rules and not preferences: the extension's unread badge counts the *same* rows its list
shows, so a client filtering differently would announce work it is hiding. `apiUrl`/
`isLoopbackHost` moved to `client` (there were two copies and a third was coming) and the status
presentation rules to `@workerdeck/ui/format`; the extension now consumes all of it, and its
`view-config.ts` is down to the one thing that was genuinely its own.

- **Dashboard**: `SessionBrowser` (in `ui`, so any embedder gets it) — search, gateway/engine/
  state facets, grouping, sorting, the subset line, per-row unread badges, inline rename. Plus
  catch-up (`unseen` into the panel, marks written only while the route is mounted and the tab
  visible), an adaptive registry poll (5s idle / 1.2s busy) replacing the flat 5s, transcript
  **style and density as settings** (`cards`/`lines` then, `cards`/`terminal` since 0.16.0 —
  a stored `lines` migrates to `terminal`; `comfortable`/`compact`), a persisted file
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

### Cross-origin gateways and the four-section dashboard (0.13.0)

A gateway reachable from a page it did not serve. `hostAuth()` in `client` is the one place an
added host's requests are built — `Authorization: Bearer` on REST, `?key=` on the WS upgrade,
because a tab cannot header an upgrade and the cookie belongs to another origin — with the server
half as `cors: { origins }` and the CLI's `--cors-origin`. Exact origins only, and
`Access-Control-Allow-Credentials` is never sent, so an ambient cookie cannot become cross-origin
authority.

The dashboard was rebuilt as **four sections and a dialog**: Sessions, Gateways, Jobs and Profiles,
each a list-on-the-left/detail-beside-it pair, because navigating within a section must not replace
the list you picked from. Every create is a modal rather than a screen, Settings became a dialog at
the foot of the nav rather than a fifth section, and the run defaults moved onto the profile — the
gateway already applied `ProfileInfo.defaults` to any omitted field, so a per-browser copy was a
second answer to a settled question. Gateways got their own section instead of a hover strip under
the sessions list. Jobs became **read-only**, which is what `SessionPanel`'s new `readOnly` seam is
for: the transcript streams and the files browse, but nothing types into a run the queue owns.

### Session scope and the sandboxed profile (0.15.0, bumped as 0.14.0)

The primitives for putting a session in front of someone who is not the operator.

- **`CreateSessionRequest.scope`** — opaque string tags assigned at create, immutable after, echoed
  on `SessionInfo`, and the only intra-deployment scoping primitive there is. WorkerDeck stores and
  *enforces* the tags; the embedder's `authorizeSession(principal, session)` decides what they
  mean, because "space" and "user" are one app's vocabulary and the next has tenants. Enforced at
  the `/sessions/:id/*` gate, the list, the WS attach **before** the wake, `POST
  /executions/:id/result`, and the job routes via `JobInfo.scope`; the operator surfaces (`/fs/*`,
  `/sdk-sessions`, `/queue`, `/queue/ws`) are refused outright to a scoped principal, since they
  answer about the *gateway* and there is nothing to filter. A miss is **404, never 403**. Two
  guards keep it honest: `buildRunnerConfig` re-stamps the scope over the host hook's output, and
  `buildRunner` — the one chokepoint for create, dormant rebuild and parked rebuild — asserts the
  runner echoes it, because a runner that dropped it would be invisible to every check and
  therefore visible to everyone.
- **`sandboxedProviderProfile()`** — a provider profile with `capabilities: []` and
  `mcpServers: []` (empty arrays, never absent, which would grant whatever the host wired), plus
  `EngineCapabilities.hostCwd`, which is what makes `cwd` optional: `allowedCwdRoots` is not the
  boundary for a filesystem-less engine and must not be mistaken for one.
- **`apps/embedded`** — the reference embedding, and the thing to read before designing another
  one. A wiki SPA whose right-hand rail is a sandboxed agent, gateway inside the app's own server,
  one port, the app's cookie as the only credential an attach can carry, and `scope` as the entire
  ownership model.

### The embedding seams the DEV-UX assessment asked for (0.15.0)

Written straight out of building `apps/embedded` against 0.13.0, where two thirds of the time went
into reverse-engineering patterns that should have been one helper and one guide — and the worst
moment was a **silent** failure: an MCP server that failed to connect, producing a working-looking
session with no tools.

- **MCP is handed over as a connection, not a tool set** — `connectMcpTools` → `McpConnection.servers`,
  with `required: true` to reject a failed connect instead of degrading. A profile declaring a server
  that did not connect now refuses to build. `AiSdkRunner.mcpServers()` answers `/sessions/:id/mcp`
  with what the host actually assembled — an empty list, never a 501 — which is why
  `ENGINE_CAPABILITIES.provider.mcpStatus` is now `true`.
- **`createEngineSession({ tools })`** — where a host's own tool joins the set at a *stated* trust,
  the only way to express a sandboxed (therefore bridgeable) host tool, since `mcpTools` is
  authoritative by construction. Both contradictions — sandboxed-with-`execute`,
  authoritative-without — are refused at assembly rather than discovered at runtime.
- **`createProviderRunner(ctx, opts)`** — the 80% case of `createEngineRunner`, carrying the four
  obligations that are invisible in the hook's types and fail only at runtime: forward `restore`,
  adopt `id`, seed the VFS only when not restoring, dispose via `onClose`. `seedVfs` and `id` are
  the two options that make the rehydration rules unmissable.
- **`requireAvailableProfile`** — 503 on create with the credential probe's own reason, for a
  deployment with an end user in front of it. Off by default and only a definite `false` blocks,
  because turning a probe bug into an outage is worse than one confusing failure.
- **`SessionPanel`'s `toolHost`** — options through, or `false` for none, since the panel owns the
  session's one attach and an embedder subscribing separately would find this host already refusing
  anything outside its allow-list.
- The documentation half: a "Rules you cannot infer from the types" section in every package
  README, and three new site pages — the app-embedding guide, engines and executors, writing tools.

### The terminal theme adopted, terminal navigation, per-account usage (0.16.0)

Three tracks:

- **The terminal theme everywhere, `lines` deleted.** `transcriptVariant: 'terminal'` is a
  renderer, not a set of branches (`packages/ui/src/components/terminal/`): the VS Code dock at
  the editor's own cell (`terminalMetrics` resolved from `editor.fontSize`/`lineHeight`,
  `--cw-font-mono` repointed at the editor font, `workerdeck.terminal.*` settings), the dashboard
  (Settings → Terminal, a stored `lines` migrating to it rather than falling back to cards), and
  `apps/embedded`'s rail. The composer grew its own terminal form (gutter `❯`/`+`/`✕`, two
  focus-tracking rules). Deleted with `lines`: `useLines`, `LineGlyph`, `line-prompt.tsx`, and
  `Response`'s sixty `!important` overrides. `apps/ios` keeps its own `lines` on purpose — a
  Swift terminal renderer is a separate track. The dashboard's frame also became one surface
  (`.app-frame` repointing `--bg`/`--bg-surface` at `--sidebar`).
- **Terminal navigation.** Row heights are *computed*, not estimated (`terminal/height.ts` —
  `{px, exact}`, WeakMap cache per width×cell epoch, browser-measured regression gate in
  `dev/height-audit.ts`), which is what let the scrubber be a real draggable scrollbar: a 12px
  overview ruler whose two lanes are **channels** — left is input (your prompts, and a green band
  per sub-agent you dispatched), right is output (each turn's answer, and every failure that
  produced one) — with full width left for what is not a channel at all (the pending approval, a
  bookmark, the recap seam), hover peeks from `state.items` (never the DOM), click jumps through
  `rowIndexForItem`. A mark spans its row's extent, except an item that *shares* a row (a task
  block's absorbed child, a folded run's member), which is a tick at its fraction of it — one
  failed child of a hundred-call agent otherwise painted the whole expanded block red. The sticky prompt holds the first line of the turn you are
  reading via a compositor-pinned lane + head, kept mounted through the virtualizer's
  `rangeExtractor`. A session opens settled (the `replaying` hold on the attach frame's own
  signal), switching is cached (`transcript-cache.ts`, guarded by `staleAttach`), replay is
  coalesced (`replayCoalesceKey` in protocol), and `/clear` clears (`transcriptContent`).
- **The meters read the account, not the session.** Per-profile plan usage: `ProfileUsageTracker`
  in the server (last-write-wins by event `ts`, the 0%-after-reset inference at serve time),
  `ProfileInfo.usage` on `GET /profiles`, `mergeUsage`/`orderUsageWindows` in protocol,
  `useProfileUsage` in react, `UsageMeters` in ui, and three usage lanes in the VS Code status
  bar (`session`/`weekly`/`model` via `usageWindow`). No protocol bump — optional response-only
  fields, the `available`/`models` precedent.

Plus, in the VS Code extension: the activity-bar container deleted (Sessions into Explorer, five
views into a `secondarySidebar` container — the `engines.vscode ^1.106.0` floor is the cost),
unread as a window status-bar item, window-reload session restore; and in core, a session comes
back under the CLI's own title (polled off `getSessionInfo`, never overwriting a rename) and a
resumed transcript no longer shows rows nobody typed (`isSyntheticUserText` on both paths). One
command runs the production build beside dev (`pnpm start:prod`, 8788).

### On master, unreleased

Held back from a bump on purpose — see `_docs/VERIFICATION-DEBT.md`, which gates it. The full
ledger lives in `docs/RELEASING.md`; the headline tracks are live-session persistence
(`parking.persistLive`, `Runner.snapshot()`), sub-agents made visible (`forwardSubagentText`,
`SessionInfo.subagents`, the terminal theme's `Task` fold), the iOS native terminal renderer
through phase 3, on-demand tool results and image-part references, and:

- **Project identity, drawn.** A `.workerdeck.json` gives a directory a name and an icon,
  resolved by the *gateway* on an ancestor walk from the session's realpath'd cwd (a phone
  cannot see that filesystem) and stamped at serve time, so an edit reaches every session within
  the TTL with no migration. The wire carries an **address** — a glyph name, or a media type and
  a content hash whose bytes come from `GET /sessions/:id/project/icon` — because `SessionInfo`
  rides every row of a 1.2s poll. It had shipped with no consumer; now all three clients draw
  it, and `project` is a filter/group/sort facet beside adapter and state. The clients agree on
  the rules and differ where the surface does: VS Code and the dashboard put the name in the cwd
  basename's slot, while iOS — the only client that draws the whole path — prefixes instead
  (`WorkerDeck · packages/ui`). Two platform facts shaped the rest: Apple cannot decode an SVG
  from bytes, so an SVG icon degrades to the name alone on the phone (rasterising on the gateway
  was rejected — the session cwd is the agent's working tree, and the icon route deliberately
  parses nothing), and lucide does not exist on iOS, so 111 glyph names are translated to SF
  Symbols and validated twice, against the catalog at authoring time and `UIImage(systemName:)`
  at runtime. This repo now carries its own `.workerdeck.json`, which is what turned a tested
  feature into an observed one: nothing had ever resolved a real file or served a real byte.
- **Codex's sub-agents, made visible — and a live bug found under them.** The repo believed
  codex had no sidechains. It has had them since the pinned 0.146.0, and they arrive **in
  ordinary sessions today**: we never send `multiAgentMode`, but the operator's config enables it
  and codex's default posture is `explicitRequestOnly`, so a user who asks gets them. A spawned
  agent runs in its own thread on the same connection and `threadId` is the only thing that says
  so — which is now how every item and delta is attributed, per frame rather than off a mutable
  "current agent", since two agents stream at once. `subAgentActivity.id` turned out to *be* the
  model's own `spawn_agent` call id, so `SubagentInfo.toolUseId` kept its meaning and no client
  changed. The bug: `turn/completed` was not scoped to the session's thread, so a child's arrived
  ~14 s early, published the **sub-agent's** last line as the turn result and dropped the root's
  real answer. Reproduced deliberately with the new `WORKERDECK_CODEX_TRACE` sink, which dumps the
  raw inbound traffic and is what made any of it findable — a wire capture of the same session had
  been read three ways and still hid the child threads.
- **The sub-agent takeover on iOS, and agent lines you can press.** The phone reaches the same
  surface the dashboard and the extension got, by a navigation push — which reshaped it: **a push
  cancels the covered view's `.task`**, so the obvious shape would have detached the socket
  underneath the takeover, freezing the one screen built for watching an agent work. The attach's
  lifetime is a claim count instead. The sessions row reverses its own "a count, not a disclosure"
  decision *narrowly*: the objection was about a second target inside one `NavigationLink`, so the
  twisty is a sibling and each agent is its own full-width row. A takeover asked for before its
  Task exists is held until the replay hold lifts, so the phone never frames a mid-replay
  transcript — the one risk the web still carries.
- **A sub-agent's brief, and the rail inside the frame.** Both came from using the takeover. You
  could watch an agent and never see what it was asked: a *background* agent forwards no brief
  (measured — eight of them, not one `user` item with a parent), so it is spliced from the
  spawning call's `prompt` when the stream carries none, clipped to four wrapped lines. And the
  scrubber had been gated off with three features that genuinely are full-transcript; ungating it
  gave **zero marks** on a 114-tool agent, because the mark rules test "is this top level" and
  inside a frame nothing is. Now the level is a parameter and every narration step marks: same
  agent, 16 marks.
- **One session row across all three clients**, on the VS Code sidebar card's design — the
  dashboard row had been the reference for a pass and was the wrong one. `sessionSteps` /
  `StepToggle` / `StepRow` and the `--vendor-*` colours moved out of the webview into
  `packages/ui`, which is precisely why the dashboard had had none of them; the dashboard row was
  rebuilt on them with state leading a shared gutter; and iOS gained the two pieces it had never
  had — `engineMark` in the kit, and the vendor marks as real vector assets generated from the
  web's own path table, SwiftUI having no path-data parser. Details in `docs/PACKAGES.md`
  (`SessionBrowser`, `SessionSteps`) and `docs/CLIENTS.md`. **Not visually checked on any of the
  three** — see `_docs/VERIFICATION-DEBT.md`.

## Next

0. **Sub-agent handling — the tracker is fixed; the surface is not.** A real session run against
   the dev gateway on 2026-08-18 showed every *async* agent reading as a failed, label-less run;
   the cause and the fix are in the shipped-on-master notes above, and the lesson is the one worth
   keeping: the CLI's background-task lifecycle (`task_started`, `task_notification`) was in the
   stream all along, and the tracker had been inferring where it could have been reading. What is
   still open: **the CLI's task summary** — the expandable "tasks" checklist under its composer,
   which is the *turn's own to-do list* and not the `Task` tool — a surface WorkerDeck has no
   equivalent of. First question is empirical and the same one that just paid off: is it a tool
   whose calls already ride our stream (making it a rendering question) or CLI-side state? Check a
   capture before designing. Also owed: a background agent **stopped or killed** mid-flight is the
   one lifecycle path the fix did not exercise. Written up in
   `_docs/features/sub-agent-handling.md` (gitignored; harvest before deleting).
1. **The terminal renderer's cross-client seams**, all deferred out of the 2026-08-19 structural
   pass rather than forgotten. In rough order of value: (a) a **language-neutral golden corpus**,
   which is the only thing that can catch the two ports drifting — the load-bearing *strings* break
   first, so it should pin `runSummary`/`taskSummary`/`collapsedResult`/`TermFmt` against
   `tool-run.ts`/`result-preview.ts`/`format.ts`, taking items JSON in and asserting block keys,
   line counts at fixed metrics, summary strings, red indices, and rail marks and regions out;
   (b) porting iOS's single `blockCalls(in:expansion:)` walk to the web scrubber, which still
   derives its failure set in its own segment walk (`scrubber.tsx`); (c) `.subagent` as a
   *region* rather than a mark, now that regions exist on the phone; and (d) expressing the iOS
   planner over `blockCalls` too, if a third consumer of that walk ever appears — deliberately not
   before, since the planner's copy is the one that has to stay pure.
1. **APNs push for the iOS app — proven on a device 2026-08-20, one path still open.** The
   forwarder half is in (`packages/cli/src/apns/`: hand-rolled HTTP/2 client, device registry at
   `/apns/devices`, in-process hook onto the session notifications above) and so is the app half
   (entitlement, registration per gateway, Approve/Deny actions, deep link). **Now verified against
   a physical phone and a running gateway:** registration (fresh `hostId` against a restarted
   gateway), delivery through real APNs, and a tapped notification opening the session it names.
   **Still not verified: the Approve/Deny buttons resolving a live permission request from the lock
   screen** — the one path that answers a request without the app coming forward, and the reason
   the payload carries `requestId` at all.

   That first real pass paid for itself immediately, which is the argument for doing it before a
   release rather than after: every tap had been aborting the app on a main-thread assert (the
   `async` delegate witness — `docs/GOTCHAS.md` §APNs push), and a dial could fail silently because
   Node's Happy Eyeballs gives each address 250ms and Apple sometimes needs more. Both had shipped.
   Neither is reachable by any test — hence `pnpm smoke:push`, which raises a real notification on
   demand so the next person does not have to wait for one by accident. The deep link currently
   lands at the tail of the transcript rather than on the event that triggered it, though `seq` is
   already in the payload; that is tracked as its own item.
1. **Finish the VS Code extension.** The surface is built and side-loadable, but three things
   are open, in order: (a) a live end-to-end run against a real gateway in an Extension
   Development Host. Partly done as of 0.11.x: a side-loaded build has been driven against a real
   remote gateway, which is how the new-session QuickPick's folder step was found to be empty
   there (no candidate source survives a non-loopback gateway with no sessions) and fixed. The
   machinery has since changed shape under this list — 0.16.0 gave the virtualized transcript
   computed row heights, and unread became a window status-bar item that no longer needs the
   Sessions view resolved — but the by-hand pass itself is still owed: a long session in a real
   window, the unread count clearing, and the keyboard-first approval prompts. `apps/vscode` has
   no test suite, so these can only be checked by hand; (b) **agent→IDE tools**, the thing that makes it more than a
   webview — selection/diagnostics/open-file as context, and edits arriving as VS Code edits
   rather than filesystem writes; (c) Marketplace publishing, which is a packaging and
   naming decision, not code. CI already uploads the `.vsix` as an artifact.

   (b) splits by engine, and the split is the whole design question. For **provider** sessions the
   browser tool-host seam already runs tab-side tools over the existing WS, so `ide_open_file` /
   `ide_get_diagnostics` executed by the extension are a natural fit and NAT-proof by construction
   (the client connects out); it needs core work to define the tools, but the seam holds. For
   **claude and codex** sessions tools arrive only over MCP, and an extension-hosted MCP server
   works only when the *gateway can reach it* — trivially true for a local gateway, false for a
   remote one, which would need a reverse path into the user's machine. The two candidates there
   are riding the deferred-execution seam (`DeferredExecutor` + `POST /executions/:id/result` is
   out-of-band tool execution by design) or an MCP-over-WS bridge. Unsettled on purpose.

6. **Staleness signalling in the workspace.** `/fs/write` is conditional on the hash the tab read
   precisely because the agent edits the same tree, but nothing tells a client the file changed
   underneath it — so an open tab goes stale silently and the 409 at save time, though correct, is
   the worst moment to discover it. Editing shipped ahead of this knowingly. There is no change
   notification on the wire and building one per engine would make the workspace codex-only
   (codex's app-server has `fs/watch`; the Claude engine has no equivalent). Cheapest first:
   re-read and compare the hash on tab/window focus; poll open tabs' hashes while the session runs;
   or a `file_changed` event. The interesting shortcut is that **the transcript already names every
   file the agent touched** — `Edit`/`Write` tool calls carry paths — so a workspace could mark
   tabs stale off the stream it is already subscribed to, with no new backend at all. Check what
   those tool inputs actually carry before committing. Whatever is chosen: never silently reload a
   tab with unsaved edits.
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

7. **Decide on shell execution.** Remote clients keep wanting a "run this command on the host"
   affordance. The CLI's `!` is a *terminal-mode behavior*, not a wire feature — `user_message`
   text goes straight to the engine — so a real one needs a new operator-privileged endpoint with
   the same trust story as `hostFiles.write`. It is the most security-sensitive thing on this list
   and the one the repo's auth red lines do **not** cover: those are about provider credentials,
   this is about operator privilege. Treat it as its own design pass, not a sub-task of a client.

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
- **Codex's sub-agents, which we have never mapped.** Not a gap in codex — a gap in us: the
  app-server has carried `collabAgentToolCall` and `subAgentActivity` since 0.146.0 and this repo
  models neither, so they arrive as invisible `sdk_event`s. Its nesting handle is a **thread id**,
  not a tool-use id, so `SubagentInfo.toolUseId` does not fit and the id decision has to come
  before any tracker. Two independent gates keep it quiet today — we never send `multiAgentMode`,
  and the operator's own `config.toml` gates it besides (which is theirs, not ours, to set). The
  cheap first move needs no opt-in at all: `subAgentActivity`'s sources include `review` and
  `compact`, which codex does on its own, so mapping the item may show it is already live. Brief
  in `_docs/features/codex-multi-agent.md`; the union is now pinned by
  `pnpm smoke:codex --canary`.
- **A `model` facet, and what a model group would be keyed by.** The sessions list groups by
  gateway, adapter, state and project; a fourth facet was asked for ambiguously ("colour the model
  unless grouped by model") and deliberately not built, on the reading that it was
  symmetry-of-writing. If it is ever wanted, the keying decision is the whole of it and
  `projectKey`'s doc has the argument ready-made: **a name is not a key.** `claude-opus-5[1m]` and
  `claude-opus-5` are the same model with different windows; `gpt-5.6-luna` and `gpt-5.6` are not.
  Key by the wire id with the `[…]` variant stripped (what `friendlyModel` already does first) and
  label with `friendlyModel`, or key by the friendly name and accept that two ids collapse. Decide
  it once, in protocol, or the facet and the row will disagree about what "same model" means.
- **Three vendors have a mark and no colour.** Gemini, DeepSeek and Moonshot fall through to muted
  on web and phone alike. Adding one is two declarations in `theme.css`, a map entry beside
  `EngineIcon`, and one `case` in iOS's `VendorPalette` — in that order.
- **The dashboard cannot reveal a `Task` row.** VS Code deep-links into the transcript
  (`revealToolUse` → `SessionPanel.reveal`); the web has no such plumbing, so a sub-agent step
  there opens the session and stops. `SessionBrowser`'s `onSelectSubagent` is optional for exactly
  this reason. A `packages/react` / `packages/web` job, not a row job.
- **Returning `@ai-sdk` providers as bespoke adapters.** New union members (a versioned protocol
  event) or per-profile capability overrides under `'provider'` — the record supports both, so
  the choice stays deferred without penalty.
