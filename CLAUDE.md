# WorkerDeck

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app; a second, model-agnostic engine runs any AI SDK provider on the same
protocol. Read these before changing scope or structure:

- `docs/GOTCHAS.md` — **the invariants that bite.** Skim the headings for whatever you're about
  to touch: engine, permission, parking, bridge, packaging.
- `docs/ARCHITECTURE.md` — package map, dependency rule, session/job/parking lifecycles.
- `docs/ROADMAP.md` — shipped / next / open questions. Non-goals (don't relitigate): serverless
  hosting, multi-tenant SaaS, claude.ai auth.

## Layouts

- `packages/protocol` — wire types (events/commands/REST). Dependency-free, browser-safe, depends
  on nothing and everything depends on it. Breaking → bump `PROTOCOL_VERSION`. It also owns the
  few *rules* both sides must agree on rather than each guess: `transcriptActivity(event)` is
  the row-count rule the react reducer renders by and the runners count with
  (`SessionInfo.activityCount`) — change one, change both. Two more joined it, both lifted
  out of the VS Code extension once a second client needed them: `session-list.ts` is the
  **sessions-list view model** (the `attention/working/idle/ended` buckets, the
  gateway/adapter/state facets, `filterRows`/`groupRows`/`subsetSummary`/`clearFilters`, and
  the scope-containment rule where a gateway-tagged root scopes only that gateway and an
  untagged one only loopback), and `watermarks.ts` is the **unread model** (monotonic marks
  behind a `WatermarkStore` seam, and `unseenCount`'s rows-not-turns arithmetic). They are
  rules, not preferences: the extension's activity-bar badge counts the *same* rows its list
  shows, so a client that filtered differently would announce work it is hiding. Tests live
  in `packages/react/test/session-list.test.ts` + `watermarks.test.ts` (protocol has no
  vitest of its own); Swift mirrors in `WorkerDeckKit`.
- `packages/core` — the engines, shipped as **adapters** (`src/engines/`): one `EngineAdapter`
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
  `modelOptionsFromSdk`'s rules (`src/normalize.ts`) at authoring time — no `default` sentinel
  row, names derived from resolved ids (`claude-haiku-4-5-20251001` → "Haiku 4.5"), newest of
  each family `primary` — and the live `capabilities` event still exists for the in-session
  model switcher and slash commands (both truths are load-bearing, see `docs/GOTCHAS.md`).
  No transport. Tool execution rides the
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
  `RunnerSnapshot` + `restore` are the two halves of rehydration, and `seedVfs`/`id` are the two
  options that make the *other* rehydration rules unmissable — `seedVfs` is ignored on a restore
  (seeding over a parked turn's files destroys exactly what was preserved) and `id` is what a
  session comes back as itself under.
- `packages/sandbox` — untrusted-code boundary: QuickJS-NG WASM guest, in-memory map VFS (not a
  node-fs emulation — the tab-side host runs it unpolyfilled), by-value host bridge,
  interpreter-enforced limits. Leaf like `protocol`; engine variant injected, so server and
  browser share one guest.
- `packages/queue` — `JobQueue` + `QueueAdapter` (in-memory bundled; `claimNext` must stay atomic
  and skip future `nextRunAt`). Concurrency, token budgets, webhooks, retries, watchdog, retention.
  Jobs are one-shot, but a run that parks frees its slot and stops its duration clock.
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`): session registry, auth hook,
  profiles served with their engine's **capability record, static model catalog, and
  availability verdict** from the first request (`forResponse`; probes are adapter-run, gated on
  `checkCredentials`, ~60s TTL, display-only — only the *default* model is still learned from
  sessions, because it is the operator's CLI config),
  optional `/jobs` + `/queue` routes, profiles (+ `profileStore` CRUD), `GET /sessions/:id/files`,
  message attachments (`attachments.ts` — bytes held per session so the event log carries only
  `MessageAttachment` refs; **never** inline base64 into an event),
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
  session at boot is a fork bomb. Between them every engine survives a restart. Three things
  hold it together and each is a bug if dropped: `listInfo` hides a record whose id the registry
  has (or every live session lists twice), the `session_closed` discard is skipped while
  `#closed` (the registry closes runners with the same 'server' reason a DELETE gives, so a
  graceful shutdown would forget exactly what it was preserving), and waking one feeds its config
  back through `buildRunnerConfig` rather than using it as-is — `env` is never persisted, so the
  profile's `CLAUDE_CONFIG_DIR` pin has to be re-derived. Imports no model
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
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`; zero runtime deps. Owns
  the WS frame surface, so new frames need `SessionHandle` methods/events here. A refused REST
  call throws `WorkerDeckError` (an `Error` subclass carrying `status`), which is what lets a
  caller tell "this server has no such route" (404 — stop asking) from "that file was too big".
  It also owns `apiUrl`/`isLoopbackHost` (`src/host-url.ts`): what an operator types turned into
  a `baseUrl`, and whether that gateway is this machine — decided from the URL, never by probing
  paths. Here because every host that lets someone type a gateway address must normalize it
  identically, or the same gateway saved twice is two gateways.
- `packages/react` — headless: `useClaudeSession`, the pure transcript reducer
  (`src/transcript.ts`, framework-free, unit-tested — keep rendering out), the recap counters
  behind catch-up (`src/recap.ts`: `summarizeSince` + `recapLine` — **counted, never written**;
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
  see the bridge rule below), the
  other pure helpers that both clients must agree on (`rateLimitWindows`, `scanPromptTokens` —
  the mirror of the Swift `PromptTokens`), and the browser tool host (`tool-host.ts`) running
  server-bridged calls in the tab. Companions must ride the hook's own `handle` — the bridge asks
  the first attached client, so a second handle sees nothing. `TranscriptState.capabilities` is
  always populated, and is what every surface renders from (see `docs/GOTCHAS.md`).
- `packages/ui` — styled layer (Tailwind v4 + `@base-ui/react` + cva): `src/components/ui`
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
  so that combination falls back to the composer rather than hiding them. `toolHost` is the
  escape hatch for the panel's own browser tool host — options through to `useToolCallHost`, or
  `false` for none — because the panel owns the session's one attach, so an embedder subscribing
  separately would find this host already refusing anything outside its allow-list.
  `readOnly` is the fourth and the bluntest: no composer and no approval prompts, for a
  surface that is *about* a run rather than in it (the dashboard's job detail, where typing
  would be a second operator arriving mid-run). Absent, not disabled — a greyed-out composer
  says the session is busy, an absent one says this screen does not drive it — and **not an
  authorization boundary**: it removes the affordance, the gateway does the enforcing.
  `transcriptVariant` is the fifth, independent seam: `'cards'`
  (the chat convention) or `'lines'` — full-width transparent rows behind a fixed gutter
  glyph, no boxes, for a host where vertical space is scarce. It rides a **context**
  (`transcript-variant.tsx`), not a prop chain, so a row component composed by hand gets the
  right treatment too; every row component branches on `useLines()` rather than the embedder
  restyling `data-slot`s from outside. `transcriptDensity` is the sixth seam and rides its own
  context beside it — `'comfortable'` (default: one blank line between rows, what the Claude
  Code CLI leaves) or `'compact'`. Separate from the variant on purpose: the variant follows
  from the *surface* (boxed or not), density is the reader's *preference*, so a dock may be
  roomy and a dashboard dense. `ROW_GAP` in `transcript-variant.tsx` is the whole feature — the
  gap goes on the virtualizer's **measured** wrapper, so no pixel constant is load-bearing and
  only `estimateSize` takes the `px` (scrollbar length before rows mount, replaced by a real
  measurement the moment one does). VS Code exposes it as `workerdeck.transcriptDensity`,
  stamped on `#root` like the font because it decides every row's height (`transcriptVariant`
  is stamped beside it now — the dock defaults to `lines`, but it is a setting, not a
  hardcode). `transcriptFont` is the seventh seam and the one with **no JS at all**:
  `'sans'`/`'mono'`, one `data-agent-font` attribute on the panel root, and a rule in
  `theme.css` repointing `--cw-font-sans` at the mono stack for that subtree. A subtree rule
  rather than `:root` is the whole claim — a monospace agent view inside an ordinary app, so
  a host's sidebars and dialogs cannot pick it up. All three clients expose the same three
  preferences, and only for a running session. The `lines` variant also owns the **docked
  composer**: flush to the panel edges, no radius, no shadow, and one rule along the top that
  turns accent on focus, with `+`/`↵` glyphs in place of the round pills. It lives in
  `Composer.tsx` keyed on `useLines()` — it had been CSS overrides in the VS Code webview,
  which meant only that one host had it and a panel switched to `cards` would have kept the
  flattening. The working marker is
  the **brand mark's own pulse** (`pulse.tsx`: `⋄ ◇ ◈ ◆` at 150ms = the 0.6s clock in
  `icon-loading.svg`), shared by the transcript's `Loader` and each running tool row's gutter
  glyph so they beat together; it rests on `◆` under `prefers-reduced-motion`, free because the
  last frame *is* the mark. BRAND.md's ambiguous-width caveat is why this is webview-only:
  `LineGlyph` centres the glyph in a fixed box, a real terminal must use the ASCII set. The
  `lines` tool row lost its right-edge `Spinner` when the gutter started moving — two spinners
  on one row is one too many. The provider wraps the **whole panel**, not just the
  scroller, because the approval and question prompts render outside it and are line items in
  the same run: in `lines` they are keyboard-first rows built from `line-prompt.tsx` (roving
  `❯` marker, numbered rows, `↑↓`/digits/`esc`, `[x]` vs `(•)` for multi- vs one-of) rather
  than dialogs — no boxes means the affordance has to be carried by the keyboard, which is
  what a terminal does anyway. The same file owns the fenced-`Response` payload band the tool
  rows already used. The transcript is **virtualized**
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
  and the lenient `[1m]`-stripping `currentModel`/`modelLabel` — typed structurally against
  `SessionVitals` rather than importing it, so the React-free entry stays React-free.
  `SessionBrowser` is the styled sessions list built on protocol's view model — search, facets,
  grouping, the subset line, unread badges, inline rename — for a host that wants the
  dashboard's look without reimplementing the rules; `SessionList` stays beside it for the
  plain fixed-set case.
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
- `packages/web` — dashboard (TanStack Router, hash history); create forms are engine-aware via
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
  point of the shape. `components/shell/SidebarFrame.tsx` is the chrome they share (view
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
  *browser* holds: theme and the three agent-view preferences (style, density, font). The run
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
  their own stale snapshot — and the session route both feeds it (`onVitals`, refusing while
  `document.hidden`) and reads it once at mount for the panel's catch-up row. The registry poll
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
- `packages/cli` — published unscoped as **`workerdeck`**, the turnkey instance (`npx
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
- `apps/docs` — Astro site → Pages via `docs.yml`. `examples` — dev entries with root-level deps
  the packages must not take, plus `dev-server.config.mjs`, which is what `pnpm dev:server` runs: dev
  goes through the real CLI, so there is no second server entry point to keep in sync (config
  files here stay literal — no env indirection, they are meant to be edited). `docs/assets` —
  brand assets (rules in `BRAND.md`); the mark is inlined in `BrandMark.tsx`, `Header.astro` and
  both favicons — keep geometry identical.
- `apps/vscode` — the VS Code extension (side-loaded `.vsix`; CI uploads it as an artifact,
  no Marketplace yet). A workspace member like any package (esbuild for the extension host,
  Vite for the webview, both from `@workerdeck/source`), importing `client`/`react`/`ui`/
  `protocol` and **never** `core`/`server`. The webview runs an *unmodified* `WorkerDeckClient`
  + `SessionPanel` (root entry — no Monaco; VS Code is the workspace): its `fetchImpl`/
  `WebSocketImpl` are postMessage shims, executed on the extension-host side with Node fetch /
  `ws` plus the gateway's `Authorization: Bearer` header — keys stay in `SecretStorage`, the
  webview CSP has no external `connect-src`, and the bridge refuses URLs not belonging to a
  registered gateway. It runs the panel with `transcriptVariant: 'lines'`, `focusComposerOnClick` (dead-space
  clicks land in the input; controls and drag-selections keep their meaning) and, by default,
  in the **editor font**: `workerdeck.fontFamily` is stamped on `<html>` by `webviewHtml`
  (it must be right on the first paint, which a postMessage cannot be) and repoints the ui's
  *sans* token; a change re-renders the panel through the same `reloadWebview()` the dev
  reloader uses. The **panel alone** opts in — the sidebar and section views are workbench
  UI and follow `--vscode-font-family`, which is the webview baseline `styles.css` sets. The
  window status bar is the panel's bar, and each of its three badges is its own boolean
  setting (`workerdeck.statusBar.*`), read per render so a change is just a re-render. Model
  and mode are bar items too, opening **QuickPicks** — a `StatusBarItem` has one command and
  no dropdown, so command → QuickPick is the only shape VS Code offers (and the one its own
  language-mode item uses); the panel's `onControls` setters are what they drive.
  One live attach per session, owned by the panel: sidebar/status
  bar/notifications read REST rollups (`pendingPermissionCount`) or tap frames already flowing
  through the bridge — never a second attach. Remote gateways mount as a `workerdeck://`
  FileSystemProvider over `/fs/*` (hash-guarded conditional writes; no mkdir/delete/rename —
  no such routes); local-vs-remote is decided from the gateway URL (`isLoopbackHost`), never
  by probing paths, which is also what makes `extensionKind: ["workspace","ui"]` the whole
  Remote SSH story. **No webview in this extension draws its own header, and no view has
  screens.** That is the navigation rule, and it is what the sidebar was rebuilt around: a
  pushed screen left the native title still reading SESSIONS over a form, its `+` still
  navigating sideways with no history, and a back chevron the extension had drawn itself.
  So chrome is VS Code's — `view.title` plus title actions gated on a `setContext` key (a
  stateful title button doesn't exist, so an open/closed toggle is *two* commands with
  opposite `when` clauses) — and everything that used to be a screen is either its own view
  or a native QuickPick. The Sessions view lists every gateway's sessions at once — gateway
  is a facet (filter/group/sort) beside adapter and state, not the frame — with search and
  the facet dropdowns behind the title bar's **filter toggle** (`$(filter)`/`$(filter-filled)`;
  the *host* owns that boolean, since the key lives where commands do, and closing the bar
  never clears the filters). **Gateways are their own collapsible view**, not a screen: a
  gateway is a mode every session belongs to, so managing them sits beside the list
  permanently, with the connected count in the view header's description. There is **no
  implicit localhost gateway**. Creating a session is a native multi-step QuickPick
  (`src/new-session.ts`: adapter → folder → optional first prompt, each step skipped when it
  has nothing to ask and backed out of with `QuickInputButtons.Back`), which is what let the
  list become a list and nothing else. The poll behind all of it is **ref-counted**
  (`SessionsModel.setWatching`) rather than gated on the sidebar alone — two independently
  collapsible views render it now, and gating on one leaves the other showing probes frozen
  at `pending`. The `+` in a view title is the *only* way to create: no body ever grows a
  second button for it, so an empty state points at the `+` in words and keeps its button
  for what the header can't do (clear a filter, widen a scope).
  The activity-bar badge is the same count summed over the sessions the **filter is
  showing** — the webview mirrors its view config to the host (`wd-view-config`, one-way;
  the shared rules moved to `src/view-config.ts` so both sides filter identically), because a
  badge counting rows in hidden sessions sends you looking for something that isn't there.
  The cards carry it per session — an **unread badge** of transcript rows since that session was last on
  screen (`src/watermarks.ts`, globalState, written **only while the panel is visible and
  showing it**, and monotonic so a compaction can't resurrect read rows). Rows, from
  `SessionInfo.activityCount`: turns undercount badly (five tool calls in one turn is one
  turn), `lastSeq` overcounts absurdly (every stream delta). Turns stay the fallback for a
  gateway too old to report it. The panel turns the same mark into catch-up. The window's open
  folders are a facet too, and the only one **on by default**: `workspaceScope()` turns them
  into scope roots, and a session is inside one only when the *gateway* could be — a `file:`
  folder scopes loopback gateways alone (a remote gateway's identical-looking path is another
  machine's directory), a `workerdeck://<hostId>` mount scopes that gateway alone. Because it
  hides by default it says so — and in **one** place: a `SubsetLine` under the filter bar
  reading `12 of 30 · <cause>` with a single "Show all", rendered whether or not the bar is
  open (`subsetSummary` in `view-config.ts` is the rule). It replaced two competing signals,
  a dot on the funnel and a separate scope line, which between them never said how many rows
  were missing; with the controls now behind a toggle it is the only thing standing between a
  scoped-by-default list and "my sessions are gone". A scoped-empty list still offers "show
  all folders" rather than the generic clear-filters dead end.
  **Resume** is the same QuickPick rails as create (`workerdeck.resumeSession`), diverging only
  at the last step: `listSdkSessions` for the chosen directory *and profile* — the engine store
  is per-engine, so another profile's ids mean nothing here — gated on the capability record's
  `listSessions`, and a pick is the same create call with `resume` set and no first prompt (the
  engine replays the thread; a prompt on top would be an unasked-for turn). A session rename is a gateway edit
  (`PATCH /sessions/:id` → `meta.title`), never a local override, so every client sees the
  same name; it is reached by double-clicking the title, with Stop and Delete as hover icons
  on the card's second line and state the first line's last item. `src/dev-reload.ts` is development-mode only: a webview rebuild
  re-renders the webviews in place, an extension-host rebuild reloads the window (VS Code
  cannot swap extension code in a live host). PRD: `_docs/plans/VSCODE-EXTENSION-PRD.md`.
- `apps/embedded` — **the reference embedding**, and the thing to read before designing another
  one: a wiki SPA whose right-hand rail is a sandboxed agent, with the gateway inside the app's
  own server. Everything non-`/v1` (the `/api` wiki, the MCP endpoint, the built SPA) is served
  through the gateway's `fallback`, so it is **one port** — a tab cannot header a WS upgrade, so a
  cookie is the only credential an attach can carry and a cookie is per-origin. `authenticate`
  turns the app's cookie into `{ scope: { user } }` and that is the *entire* ownership model: the
  SPA calls `listSessions()` with no filter, because a check the client performs is a check the
  client can skip. The agent runs the provider engine under `sandboxedProviderProfile()` raised
  exactly twice (`web_fetch`, the `wiki` MCP server) — no shell, no host FS, `eval_script` in an
  in-process QuickJS guest with no network. The wiki's operations are **one silkweave action set**
  (`src/wiki-actions.ts`) projected onto two transports: `@silkweave/mcp`'s mountable
  `mcpTransport` for the agent, and `@silkweave/trpc`'s `trpcNode()` (5.1.0 — a `node:http`
  handler, so it mounts on the gateway's own port rather than binding one) for the SPA, typed end
  to end via `InferTrpcRouter` with no codegen. That is the shape an app with many tools needs and
  the reason it was worth the dependency: `write_doc` and `PATCH /api/docs/:id` had been one
  operation spelled twice. **Identity resolves per adapter onto the same context key** — a
  per-session bearer token minted in `createEngineRunner` off `config.scope.user` (revoked in
  `onClose`) for MCP, the login cookie in `trpcNode`'s `authenticate` for the browser — so an
  action's `run()` cannot tell which caller it serves, and no wiki tool takes a `userId` the model
  could choose. `whoami`/`open_doc` are MCP-only: a shared action set is not an identical one, and
  the SPA knows what it is showing. The cookie makes `/trpc` CSRF-able, so `sameOrigin()` checks
  `Sec-Fetch-Site` (falling back to `Origin`) and **declines** rather than throws — a forged
  request falls through to a plain 401. **No operation depends on a field being absent**: `write_doc` (create when `id`
  was missing, overwrite when present) was split into `create_doc`/`update_doc` after a live model
  sent `id: " "` twenty times and every create tried to overwrite a document named `" "`.
  `z.string().min(1).optional()` is *not* the fix — a space has length 1, and a provider that marks
  every property required leaves the model no way to omit anything. Optional strings are trimmed
  and blank-checked in `run` (`text()` in `wiki-actions.ts`), as a second layer under the split. **UI state is the app's, not the bridge's**
  (`src/app-state.ts`): "which doc am I looking at" and "open that one for me" travel as a
  server-held per-*user* record the tab `PUT`s on change plus an SSE stream of intents back down
  — `whoami` / `open_doc` are two more MCP tools over the same token. The tool bridge looks like
  the natural home and is wrong twice: a bridged tool is by definition `sandboxed`, and the bridge
  asks the *first attached client*, so two tabs means an arbitrary one answers. `open_doc` reports
  `shown: false` when no tab was listening rather than claiming a navigation. Two gotchas it paid for in blood: the MCP
  client opens the SSE stream with `GET` and the stateless transport must answer **405**, not
  Express's default 404, or the whole connect fails; and a model told to omit an optional `id`
  sends `""` or `" "`, so no tool may infer its operation from an absent field. The MCP connect is
  `required: true` and the runner is built by `createProviderRunner` — this app is where both
  seams came from, and it was the thing dropping `ctx.id`. Storage is `node:sqlite`, one file,
  zero deps. `EMBEDDED_MODEL` (default `gpt-5.6-luna`) is env, not a constant; there is **one**
  provider and one key, deliberately — the openai-compatible branch was removed because every
  branch in a reference app is a branch a reader must hold that teaches nothing about embedding.
  The one thing still deferred upstream is an express-free
  `mcpTransport` mount; express stays here purely as a mounting mechanism for `/mcp` and the
  static SPA.
- `apps/ios` — native iOS remote control (SwiftUI + XcodeGen; invisible to pnpm/turbo — no
  package.json). `WorkerDeckKit/` is a hand-written Swift mirror of `packages/protocol` plus a
  client and a port of the react transcript reducer — protocol or transcript changes must be
  mirrored there (`WorkerProtocol.version` tracks `PROTOCOL_VERSION`); see `apps/ios/README.md`.
  The three agent-view preferences are mirrored too (`AppSettings.swift`): variant and density as
  environment values the rows read, and the font as one `fontDesign` on the session view — with
  the composer's `UITextView` told separately, since UIKit sits outside SwiftUI's font
  environment. In `lines` every row is one type size (`lineTextStyle`) and every marker is a
  character rather than an SF Symbol, because a terminal has one size and draws nothing.
  `SessionList.swift` and `Watermarks.swift` are two more such mirrors — protocol's sessions-list
  view model and unread model — so the phone's list is **one list across every configured
  gateway**, gateway as a facet rather than the frame, with search/facets/group/sort, the subset
  line, per-row unread and the app-icon badge summed over the rows the filter is *showing*. The
  scope filter is passed `nil` throughout: a phone has no open folders, so it is genuinely inert
  rather than hiding everything, and no fake scope is invented to fill the hole. Marks are only
  written while a session is on screen *and attached*, with a re-fetch-and-mark on disappear —
  the same discipline as the extension's `visibilityChanged`, and the thing an unread badge
  silently dies of if you skip it. Rename is `PATCH /sessions/:id` (`UpdateSessionRequest`'s
  title is three-state on the wire — set, explicit null to clear, absent to leave alone — so it
  is a wrapper enum, not a `String?` that would collapse the last two).
  Zero third-party Swift deps — including for hot reload, where InjectionNext is wired in
  through its prebuilt bundle and a dozen lines of `HotReload.swift` rather than a package;
  auth is the header transport (no cookie machinery). Assistant text renders through
  `MarkdownBlocks` (headings, lists, quotes, rules, fences; tables stay literal, and anything
  unmodelled falls through as prose rather than being lost) — the classifier is **line-local by
  design**, because the parser reruns on every streamed delta and a block that changed shape a
  token after it appeared would be worse than one that never rendered.
  **When you change the app, push it to the phone**: `apps/ios/scripts/deploy.sh` (build +
  install + launch, over Wi-Fi, no cable) — the point is that Tobias can follow along on the real
  device rather than read about a simulator screenshot. Add `--no-launch` and it works on a
  locked phone; launching needs it unlocked, and the script says so rather than dumping
  CoreDevice errors. For a screen that needs a live session to render at all, the `UIPREVIEW`
  harness renders it from canned data in the simulator. Both are documented in
  `apps/ios/README.md`.

Dependency direction: `protocol ← core ← queue ← server ← cli`, `protocol ← client ← react ← ui ← web`,
`sandbox` a leaf either side may use. The browser side (client/react/ui/apps) must never import
core/server, the Agent SDK, or any model SDK; `client` must never devDep on `react` — that edge is
the build-graph cycle turbo refuses.

## Tooling

**Always `roam index --force` before reading roam's output.** It takes ~4s on this repo (493
files, 4.8k symbols), and a stale index is worse than none: it reports metrics against a tree
that no longer exists, and the alerts read as findings about your change when they predate it.
One caveat when you do read it — this is a library monorepo, so a package's *public* exports
have no in-repo caller and roam scores them as `dead_exports`. That number is not a defect
count.

pnpm workspace + turbo (`pnpm typecheck|test|build|lint`); typecheck is `tsgo` (TS 7 preview) and
covers `smoke/` + `examples/` too via `typecheck:extras` (they have tsconfigs but aren't packages,
so turbo never ran them); lint oxlint; `build/` via tsdown only on `prepack`/CI. Dev never builds
— the `@workerdeck/source` export condition resolves packages to `src/index.ts` (Node runs with
`--conditions=@workerdeck/source` + swc-node; Vite/vitest set `resolve.conditions`, vitest also
aliases). In-package imports use explicit `.ts` extensions. Releases go through **pnpm only** —
`npm publish` would ship `workspace:*` verbatim; see the packaging section of `docs/GOTCHAS.md`
before touching versioning or the publish workflow.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn) + a scripted JSON-RPC peer
(`connectFn`) for `CodexRunner`; server: real HTTP+WS integration incl. job routes + webhook
receiver (codex via the test-only `engines` adapter override); queue: fake runner; react:
reducer + bridge e2e.
Real-SDK smokes cost tokens and never run in `pnpm test`, but permission-path or
CLI-control-request changes need one — the fake harness can't validate those payloads — and **an
engine's process contract can't either**: any change to `CodexRunner`'s spawn options,
handshake, or event mapping needs `pnpm smoke:codex`. Smokes live in `smoke/`: `smoke:sandbox` and
`smoke:codex --canary` are free; `smoke:live`, `smoke:sdk`, `smoke:media` (the only check that
the CLI accepts image/PDF/text attachment blocks at all) and the full `smoke:codex` are not.

## Wrapup Config

- check: `pnpm lint` + `pnpm typecheck`
- test: `pnpm test`
- push: yes — branch `master`, repo is public, and every push deploys the docs site.
- version_bump: yes — `pnpm version:set <x.y.z> && pnpm install --lockfile-only` (the 10 packages
  plus `apps/vscode`; `workspace:*` needs no bumping, so the lockfile step is a no-op). 0.9.0 is published
  (protocol **7** + the codex engine + the session-runner parity work; it absorbed the
  never-published 0.8.0). 0.10.0 added codex skills and generated images, the codex MCP panel and
  the session workspace. 0.11.0 published the VS Code extension, the session rename, the
  terminal transcript (virtualized, keyboard-first prompts) and the Iso Deck mark. **0.12.0** — the
  extension's navigation rebuilt around "no webview draws its own header and no view has
  screens" (native QuickPick create/resume, Gateways as its own view, a title-bar filter
  toggle), transcript density and the brand pulse in `ui`, the cross-client parity work (the
  sessions-list view model and unread model lifted into `protocol`, then taken to the dashboard
  and iOS), and the branding pass that retired "Claude Code sessions" for **coding agent
  sessions**; protocol stays **7**. The bump now
  covers `apps/vscode` too — `version:set` filtered `./packages/*` only, which is how the `.vsix`
  came to report 0.10.0 against 0.11.0 packages. **0.13.0** — cross-origin gateway auth
  (`hostAuth`, server CORS, the CLI's `--cors-origin`) and the dashboard rebuilt as four
  sections and a dialog, with jobs read-only behind `SessionPanel`'s new `readOnly` seam;
  tagged and pushed, so the publish workflow ran for it. **0.14.0** — session scope
  (`CreateSessionRequest.scope` + `authorizeSession`, enforced at every door, 404 on a miss),
  `EngineCapabilities.hostCwd` so a filesystem-less engine need not name a `cwd`,
  `sandboxedProviderProfile()`, and `apps/embedded` — the reference embedding. Bumped and
  committed, **tag not pushed**: nothing is on npm for it yet, so `npm latest` still reads 0.13.0
  until someone pushes `v0.14.0`. `version:set` now covers `apps/embedded` too — it is not
  idempotent (a re-run at the same version fails on "Version not changed"), so add a new workspace
  member to the filter *before* the bump, not after. Protocol stays **7**.

  **`package.json` is not the release record — npm and the *pushed* tags are.** Check all three,
  and use `git tag --sort=v:refname`: plain `git tag` sorts lexically, so `v0.10.0`–`v0.12.0`
  land *above* `v0.5.0` and a `| tail` reads the newest tags as the oldest. 0.12.0 had a local
  tag nobody had pushed, so npm's latest was still 0.11.0 while this file claimed it shipped. `git log v<latest>..HEAD` is the other half of the same
  habit — 0.9.0 sat on master for 15 commits *after* it had shipped.
- publish: yes — npm `@workerdeck` org, always through pnpm. Push a `v<x.y.z>` tag:
  `.github/workflows/publish.yml` runs `pnpm publish -r` under npm trusted publishing (OIDC, no
  NPM_TOKEN, automatic provenance), re-running the full CI gate, refusing a tag that disagrees
  with `packages/*/package.json`, and skipping versions already on the registry — a half-failed
  run is safe to re-run, and a prerelease tag goes out under `next`. Manual fallback is `pnpm
  publish:all`. Gatekeeper audit first. MIT (ui ships `src/` — allowlisted in gatekeeper.json).
- docs: root CLAUDE.md + README.md + docs/ + apps/docs (keep site content in sync with README)
- frontend_smoke: no (manual via `pnpm dev:server` + `pnpm dev:web`, which bind `$WD_DEV_HOST`
  and default to loopback — set it in your shell to reach them from a phone or tailnet, never in
  the committed script; `apps/embedded` has its own `pnpm dev`)
- co_authored_by: no (global)

## Auth red lines (non-negotiable)

WorkerDeck implements NO model-provider auth: credentials are resolved by the official SDK/CLI
from the operator's environment. Never add — and reject any PR that adds — claude.ai OAuth flows
or login UI, subscription-token extraction/storage/forwarding, Claude Code client-identity
spoofing, or multi-account pooling / rate-limit circumvention. Policy enforcement lives in
configuration (`requireApiKey`, the one-time 'oauth' notice, `apiKeySource` on
SessionInfo/system_init), never in tampering with the credential chain. **The same principle
binds the Codex engine**: `codex login` (or `codex login --with-api-key`) is the operator's job
in their own terminal; WorkerDeck never invokes it, never reads `auth.json`, and never wires an
API key into the child or over the app-server's account RPCs — the operator's session env is
passed through whole, but no env key is a credential route on this surface (`CODEX_API_KEY` is
read only by `codex exec`, which we no longer ship; the canary pins that), so availability
comes from `codex login status` alone, and the probe surfaces exit codes and fixed reason
strings only, never `codex login status` output (it contains a masked key fragment). Compliance/legal review is in progress — keep the README "Auth & Anthropic's terms"
section's status honest as things settle; whether OpenAI's terms restrict headless
ChatGPT-subscription codex use the same way is unresolved and mirrors the same posture.
