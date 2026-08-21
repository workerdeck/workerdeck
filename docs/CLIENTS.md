# Clients

The three first-party clients beyond the dashboard: the VS Code extension, the reference
embedding, and the iOS app. Dispatched from `CLAUDE.md`.

## `apps/vscode`

the VS Code extension (side-loaded `.vsix`; CI uploads it as an artifact,
no Marketplace yet). A workspace member like any package (esbuild for the extension host,
Vite for the webview, both from `@workerdeck/source`), importing `client`/`react`/`ui`/
`protocol` and **never** `core`/`server`. The webview runs an *unmodified* `WorkerDeckClient`
+ `SessionPanel` (root entry — no Monaco; VS Code is the workspace): its `fetchImpl`/
`WebSocketImpl` are postMessage shims, executed on the extension-host side with Node fetch /
`ws` plus the gateway's `Authorization: Bearer` header — keys stay in `SecretStorage`, the
webview CSP has no external `connect-src`, and the bridge refuses URLs not belonging to a
registered gateway. It runs the panel with `transcriptVariant: 'terminal'`, `focusComposerOnClick` (dead-space
clicks land in the input; controls and drag-selections keep their meaning) and **at the
editor's own cell**: `terminalMetrics` is resolved host-side from `editor.fontSize` /
`editor.lineHeight` (the same three readings VS Code makes of the latter — 0 automatic, <8 a
multiplier, else pixels — rounded, because a fractional cell puts every other row on a
half-pixel), overridable per `workerdeck.terminal.fontSize`/`.lineHeight`, so the panel, the
editor and the integrated terminal draw at one size. Everything the first paint needs is
stamped on `#root` — variant, density, cell, affordances — and a change to any of them, or to
the two `editor.*` keys, re-renders the panel through the same `reloadWebview()` the dev
reloader uses. The webview repoints `--cw-font-mono` at `--vscode-editor-font-family`
unconditionally, which is what makes "the agent panel is in my editor font" true under a theme
that is monospace by construction; `workerdeck.fontFamily` survives for the `cards` variant,
where the *sans* token is what the transcript reads in, and is stamped on `<html>` by
`webviewHtml` because it must be right on the first paint. The **panel alone** opts in — the
sidebar and section views are workbench UI and follow `--vscode-font-family`, which is the
webview baseline `styles.css` sets. The
window status bar is the panel's bar, and each of its badges is its own boolean
setting (`workerdeck.statusBar.*`), read per render so a change is just a re-render — usage is
three of them now (`sessionUsage`/`weeklyUsage` on, `modelUsage` off, over protocol's lanes),
and a lane with no window hides rather than showing a dash. A running session colours its
status badge via the **foreground** (`charts.blue`), not a background: VS Code accepts only
`statusBarItem.errorBackground`/`warningBackground` and silently ignores anything else, and
both are alarm colours for a session that is merely working. Model
and mode are bar items too, opening **QuickPicks** — a `StatusBarItem` has one command and
no dropdown, so command → QuickPick is the only shape VS Code offers (and the one its own
language-mode item uses); the panel's `onControls` setters are what they drive.
One live attach per session, owned by the panel: sidebar/status
bar/notifications read REST rollups (`pendingPermissionCount`) or tap frames already flowing
through the bridge — never a second attach. A Cmd/Ctrl-clicked path in the transcript goes
through `webview/paths.ts`, which is a named module because the rule earned one: a match must
start at a **token boundary** (unanchored, `@_docs/BACKLOG.md` matched the *suffix* `/BACKLOG.md`
and the host confidently opened at the filesystem root) and a *relative* path must end in a
filename-with-extension, or the modifier underlines `and/or`. Resolution against the session
cwd is host-side, in POSIX arithmetic — the cwd is the *gateway's*, so a Windows host joining
it with `\` builds a path neither side has seen. Remote gateways mount as a `workerdeck://`
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
(`src/new-session.ts`: adapter → folder → model, each step skipped when it
has nothing to ask and backed out of with `QuickInputButtons.Back`), which is what let the
list become a list and nothing else. Every step arrives **pre-answered**, so the flow is
three `enter`s: the folder from this window's open folders, which lead the candidates
*unconditionally* now (the `local` test survives as the hint, not as a filter — a gateway on
a LAN or tailnet address may well be this machine, and offering `~/projects` to someone
sitting in `~/projects/ai/workerdeck` was the bug; a `workerdeck://` mount stays filtered to
its own gateway, being positively another machine's directory rather than merely unverified);
the model and the permission mode from **the session that adapter ran last**, read back off
the gateway's session list rather than remembered at create time, because an operator who
switched either one *mid-session* did it through the in-session pickers and a stored copy of
what they asked for at creation would not know. Mode is a default and never a step — two
questions is one too many for a flow whose point is that `enter` gets you a session — with
`workerdeck.newSession.permissionMode` to pin it ("always start on Auto") and a clamp against
the profile's own capability record, since a mode carried over from another engine would be
refused by the gateway. The **first-prompt step is gone**: interactively you are about to be
looking at a composer, and it was load-bearing for a real bug (a woken session re-ran
`config.prompt`). The poll behind all of it is **ref-counted**
(`SessionsModel.setWatching`) rather than gated on the sidebar alone — two independently
collapsible views render it now, and gating on one leaves the other showing probes frozen
at `pending`; the unread status-bar item holds a watcher of its own, unconditionally while
it is enabled, because it is the one surface that must be live with nothing open. The `+`
in a view title is the *only* way to create: no body ever grows a
second button for it, so an empty state points at the `+` in words and keeps its button
for what the header can't do (clear a filter, widen a scope).
**There is no activity-bar container.** The views are split across the two sidebars by
default: **Sessions** into **Explorer**, beside the file tree (it is a workspace-level list,
and it is where the `+` lives), and the other five into a **`secondarySidebar` container
titled "WorkerDeck"** — one tab, stacked vertically, Usage → Context → MCP Servers →
Session Info → Gateways. The four detail views are `when`-gated on `workerdeck.hasSession`:
they are *about the thing you have open*, which is Outline and Timeline's shape. That gating
reverses the earlier "views must not appear and disappear under the pointer" rule on
purpose; Sessions and Gateways stay ungated, which is what keeps both containers' shape
stable. `viewsContainers.secondarySidebar` is what sets `engines.vscode` to **`^1.106.0`**:
it was proposed-only in 1.104/1.105 and finalized in 1.106, and the schema is
`additionalProperties: false`, so on an older build the key is dropped and the five views do
not exist at all. That floor is the whole cost of the layout, and it is what would keep the
extension off a Cursor/VSCodium built on an older base. Two things a contributed location
cannot do: it cannot order a view against a *built-in* one (extension views append after
`workbench.explorer.fileView`, so Sessions lands under the tree until someone drags it up),
and it cannot beat a user's stored `views.customizations` — anyone who has already moved
these views needs **View: Reset View Locations** before a new default is visible. Everything
is only a default: any view drags to either sidebar or the panel, and `contextualTitle` is
what names the container it lands in (VS Code otherwise auto-assigns the *source*
container's title, which is how six views dragged out of Explorer all came up "Explorer").
Unread therefore had to leave the container: a `view.badge` aggregates onto its
**container's** icon, which is now Explorer's, next to a user's files. It is a **window
status-bar item** (`UnreadStatusItem`, `workerdeck.statusBar.unread`), the same count summed
over the sessions the **filter is
showing** — the webview mirrors its view config to the host (`wd-view-config`, one-way;
the shared rules moved to `src/view-config.ts` so both sides filter identically), because a
badge counting rows in hidden sessions sends you looking for something that isn't there.
Two things the move bought: the count no longer needs the Sessions webview to have been
resolved (there is no `#view` guard on `refreshUnread`, and `#viewConfig` is restored from
globalState for exactly that case), and sessions awaiting a human can *colour* it amber
rather than only leading its tooltip. `SubagentStatusItem`
(`workerdeck.statusBar.subagents`) sits beside it on the same argument — it is about *every*
session and is most worth showing when nothing is open, since a window with no panel up can be
spending real money on six parallel agents — counted in the same pass over the same filtered
rows, hidden entirely at zero, and coloured on the **foreground** (`charts.blue`) because VS Code
ignores every background but the two alarm ones. Either badge keeps the poll watcher alive:
gating it on `unread` alone left someone who turned unread off watching a frozen count.
The list is drawn as **inset rounded cards** (the Figma sidebar design), and it reverses two
rules the row's own comments once stated, deliberately. The **state glyph leads the title**: the
earlier rule optimised for reading one row, this one for scanning twenty, and the glyph is what
tells you which row to read — an idle row's title dims with it, since spending full contrast on
twelve of them is what made the one that is working hard to find. And **selection is the card's
own fill** rather than a gutter bar, the card being an inset shape with air around it, which
leaves the left edge to the glyph. Line two is the engine's mark and model in the **vendor's own
colour**, then the **project** and gateway muted — the project having replaced the cwd basename in
that slot, because the folder was only ever a proxy for the question the project name answers
(`projectLabel` falls back to exactly that basename, so an undeclared project is byte-identical
to what shipped). Its icon rides *inside* the same truncating span rather than holding a slot of
its own: the parts have a priority order and one ellipsis honours it, where flex children each
shrink a little and leave four half-words. The **age moved up to line one**, where the spec puts
it and where the other two clients already had it: line two is now a run of *identity* — engine,
model, project, gateway — and the age was the one part of it that kept changing while you read.
Grouping by project **suppresses it on the row** and
hands the slot back to the basename — `ui`, `server`, `web` under one WorkerDeck heading, which
is the one thing the header cannot say — exactly the rule `hostName` already followed one facet
over, and the answer to "what about the subdirectory". Icon bytes come from the host
(`src/project-icons.ts`, keyed by content hash, cached forever because a hash cannot go stale,
failures cached too), pushed as their own `wd-project-icons` message rather than on
`SidebarState`: the state rides a 1.2s poll and an icon is hundreds of kilobytes that changes
when someone edits a repo. That coral survives this webview's `--term-mark` repoint
("a single coral element in an otherwise theme-following surface looks like a stray token")
because it is doing a different job — that rule retired coral from the *panel*, where it meant
"working" and competed with the editor's accent for a meaning the editor owns, while here it
sits against Anthropic's mark and names the vendor. It is carried by the **mark and the model
together** — neither alone identifies a vendor at 13px — which is why the class goes *on* the
`EngineIcon`: it draws `fill="currentColor"` and carries its own `text-fg-3`, so a colour
inherited from a wrapper loses to the svg's own class, and the mark sat muted beside a coral
model from the day the cards shipped. **One token per vendor** (`--vendor-claude`,
`--vendor-openai`, two values each for the two grounds), which reverses the original "gated to
Claude alone". Those tokens and the two maps that read them now live in **`packages/ui`**
(`theme.css`, `vendorMarkClass`/`vendorTextClass` beside `EngineIcon`) rather than in this
webview's stylesheet, since all three clients wear them; they are registered as real Tailwind
colours, not hand-written classes, because `cn`'s tailwind-merge only *replaces* a colour it can
parse and the vendor class has to win against `EngineIcon`'s own `text-fg-3` rather than merely
follow it in source order. The two vendors are **asymmetric, and that is the brands' doing rather than ours**:
coral is Anthropic's accent, while OpenAI's guidelines forbid adding colour to the mark at all, so
theirs is monochrome: **`#fff` on dark, `#373737` on light** — both sanctioned by that guidance,
and the only kind of pair legible on both grounds (the light value is their near-black rather than
`#000`, which also keeps a 12px mark from sitting harder than the `#1f1f1f` title above it) (a green was tried first and is simply wrong, however well it
reads). That full contrast also decides **how far the colour reaches**: Anthropic's covers the mark
*and* the model name, OpenAI's covers the **mark only** (`vendorMarkClass`/`vendorTextClass`), because a
pure-white 11px model name is brighter than the session title above it and inverts the card's
hierarchy to repeat something the mark has already said — which is also the most literal reading
of "don't add any colors". Both lines also share **one 14px icon gutter** (`Gutter`), because the
state glyph is 14px and the vendor mark 12px: as plain flex children each line's text started at
`icon + gap`, 20px against 18px, and two pixels is invisible as a measurement and obvious as a
misalignment. The two hover actions became one
always-visible `⋯` opening a **native QuickPick**, decided host-side off the polled model — a
popover anchored in a 280px view would be clipped by the view's own bounds, and a card that went
stale between the poll and the press must not offer Stop for a finished session. The disclosure
reads `1/6` rather than `1 of 6 agents`, the words having truncated the folder name away to say
what three characters say, with the sentence kept for the tooltip and the screen reader.
`dev/preview.html` + `pnpm dev:preview` renders the cards in a browser against canned data,
because every state worth checking is otherwise rare or expensive to produce on demand; its
fidelity risk is named in the file (it hand-supplies the `--vscode-*` variables, so a token it
forgets looks fine there and wrong in the editor), and `.vscodeignore` allows `dist/` only, so
none of it ships.
A session row **expands** to its sub-agents (`SessionInfo.subagents`) — `sessionSteps`,
`StepToggle` and `StepRow`, which live in **`packages/ui`** (`SessionSteps.tsx`) rather than in
this webview, that being exactly why the dashboard had none of them; a session's sub-agents are a
protocol fact and a disclosure over them is a list affordance, so neither is extension-specific.
The disclosure sits on the *second* line, since the first line's left edge belongs to the name you scan by, doubling as the
count (`2 of 3 agents`, because "how many are still going" is the live question); expansion is
row-local React state and unpersisted, and could not be a native twisty regardless, every view
here being a webview. Pressing a child selects the session and reveals that `Task`'s row
(`wd-select-session`'s `revealToolUse` → `wd-reveal-tool-use` → `SessionPanel.reveal`) **without
focusing the composer**: a sub-agent has no screen of its own, so opening one is a reading action
and the composer is at the other end of the panel.
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
cannot swap extension code in a live host).
## `apps/embedded`

**the reference embedding**, and the thing to read before designing another
one: a wiki SPA whose right-hand rail is a sandboxed agent, with the gateway inside the app's
own server. Everything non-`/v1` (the `/api` wiki, the MCP endpoint, the built SPA) is served
through the gateway's `fallback`, so it is **one port** — a tab cannot header a WS upgrade, so a
cookie is the only credential an attach can carry and a cookie is per-origin. `authenticate`
turns the app's cookie into `{ scope: { user } }` and that is the *entire* ownership model: the
SPA calls `listSessions()` with no filter, because a check the client performs is a check the
client can skip. The agent runs the provider engine under `sandboxedProviderProfile()` raised
exactly twice (`web_fetch`, the `wiki` MCP server) — no shell, no host FS, `eval_script` in an
in-process QuickJS guest with no network. The wiki's operations are **one silkweave action set**
(`src/wiki/actions.ts`) projected onto two transports: `@silkweave/mcp`'s mountable
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
and blank-checked in `run` (`text()` in `wiki/actions.ts`), as a second layer under the split. **UI state is the app's, not the bridge's**
(`src/app/state.ts`): "which doc am I looking at" and "open that one for me" travel as a
server-held per-*user* record the tab `PUT`s on change plus an SSE stream of intents back down
— `whoami` / `open_doc` are two more MCP tools over the same token. The tool bridge looks like
the natural home and is wrong twice: a bridged tool is by definition `sandboxed`, and the bridge
asks the *first attached client*, so two tabs means an arbitrary one answers. `open_doc` reports
`shown: false` when no tab was listening rather than claiming a navigation. Two gotchas it paid for in blood: the MCP
client opens the SSE stream with `GET` and the stateless transport must answer **405**, not
Express's default 404, or the whole connect fails; and a model told to omit an optional `id`
sends `""` or `" "`, so no tool may infer its operation from an absent field. The MCP connect is
`required: true` and the runner is built by `createProviderRunner` — this app is where both
seams came from, and it was the thing dropping `ctx.id`. **Sessions survive a restart** — the
fourth decision in `gateway.ts` worth reading: `parking: { store: createFileSessionStore(...),
persistLive: true }`, which is the provider engine's only restart mechanism, plus the half that
is easy to miss — the cookie secret is **persisted** (`auth/secret.ts`, `EMBEDDED_SECRET` else a
0600 file beside the database) rather than per-process, because a scoped session 404s for
anyone else, so signing everyone out on boot would preserve every conversation and make each one
unreachable. Storage is `node:sqlite`, one file,
zero deps. `EMBEDDED_MODEL` (default `gpt-5.6-luna`) is env, not a constant; there is **one**
provider and one key, deliberately — the openai-compatible branch was removed because every
branch in a reference app is a branch a reader must hold that teaches nothing about embedding.
The one thing still deferred upstream is an express-free
`mcpTransport` mount; express stays here purely as a mounting mechanism for `/mcp` and the
static SPA.
- **Every prefix the app server owns must be listed in `vite.config.ts`'s dev proxy, and a missing
  one does not fail loudly.** Vite answers the SPA's `index.html` with a **200**, so the caller gets
  HTML where it expected JSON and the feature quietly never loads. This happened for real when the
  wiki's data moved onto tRPC at `/trpc` while the proxy still listed only `/v1` and `/api`: the
  document rail read "No documents yet" while the agent was demonstrably writing documents, and
  `wiki__opendoc` opened nothing. `pnpm start` was unaffected (single origin), so the reference
  embedding was broken only in the mode anyone reading it would run.
## `apps/ios`

native iOS remote control (SwiftUI + XcodeGen; invisible to pnpm/turbo — no
package.json). `WorkerDeckKit/` is a hand-written Swift mirror of `packages/protocol` plus a
client and a port of the react transcript reducer — protocol or transcript changes must be
mirrored there (`WorkerProtocol.version` tracks `PROTOCOL_VERSION`); see `apps/ios/README.md`.
The three agent-view preferences are mirrored too (`AppSettings.swift`): variant and density as
environment values the rows read, and the font as one `fontDesign` on the session view — with
the composer's `UITextView` told separately, since UIKit sits outside SwiftUI's font
environment. `lines` is **gone**, replaced by a native Swift **terminal** renderer
(`App/Sources/Session/Terminal/` over `WorkerDeckKit/.../Terminal/`); a stored `lines`
preference migrates to it rather than falling back to cards, because someone who turned boxes
off should keep them off. Density and font stay Cards-only here as everywhere. The port carries
the rules across — the two folds, the row-covers-a-*membership* addressing, the cell/wrap model,
the strings that *are* the heights — and inverts one thing deliberately: **the planner wraps and
the renderer draws the lines it returned**, so a row's height is `lines.count × line` by
definition rather than a prediction that can be 99% right. Nothing is estimated, so a
`UICollectionView` with a custom layout takes every frame straight from the height book, and the
pixel offset of an unmounted row — what a scrubber needs — is simply available. Two divergences
from the web client are deliberate and tested as such: a **run of one draws the call**, not
`Ran 1 tool · 1 read` (the fold's justification is row-count compression, and at one call there
is none to be had while the name, input and result preview are all thrown away); and the
result-preview character budget is **derived from the column count**, since 400 characters is
"about four lines" at a hundred columns and thirteen lines at thirty. `TerminalAudit` is the
gate that keeps the exactness claim honest, reported on screen by the `terminal`/`terminalStress`
preview variants — a line wider than its planned column is clipped silently, which is worse than
a wrong height.
The **row itself** mirrors the dashboard's (`packages/ui`'s `SessionBrowser`) rather than
inventing a phone shape: two lines, not three — a state *glyph*, title, unread badge, age and
context ring on top; the engine's mark then one truncating run of model · project · gateway ·
profile · cost underneath, in that order. **State leads both lines**, in a 14pt cell the engine
mark lands in underneath — it used to trail, and a trailing glyph has no fixed x, so a list of
thirty gave the eye nothing to run down. The mark itself needed two new pieces the app had
neither of: `engineMark` ported into the kit (`EngineMark.swift`, tested at its edges, because a
row that drew OpenAI's mark beside a name the sidebar spells as Gemini's is worse than drawing no
mark), and **real vector assets**, since SwiftUI has no path-data parser — generated into the
catalog from the very table the web draws inline by `apps/ios/scripts/gen-engine-marks.mjs`, as
template images so `VendorPalette` (the `--vendor-*` hex pairs, ported the way `TerminalPalette`
ports `terminal.css`) tints them. An unrecognised engine draws **nothing at all** rather than the
web's placeholder dot: a dot earns its keep in a sidebar where two text columns share a gutter,
and is a smudge in front of a phone row. Sub-agents are a **count, not a disclosure**
(`2/3` while some run, a bare total once settled — the two spellings `StepToggle` picks between):
the whole row is one `NavigationLink`, so a second tap target inside it is a coin toss under a
thumb, and the session it opens is where the agents can actually be read. The old third line spent a third of every row on a labelled `Idle`
badge, which is the state you scan *past*; and the model was printed raw (`claude-opus-5`) where
the other clients say `Opus 5`, so `friendlyModel` was ported into the kit
(`ModelName.swift`, tested against the same examples the TS doc comment states) — the same
person reads all three clients, and a model spelled two ways is the drift the shared view model
exists to prevent. `ContextRing`/`RadialGauge`/`usageTint` moved out of the session screen into
`App/Sources/Support/UsageGauges.swift` when the list started drawing them, and the ring takes a
bare percentage rather than a usage record: the session screen holds a whole `ContextUsage` and a
row holds the compact `ContextReading`, and the percentage is the one number both agree on. On a
row it draws **without its inner label** — two digits inside a 14pt ring are unreadable at arm's
length, and across twenty rows the fill *is* the reading.
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
The **prompts** (permission and `AskUserQuestion`) live in the footer, which is a
`safeAreaInset` — sized to its content, with no scrolling of its own — so a prompt taller than
the screen pushed its own action row past the bottom edge and could not be answered at all. The
`lineLimit`s that used to sit on descriptions and previews were an attempt at the same problem
and made it worse in the way that matters: they hid the text you needed *in order to choose*
while still not bounding the height. So the shape is a capped, scrolling body with the actions
pinned under it (`PromptBodyScroll`), the cap being half the *measured* container rather than a
constant — one that fits an SE wastes half a Pro Max and one tuned for a Pro Max is the original
bug on an SE. Nothing is truncated any more, which is why `toolInputSubject` joins
`toolInputSummary`: the summary's 140-character cap is right for a collapsed transcript row and
wrong for an approval, where the string it clips is the command about to run. Under the terminal
theme they are **their own views** rather than the Cards views restyled — one question at a time
behind a chip strip, ending in a review step, which is bounded by construction where a stacked
form is not; the numbering survives as *structure*, the web's `↑/↓ · 1–3 to choose` hint does
not, there being no keyboard here. `UIPREVIEW=prompts` is the gate, and the claim it tests is
not "does this look right" but **"can it be answered"** — which is what caught the clipped
command. `TerminalTypography.session` is the cell all three terminal surfaces measure against,
the web's `terminalMetrics` lesson stated once here.
Two more mirrors landed with the `sessionState` fix: `SubagentInfo`/`SessionInfo.subagents` had
**never been mirrored at all**, so the phone was not computing the bucket wrongly — it had no
field to compute it from, which is the more interesting half of why that bug survived the rule
being written down. Nothing *renders* sub-agents here yet: the correct bucket, not the
extension's expandable rows.
A **`Menu` in a toolbar closes when its item is re-identified**, and the sessions list's filter
dropdown shut itself on every poll because of it — the menu read `model.adapters`, a property
computed from the session rows, so `@Observable` invalidated it whenever a snapshot was
replaced, and a `ToolbarItem` with no `id` is re-identified when the builder re-runs. Stable
ids, plus a `FilterMenu` that is `Equatable` over plain values and never the model. Worth
remembering as a shape, not an incident: any toolbar control whose body touches polled state
wants both halves.
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

