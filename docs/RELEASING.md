# Releasing

The wrapup checklist and the release ledger. Dispatched from `CLAUDE.md`.

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
  `sandboxedProviderProfile()`, and `apps/embedded` — the reference embedding. **Never released**:
  bumped and committed but never tagged, so nothing under that number reached npm and its content
  ships inside 0.15.0. The registry goes 0.13.0 → 0.15.0, and that gap is deliberate — do not
  publish a v0.14.0 after the fact. `version:set` now covers `apps/embedded` too — it is not
  idempotent (a re-run at the same version fails on "Version not changed"), so add a new workspace
  member to the filter *before* the bump, not after.
  **0.15.0** — the embedding seams the DEV-UX assessment asked for: a loud MCP failure
  (`connectMcpTools`'s `required`, `McpConnection.servers`, a build that refuses a declared server
  that is not there, and `provider.mcpStatus` flipping to `true` so `/sessions/:id/mcp` answers
  instead of 501ing), `createEngineSession({ tools })` at a stated trust, `seedVfs`/`id`,
  `createProviderRunner`, `requireAvailableProfile`, and `SessionPanel`'s `toolHost`. Plus the
  documentation half — a "Rules you cannot infer from the types" section in every package README,
  and three new pages in `apps/docs` (the app-embedding guide, engines-and-executors,
  writing-tools) — and `apps/embedded` rebuilt on one silkweave action set behind two adapters.
  Protocol stays **7**.
  **0.16.0** — the terminal theme *adopted*, and the `lines` variant deleted. The theme itself
  landed unreleased in 0.15.0's tail; this is every client on it: the VS Code dock (at the
  editor's own cell, `--cw-font-mono` repointed at the editor font, three new
  `workerdeck.terminal.*` settings), the dashboard (Settings → Agent view style → Terminal, with
  a stored `lines` migrating to it), and `apps/embedded`'s rail. Plus what adoption needed —
  `SessionPanel.terminalMetrics` feeding all three of its terminal surfaces, and the composer's
  own terminal form (`>` in the gutter cell) — and what it let go: `'lines'`, `useLines`,
  `LineGlyph`, `line-prompt.tsx` and every `lines` branch, including `Response`'s sixty
  `!important` overrides (157 lines → 28). `apps/ios` keeps its own `lines`: a Swift terminal
  renderer is a separate track, and deleting the phone's only compact view for symmetry with a
  package it shares no code with would be a regression, not parity. The dashboard's frame also
  became **one surface** (`.app-frame` repointing `--bg`/`--bg-surface` at `--sidebar`).
  Protocol stays **7**. It also carries the **per-account plan meters** (`ProfileInfo.usage`,
  `mergeUsage`, the pace marker), the extension's **session restore and resume-keeps-its-name**,
  the refactor pass that gave `core`/`react`/`server`/`web`/`embedded` folders that say what a
  file is, and a last round of client polish: the VS Code create flow rebuilt so every step
  arrives pre-answered (adapter → folder → model, no first-prompt step,
  `workerdeck.newSession.permissionMode`, and the window's folders finally leading the cwd
  candidates), the dock's usage meters gaining the pace marker the other two clients already had,
  the scrubber marking a **failed tool call**, and the two verbosity fixes the terminal theme
  needed to be readable against a real session — a collapsed tool result clipped by **characters**
  as well as lines (a minified MCP reply is one line, so the old four-line slice kept all thirty
  thousand characters of it) and the shell fold widened to **any run of consecutive tool calls**.

  **0.17.0** — the release the two entries below were held back for, cut once the verification debt
  they were gated on was cleared (see the verification paragraph at the end of this section).
  Everything from here to that paragraph ships under this number; it is a **minor** — additive
  throughout, `persistLive` defaults off, absent `subagents` means empty, and protocol stays **7**.
  Riding there too, from the sidebar/prompts session: **project identity**
  (`.workerdeck.json` → `SessionInfo.project`, the ancestor walk, the icon route, the `project`
  facet), now **drawn on all three clients**. The VS Code sidebar took it first — a card's second
  line reads the project in place of the cwd basename it was only ever a proxy for — and the repo
  grew a `.workerdeck.json` of its own so the walk, the route and the wire have all been exercised
  against a real file rather than only a fixture (the icon route had never served a byte). The
  dashboard followed, via `SessionBrowser` and `useProjectIcons`. **iOS** was the biggest of the
  three and is the one that diverges: the whole facet had to be mirrored into `WorkerDeckKit` first
  (`ProjectInfo`/`ProjectIcon` with a hand-written `Decodable`, the `project` case in
  `Facet`/`GroupBy`/`SortBy`, `ViewConfig.projects`, `projectKey`/`projectLabel`/`projectsOf`,
  `WorkerClient.projectIcon`), and then the **row deliberately does not follow the other two**: the
  phone is the only client that draws the *whole cwd*, so replacing it with a name would remove
  information the others never had. Line two prefixes instead — `WorkerDeck · packages/ui` — with
  the relative half dropped when the session sits at the root (it would say one thing twice) and
  when the cwd is not under the root at all, which is not paranoia: `root` is the gateway's
  **realpath'd** directory and `cwd` is the path as given, so a session started through a symlink
  has a perfectly good project and no computable relative path. Two platform facts shape the rest.
  **Apple cannot decode an SVG from bytes** — `CGImageSourceCopyTypeIdentifiers()` lists 62 types
  and none is SVG; asset catalogs convert at *compile* time, which a downloaded blob cannot use —
  so an `image/svg+xml` icon degrades to the name alone, and a repo that wants its mark on the
  phone must declare a **PNG**, which is why this one now does (`docs/assets/icon.png`, regenerated
  per `BRAND.md`). Rasterising **on the gateway** was considered and rejected, and the reason is
  worth keeping: the icon route deliberately parses nothing — it serves bytes with `nosniff` and an
  attachment disposition precisely so a hostile file is inert — and the session cwd *is* the agent's
  working tree, so converting would mean running an SVG parser over agent-writable input on the
  shared gateway, where the CVE history is long and the blast radius is every user of it. It would
  also have to bake one colour scheme, losing the `prefers-color-scheme` adaptation the web clients
  get for free. A `WKWebView` snapshot on the phone is the answer if this ever needs solving
  properly (it parses in the client's own sandbox, exactly as an `<img>` already does on web, and
  the cache is already once-per-hash-for-the-process) — not built. And the **glyph arm is a vocabulary translation, not a bundle-size
  trade** (`ProjectGlyphs.swift`): lucide does not exist on iOS, so 111 names are mapped to SF
  Symbols, every one validated against `CoreGlyphs.bundle/symbol_order.plist` because a guessed
  symbol name renders *nothing* rather than failing to compile — and then checked **again at
  runtime** with `UIImage(systemName:)`, since this Mac's catalog is newer than the app's iOS 17
  floor and a name valid here can be absent on a phone. Both fall back to `folder`, which is what
  protocol's `ProjectIcon` requires of every client. `UIPREVIEW=projects` is the fixture that
  proves all of it. The **`sessionState` fix** (a
  background sub-agent now counts as `working`, on both platforms, plus the Swift `SubagentInfo`
  mirror that had never existed), the VS Code sidebar's **card redesign**, and the iOS **prompt
  scroll + terminal prompts + filter-menu** fixes. Protocol stays **7** throughout. Master also
  carries **live-session persistence** (`parking.persistLive`, `Runner.snapshot()`,
  protocol's `snapshotRetains`, `kind: 'live'` records, `apps/embedded` turned on) plus vitest in
  `packages/ui`, and **sub-agents made visible** (`forwardSubagentText`, the reducer's per-agent
  streaming singleton, the terminal theme's `Task` fold, `SessionInfo.subagents` +
  `SubagentTracker`, the extension's expandable rows and subagent status item). Both are held back
  from a bump on purpose, and for the same reason: each is proven against a harness that authored
  every event it feeds — a mock model and a fake runner for parking, the fake `queryFn` for
  sub-agents — so the tests confirm the *fold* and say nothing about the real CLI's stream shape or
  whether the app boots with a key. **That gate is now open: the debt was cleared 2026-08-20** (see
  the verification paragraph at the end of this section).
  The change is a **minor** (additive, `persistLive` defaults off, and absent `subagents` means
  empty). Protocol stays **7** — `replayRetains` and the `sdk_event` coalesce key are gateway-side
  rules with no wire shape, so a client that has never heard of them is bit-identical after the
  fold, which is exactly what their property test asserts. The **scrubber's failure semantics and its
  two channels** ride there too and are proven the way the theme's pure logic always is (unit tests
  on both platforms): a failure is an *outcome* (`taskFailed` is the task's own, `runFailed` is a
  folded run's last call), an item that *shares* a row marks as a tick at its fraction of it rather
  than inheriting an extent that is mostly other items' work, and the two lanes became **channels** —
  input left (prompts + a green band per sub-agent, drawn from membership and never the spawner's
  name), output right (the answer, and every failure that produced one). The same session also found and fixed
  `SubagentTracker`'s mis-reading of the SDK's *async* agents (above), which is the one piece of
  this ledger proven against a **real captured log** rather than an authored one. A **structural
  pass over the iOS terminal surface** rides there behind it (`_docs/refactors/`), called after
  seven of eleven commits in one session turned out to be incremental fixes to the same three
  files, and it is three seams rather than a tidy-up. `ExpansionKey` replaced a stringly-typed
  protocol whose trap had already cost a bug: a block's `key` is its **row identity** (produced by
  the fold, mirrored in web's `blocks.ts`, used for diffing and the plan cache) and coincides with
  an expansion key for only two of five block shapes — an `.item` call's row key is
  `toolCall:<id>` while what opens it is `call:<id>`, and a run of one is *drawn as the call*, so
  its `run:<id>` opened nothing. Typed, `expansion.isOpen(block.key)` does not compile, row keys
  stay `String` so web parity is untouched, `full`/`pending` became **call ids** (there is no
  fully-expanded run) which deleted the `dropFirst("full:")` surgery from two files, and the
  run-of-one rule is now `TerminalRunBlock.expansionKey: ExpansionKey?` — an `Optional` the
  compiler asks about rather than a comment that had to be obeyed. `blockCalls(in:expansion:)` is
  the **one walk of a block**, where the item/run/task/task-children switch had been written four
  times (`redItemIndices`, `expansionKeys`, `truncatedCallIds`, the planner); its `ownLine` flag
  *is* the fold rule stated once, which is what makes "if it is red in the transcript, it is red on
  the rail" a fact the rail reads rather than a claim that two derivations agree — `redItemIndices`
  is four lines now and `truncatedCallIds` is gone. And `ScrubberRegion`/`ScrubberRail` split
  **ground from points**: `.expanded` had been a `ScrubberMarkKind` needing three exemptions from
  the mark machinery within an hour (skip the fractional `RowPosition` rule, never merge, paint
  first) plus a loudness rationale, which is a type saying it is the wrong type. Regions paint
  under, marks over, and the order is structural instead of a `sorted(by:)` in the view; a latent
  bug went with it, since a band spanning hundreds of points could win the press over the very
  marks inside it. The web/iOS **expansion divergence is now decided and written on both sides**
  (`height.ts`'s first invariant and `TerminalExpansion.swift`): expansion is per-row `useState`
  there and a planner input here, closing it either way costs one client its central
  simplification, and that inversion is exactly *why* this rail can be expansion-aware and the web
  rail cannot. The pass was then **reviewed adversarially** — the reviewer reconstructed the
  pre-refactor functions from `git show HEAD` and diffed them against the new ones over 2,000
  randomized transcripts, which is what makes `ownLine`'s equivalence verified rather than argued —
  and the most instructive thing it found is that the fix for the fold walk had *re-offered the very
  trap the typed key was built to kill*, one namespace over: unifying on `blockCalls` made
  `expansionKeys` emit `.call(taskId)` for a `Task`'s header, and `planTask` never plans a task's
  own result. Hence `BlockCall.drawsResult`, false for exactly that one thing. Two seams went with
  it: the rail was rebuilt inside `TerminalScrubberView.body` while `peek`/`dragging` were `@State`
  on the same view, so one drag re-ran `scrubberMarks` + `redItemIndices` + `expandedRegions` per
  **touch event** over the whole transcript — the same lesson as the replay counter above, in a
  gesture instead of a stream, and the file already knew it (`ScrubberBandView` exists for exactly
  that reason; the peek was on the wrong side of the split, now `ScrubberTouchLayer`); and
  `TerminalTranscriptModel.plan(at:)` passed the whole expansion where the book had cached a height
  planned from `subset(for:)`, which made "the lines drawn are as tall as the height reserved" —
  the one claim this renderer cannot get wrong — rest on two derivations agreeing. Riding there too, and **not** subject to that debt: the iOS
  **native Swift terminal renderer** (phase 1 — virtualized, deterministic heights, the folds,
  diffs; `lines` deleted there as on the web) and the iOS **replay hold**. Those two are the
  opposite case — built, then run on a real device against a real session, which is how the
  open-a-session flicker was found and fixed. Phase 2 rides there too: **tap to expand/collapse**
  (`TerminalExpansion`, an *input to the planner* rather than cell state, because a
  `UICollectionViewLayout` takes every frame from the height book) and the **scrubber** (the port
  of `buildClusters`/`railScale` into the kit, where their two shipped pure-logic bugs are
  testable). Both are on the phone; both have one gesture the simulator could not be driven to
  exercise. Phase 3 rides there now too: the renderer is **hand-rolled UIKit**
  (`TerminalRowCell`, three views per row instead of two SwiftUI views per *line*) with the body
  as **one selectable TextKit run** — selection within a row works, across rows is still open —
  gated by a second audit claim, `measureHeights`, since a wrong `lineFragmentPadding` puts every
  row a fraction off with nothing visibly wrong. Beside it: the **sticky prompt**
  (`StickyPrompt.swift`, arithmetic in the kit because a view cannot be tested, and its first test
  caught the frame-vs-content offset bug), and the **replay hold made honest** — a deadline that
  extends while `lastSeq` advances rather than a flat 1.5s that fired on exactly the sessions the
  hold exists for, the *whole reduced state* held rather than the transcript view (approvals and
  meters used to flicker through the session's history on every open), and a `seq / target`
  counter in place of a blank screen — which then turned out to be **most of what a session open
  cost**. Opening a session took 2–3s on the phone against under 50ms in VS Code, and the
  measurement (`AttachProfile`, plus two opt-in kit benchmarks that ruled out the fold at 6ms and
  the `@MainActor` receive loop at 0.05ms/event) put it somewhere nobody would look:
  `TranscriptViewModel` is `@Observable`, `replayHold` was a stored property on it written back on
  **every applied event**, and the `seq / target` counter was computed from it — so 818 replayed
  events meant 818 layout passes of a spinner and a formatted number. **1,692ms → 126ms** once the
  hold's own state became `@ObservationIgnored` (still exact — it ends on the stated seq, and
  nothing in `ReplayHold.swift` changed) and the screen was told ten times a second instead. The
  rule generalizes and is the one worth carrying: **a per-event write to observed state, on a path
  that replays hundreds of events, costs a render per event** — which is also why the hold now
  *lands* rather than expiring on its 1.5s stall backstop, having previously been held open by its
  own rendering. The web client is clear of the same pathology by construction (its placeholder is
  prop-stable and count-free, and the catch-up count is gated on `!replaying`), though it does
  dispatch per replayed event — bounded by virtualization — and `onVitals` fires per event with
  it, which in the VS Code webview is a `postMessage` per replayed event. The **cold plan** is
  parallel now (`TerminalHeightBook.lineCounts`, 690ms → 154ms at 16k rows), which was the other
  half of that wait. Brief for what is left — cross-row selection — in
  `_docs/features/ios-terminal-selection.md`. They also touch **no published package**: the phone
  app is side-loaded from this repo and has no `package.json`, so `version:set` does not reach it
  and a bump neither helps nor hinders it.

  Riding there too: **on-demand tool results** (protocol's `ToolResultBlock.truncated`,
  `replaySlice`, `/events/:seq/result`, `loadFullResult`, the press in both themes, and now the
  phone — `TerminalExpansion.pending`, the third expansion state, because a head's "show
  everything" is a network round trip and planning from `total_chars` would invent a line count
  for text nobody has seen). Its property is tested as an *inequality*, which is what the rest of
  this family cannot say: a truncated replay's fold differs from the full one in `result.text` and
  three markers and **nowhere else**, and hydration restores exact equality. The server test
  asserts backward compatibility rather than arguing it (an attach with no param is byte-identical
  to before). Protocol stays **7**: the marker can only reach a client that asked for it.
  **Its justification, however, did not survive being measured.** Re-run 2026-08-19 against the
  session every number came from, the cut was **9 KB of 3,101 KB — 0.3%**, not 68%: the three
  giant frames are base64 **screenshots**, the text rule deliberately does not touch non-text
  parts, and of 176 `tool_result` blocks only four hold more than 8,000 characters of text. The
  projection had measured `JSON.stringify(content).length`, counting base64 as text. The mechanism
  is right and worth keeping; what it cut is small, and the 2.1 MB that is really there — parts
  every client ships and then discards, `blockText`/`joinedText` keeping text only — is a separate
  rule of this same family, and was measured four ways before it was acted on: **91% of all tool-result payload across 214 local sessions is base64** (44 MB text vs
  458 MB), present in **189 of 215**, and **`Read` produces two thirds of it** — an agent looking
  at a PNG, not a browser tool — so it is not a niche. The control session is the argument: same
  order of tool calls, more text, **771 KB of attach against 4,550 KB.** The lesson belongs beside
  the feature: **no other rule in this family has been measured after shipping.**

  That lesson was then acted on rather than filed. Riding on master too: **image parts replay as
  references** (`ImageRefPart`/`imagePartRef`, `refImageParts`, `?part=N` on the existing route,
  `result.images`, a fixed 12-line box in both web themes and on the phone) — the family's seventh
  rule, and **the first measured on the wire before it was called finished**: 4,548 KB → 1,275 KB
  and 4,299 KB → 1,186 KB on two real sessions, a no-images control byte-identical, and the
  tool-result text char-identical in every case. Protocol stays **7** (its own opt-in, so a client
  that never asked cannot receive one). It carried two things worth keeping separately: the
  `SubscriberSet` refactor, which gave the *live* fan-out the one home `replaySlice` had already
  given the replay; and a `packages/ui/dev` fixture (`image refs`), because a row type the
  playground cannot draw is a row type its two audits do not gate. Beside it, a **session-status
  fix**: a turn ending under a standing approval had its turn-over signal *discarded* rather than
  deferred, and the settle path asserted `running` — so an interrupted or timed-out turn left the
  session claiming to run, on every client at once, permanently, because status is edge-driven with
  no reconciliation. Reproduced by test first, then fixed; see `docs/GOTCHAS.md` §Permissions.

  Cut with a **dependency sweep**: `pnpm audit` went 23 advisories to **zero**. The ones that
  mattered were the ones rendered from model output — `streamdown` (the transcript's markdown) and
  `monaco-editor` pinned mermaid and dompurify below their fixed versions, and both ship to a
  browser — overridden in `pnpm-workspace.yaml`, **not** under a `pnpm` key in `package.json`,
  which pnpm 11 ignores with only a warning. The rest was `apps/docs` build tooling, taken with an
  astro 5 → 7 major that broke exactly one thing worth naming: `index.astro` read
  `packages/cli/package.json` with `readFileSync` relative to `import.meta.url`, which held only
  while that URL was the source file — astro 7 prerenders from a bundled chunk, so the same four
  `../` resolved into `apps/packages/` and the build died. A plain JSON import cannot care where
  the chunk lands.

  **The verification debt this ledger has twice deferred a bump on was cleared 2026-08-20**, and
  clearing it changed three claims above rather than merely confirming them.

  The restart is a command now — `pnpm smoke:restart [claude|codex] [noprofile] [swept] [all]`
  (`smoke/README.md`) — spawning its own gateway on its own port and state dir, because the machine
  that develops this routinely has one hosting the session doing the verifying. Both engines pass
  (claude 14/14, codex 11/11), and the check that carries it is a word the model is given *before*
  the restart and asked for *after*: a session rebuilt rather than resumed attaches cleanly and
  replays nothing, so nothing else separates the two. **The codex rehydrate had never been run and
  it works.** Three things the code's comments did not say came out of it, all now in
  `docs/GOTCHAS.md`: `ANTHROPIC_API_KEY` in a gateway's environment silently kills claude turns (the
  CLI leaves the subscription, `plan_info` stops, the turn never completes — indistinguishable from
  a hang); the dormant write is async and **codex emits no `system_init`**, so its first record only
  lands on the post-turn status change and a kill inside that window loses the row entirely; and a
  **swept engine store does not 404 as this was documented to do** — the attach succeeds, the
  transcript is empty and the next turn is silently never answered, which is quieter than an error
  and worse.

  On-demand tool results were pressed against a real gateway on both renderers and on the phone,
  and the parked-session arm of `/events/:seq/result` — previously "covered by reading the code" —
  now has a test that proves it went through the snapshot (`registry.get()` is undefined at fetch
  time and the fake runner has no `eventAt`). The press exposed the trap worth carrying:
  **`truncateResults` is replay-only**, so a live row's marker is the renderer's display clip and
  pressing it touches no network, while a reloaded row's is the wire truncation — identical on
  screen. A verification pass concluded the feature was broken on the provider engine on exactly
  that mistake before the network panel corrected it. The **`… fetching N chars` interstitial has
  now failed to be observed on all three surfaces** because every fetch completes too fast to draw
  it; whether a state nobody can reach earns its code is a decision nobody has made.

  `apps/embedded` was run end to end with a real key — restart at rest and mid-turn, the session
  returning **idle** without re-running the interrupted turn — and it was broken before it was
  verified: the wiki's data had moved onto tRPC at `/trpc` while `vite.config.ts` proxied only
  `/v1` and `/api`, so Vite answered `index.html` with a **200** and every document query silently
  parsed HTML as JSON. `pnpm start` was unaffected, so the reference embedding was broken only in
  the mode anyone reading it would run (`docs/CLIENTS.md`). On iOS the press works and its hit
  target is generous, but verifying it found a **tap-versus-scroll bug**: `allowableMovement` cannot
  catch a stationary finger over a moving transcript, since a tap recognizer measures movement in
  *window* coordinates. Fixed natively in `TerminalRowCell`. And `useClaudeSession`'s attach
  decisions were extracted into pure `planAttach`/`shouldWriteParting` (`lib/attach-plan.ts`,
  17 new tests, react 196 → 213), which closes the "no hook render test" gap without putting jsdom
  into a headless package. **No package's public API changed.**

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

