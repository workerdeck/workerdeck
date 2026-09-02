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
registered gateway.

**`@types/vscode` is pinned with a tilde to the `engines.vscode` floor (`~1.106.0`), and a
dependency sweep must not carrot it up.** The types version *is* the API surface you compile
against, so types newer than the declared floor let a call to an API that does not exist in the
oldest VS Code we claim to support typecheck cleanly and then throw at runtime, on exactly the
users who cannot see the failure in review. `^` is wrong here for a subtle reason: `@types/vscode`
spells the VS Code version in its *minor*, so `^1.106.0` happily resolves to 1.134 and silently
buys the whole newer surface. Raise the two together or not at all.

### The panel: terminal variant at the editor's cell

It runs the panel with `transcriptVariant: 'terminal'`, `focusComposerOnClick` (dead-space
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
webview baseline `styles.css` sets.

### The status bar

The window status bar is the panel's bar, and each of its badges is its own boolean
setting (`workerdeck.statusBar.*`), read per render so a change is just a re-render — usage is
three of them now (`sessionUsage`/`weeklyUsage` on, `modelUsage` off, over protocol's lanes),
and a lane with no window hides rather than showing a dash. A running session colours its
status badge via the **foreground** (`charts.blue`), not a background: VS Code accepts only
`statusBarItem.errorBackground`/`warningBackground` and silently ignores anything else, and
both are alarm colours for a session that is merely working. Model
and mode are bar items too, opening **QuickPicks** — a `StatusBarItem` has one command and
no dropdown, so command → QuickPick is the only shape VS Code offers (and the one its own
language-mode item uses); the panel's `onControls` setters are what they drive.

The panel's `onOpenPanel` requests all land somewhere native — none are dropped. The four
section kinds focus their views; **`skills`** opens a QuickPick (also
`workerdeck.useSkill`) fed from `vitals.skills`, and picking one posts `wd-use-skill` so the
webview inserts the same `skillPrompt(...)` text web's SkillsDialog would, through the
controls' `insertComposerText` — a disabled skill stays visible and unpickable, like an
ungrantable permission mode; **`files`** runs `workerdeck.openProjectFolder`, the existing
`workerdeck://` mount of the active session's cwd, rather than growing a webview file
browser.

### Attach ownership, paths & the remote filesystem

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
Remote SSH story.

### The navigation rule

**No webview in this extension draws its own header, and no view has
screens.** That is the navigation rule, and it is what the sidebar was rebuilt around: a
pushed screen left the native title still reading SESSIONS over a form, its `+` still
navigating sideways with no history, and a back chevron the extension had drawn itself.
So chrome is VS Code's — `view.title` plus title actions gated on a `setContext` key (a
stateful title button doesn't exist, so an open/closed toggle is *two* commands with
opposite `when` clauses) — and everything that used to be a screen is either its own view
or a native QuickPick.

### The Sessions and Gateways views

The Sessions view lists every gateway's sessions at once — gateway
is a facet (filter/group/sort) beside adapter and state, not the frame — with search and
the facet dropdowns behind the title bar's **filter toggle** (`$(filter)`/`$(filter-filled)`;
the *host* owns that boolean, since the key lives where commands do, and closing the bar
never clears the filters). **Gateways are their own collapsible view**, not a screen: a
gateway is a mode every session belongs to, so managing them sits beside the list
permanently, with the connected count in the view header's description. There is **no
implicit localhost gateway**.

Adding and editing one is a **native multi-step input** (`src/new-gateway.ts`: URL → name →
auth key, prefilled and backed out of with `QuickInputButtons.Back`), not a form the view
draws over its own list. That is the navigation rule applied to the last place that broke it:
the form was a screen, so the view needed a `+`/back pair of commands gated on a
`gatewayFormOpen` context key, a retained webview so typing survived being hidden, and a
round trip per keystroke's worth of state across the bridge — and the auth key had to be
*sent to the webview* to prefill an edit, because `SecretStorage` is host-side only. The
native flow deletes all four: the key never leaves the host, the bridge carries a list and
two verbs (`wd-edit-gateway`, `wd-remove-gateway`), and the URL is validated by `apiUrl` at
the step that asks for it. The first gateway's URL arrives prefilled with
`http://127.0.0.1:8787` and the name is derived from the URL's hostname, so adding this
machine's gateway is three `enter`s — the same promise session creation makes.

### Creating a session, the poll & the `+` rule

Creating a session is a native multi-step QuickPick
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

### View layout: the two sidebars

**There is no activity-bar container.** The views are split across the two sidebars by
default: **Sessions** into **Explorer**, beside the file tree (it is a workspace-level list,
and it is where the `+` lives), and the other five into a **`secondarySidebar` container
titled "WorkerDeck"** — one tab, stacked vertically, Usage → Context → MCP Servers →
Session Info → Gateways. The four detail views are `when`-gated on `workerdeck.hasSession`:
they are *about the thing you have open*, which is Outline and Timeline's shape. That gating
reverses the earlier "views must not appear and disappear under the pointer" rule on
purpose; Sessions and Gateways stay ungated, which is what keeps both containers' shape
stable. A view that *is* contributed cannot be disabled or collapsed through the API, so a
section with nothing to say says it the only two ways that exist — the header's
`description` (`no session`, `not reported`, `not supported`) and an empty state in the body.
`viewsContainers.secondarySidebar` is what sets `engines.vscode` to **`^1.106.0`**:
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

### The unread and subagent status items

Unread therefore had to leave the container: a `view.badge` aggregates onto its
**container's** icon, which is now Explorer's, next to a user's files. It is a **window
status-bar item** (`UnreadStatusItem`, `workerdeck.statusBar.unread`), the same count summed
over the sessions the **filter is
showing** — the webview mirrors its view config to the host (`wd-view-config`, one-way;
the shared rules moved to `src/view-config.ts` so both sides filter identically), because a
badge counting rows in hidden sessions sends you looking for something that isn't there.
What it counts is **prose** — `SessionInfo.proseCount`, protocol's narrower door — so a
session grinding through forty tool calls shows nothing at all until it says something; the
host reads it through protocol's `unseenCount` rather than the copy of that arithmetic it used
to keep, which is how this badge and the dashboard's came to disagree in the first place.
Two things the move bought: the count no longer needs the Sessions webview to have been
resolved (`refreshUnread` is gated on **neither `#ready` nor `#view`** — gating on `#ready` is
how the count came to sit stale until the sidebar was next opened, reading a session in the
panel moving its watermark with no model change announcing it, and gating on `#view` is what
the old `view.badge` required; `#viewConfig` is restored from globalState for exactly that
case), and sessions awaiting a human can *colour* it amber
rather than only leading its tooltip. `SubagentStatusItem`
(`workerdeck.statusBar.subagents`) sits beside it on the same argument — it is about *every*
session and is most worth showing when nothing is open, since a window with no panel up can be
spending real money on six parallel agents — counted in the same pass over the same filtered
rows, hidden entirely at zero, and coloured on the **foreground** (`charts.blue`) because VS Code
ignores every background but the two alarm ones. Either badge keeps the poll watcher alive:
gating it on `unread` alone left someone who turned unread off watching a frozen count.

### The session card (`SessionItem`)

The list is drawn as **inset rounded cards** (the Figma sidebar design) — and the card itself is
now `packages/ui`'s **`SessionItem`**, which is why `SessionCard.tsx` is ~95 lines of props where
it used to be ~380 of hand-kept markup. The card was born here (the dashboard had no sub-agent
rows, no context ring and no vendor colour until they were lifted out of this webview) and for a
while the two lists were two copies of one design, agreeing on the model and disagreeing on every
measurement. Its prop is the whole **`row: SessionRow`** now, not `info` + `unseen` + `hostName` —
the view model the shared card reads — plus `showProject`/`showGateway`; `SidebarApp` passes the
row it already had, and `dev-preview` builds one.
The card keeps the two rules this design reversed, deliberately. The **state glyph leads the
title**: the earlier rule optimised for reading one row, this one for scanning twenty, and the
glyph is what tells you which row to read. And **selection is the card's own fill** rather than a
gutter bar, the card being an inset shape with air around it, which leaves the left edge to the
glyph. Line two is the engine's mark and model in the **vendor's own colour**, then the **project**
and gateway muted — the project having replaced the cwd basename in that slot, because the folder
was only ever a proxy for the question the project name answers (`projectLabel` falls back to
exactly that basename, so an undeclared project is byte-identical to what shipped) — and it closes
with the **age**, the one part of that identity run that keeps changing while you read it. Line
one's own tail is the pair that changes while you *look*: the unread badge and the context ring.
Grouping by project **suppresses it on the row** and
hands the slot back to the basename — `ui`, `server`, `web` under one WorkerDeck heading, which
is the one thing the header cannot say — exactly the rule `hostName` already followed one facet
over, and the answer to "what about the subdirectory". Icon bytes come from the host as a
consequence rather than a preference: the webview CSP has no external `connect-src`, so an
`<img src>` pointed at a gateway cannot load with or without a credential, and the host is
where the gateway key lives anyway (`src/project-icons.ts`, keyed by the wire's
`ProjectIcon.image.hash`, cached forever because a hash names its bytes — editing an icon
arrives as a new key — and failures cached too, the route's 404 being the uniform "no icon"
and a retry one request per session per poll for a picture that is never coming), pushed as
their own `wd-project-icons` message rather than on
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
of "don't add any colors". Both lines also share **one 16px icon gutter** (`SessionItem`'s
`Gutter`), because the two glyphs are different sizes: as plain flex children each line's text
started at `icon + gap` and two pixels is invisible as a measurement and obvious as a
misalignment.

### Overflow menu, rename & theme colours

What is left extension-shaped after the card moved out is exactly **two** things, and they are the
two `SessionItem` takes as props. First, **the overflow is a native menu**: the two hover actions
became one always-visible `⋯` in the card's `actions` slot (`CardMenu`, which posts
`wd-session-menu`) opening a **QuickPick**, decided host-side off the polled model — a
popover anchored in a 280px view would be clipped by the view's own bounds, and a card that went
stale between the poll and the press must not offer Stop for a finished session. That QuickPick
is also where **Clear context** lives — the first Clear control on any client — gated on
`SessionInfo.capabilities.clearContext` (absent = false, so an older gateway simply does not offer
it), sent as a session command over a transient attach exactly like Stop, and confirmed with copy
that never says "deleted": the session keeps running, the conversation starts fresh, and the old
one stays resumable from the resume picker. Second, **rename is a double-click on the title** —
`SessionItem`'s default `renameOn`, and the editor's own feel — where the dashboard, spending its
row hover on three actions instead, drives the same editor from a pencil (`renameOn='external'`).
The colours are not this file's business either: `styles.css` repoints `--row-hover` and
`--row-selected` at `list.hoverBackground` / `list.activeSelectionBackground` and
`--badge`/`--badge-fg` at VS Code's own badge pair, so the shared card wears the user's theme
without a `--vscode-*` variable being named in the component. The disclosure
reads `1/6` rather than `1 of 6 agents`, the words having truncated the folder name away to say
what three characters say, with the sentence kept for the tooltip and the screen reader.

### Dev harness & CSP

The webview build has **no dev server**: `localResourceRoots` means every asset must be a real
file on disk, so the dev loop is `vite build --watch` plus `src/dev-reload.ts` re-rendering the
views in place. Vite's dep optimizer therefore never runs here, and none of its traps are
inherited. The CSP has no external `connect-src`, but `img-src` does allow `http:`/`https:`, and
that is the one hole: an inline transcript image loads directly only from a **keyless** gateway,
header auth being unable to ride an `<img>` — the same trade the iOS client makes. Project icons
are exempt because the host fetches their bytes and hands them over as data URLs. And
`transcriptVariant` resolves **anything that is not `cards`** to `terminal` rather than matching
`'terminal'` exactly, which is deliberate compatibility: a settings file still holding the retired
`lines` value must land on the terminal theme rather than on an unhandled variant.
`dev/preview.html` + `pnpm dev:preview` renders the cards in a browser against canned data,
because every state worth checking is otherwise rare or expensive to produce on demand; its
fidelity risk is that it hand-supplies the `--vscode-*` variables, so a token it
forgets looks fine there and wrong in the editor; and `.vscodeignore` allows `dist/` only, so
none of it ships.

### Sub-agents: expansion and the panel frame

A session row **expands** to its sub-agents (`SessionInfo.subagents`) — `sessionSteps`,
`StepToggle` and `StepRow`, which live in **`packages/ui`** (`SessionSteps.tsx`) rather than in
this webview, that being exactly why the dashboard had none of them; a session's sub-agents are a
protocol fact and a disclosure over them is a list affordance, so neither is extension-specific.
The disclosure sits on the *second* line, since the first line's left edge belongs to the name you scan by, doubling as the
count (`2 of 3 agents`, because "how many are still going" is the live question); expansion is
row-local React state and unpersisted, and could not be a native twisty regardless, every view
here being a webview. Pressing a child selects the session and **hands the panel over to that agent's own work**
(`wd-select-session`'s `subagentToolUseId` → `wd-open-subagent` → `SessionPanel.openSubagent`),
still **without focusing the composer** — and now for a stronger reason than before: while a
sub-agent is framed there *is* no composer. That chain was `revealToolUse` → `wd-reveal-tool-use`
→ `SessionPanel.reveal` and was repurposed wholesale rather than joined by a second one; revealing
the row remains the honest fallback meaning for a surface that cannot frame, and `reveal` itself
survives untouched for other callers. A **task** takes the other road: `wd-select-session`'s `revealToolUseId` → `panel.reveal` →
**`wd-reveal-tool-use`** → `SessionPanel.reveal`, which stays on the conversation and travels to the
row where that work was started and finished. A sibling field and a separate arm, not a flag,
because the two go to different panel APIs — and conflating them is exactly how a task came to be
framed as an agent, selecting no items and drawing an **empty agent view**. `panel.ts` holds them
in a single `#pending` slot — one kind at a time, so asking for either withdraws the other and the
mutual exclusion is structural rather than two queues clearing each other — flushed from
`#pushActive` with one strictly-increasing nonce (per-kind values never repeat, which is what keeps
"asking twice means twice" true webview-side). Neither focuses the composer: both are requests to
*read*.
The panel reports back what it actually has framed — `SessionPanel`'s `onSubagentChange` →
**`wd-subagent-open`** → `SessionsModel.setSelectedSubagent` → `SidebarState.selected
.subagentToolUseId` → the card's `activeStepKey`, which draws the **secondary selection**: the
framed agent's row goes blue and its session's card drops to grey. A *statement*, not the echo of
`wd-open-subagent`, and the two are deliberately separate arms: the panel enters frames the host
never asked for (a `Task` row pressed inside the transcript) and leaves them three ways, so a value
inferred from our own requests would be wrong within one click. `setSelectedSubagent` is a setter of
its own rather than another `setSelected`, because the two facts have different owners and
lifetimes — the selected session is this window's and survives a reload via `ACTIVE_SESSION_KEY`,
the frame belongs to the panel and dies with it, which is also why the restore path deliberately
seeds no `subagentToolUseId`. `wd-ready` clears it: a fresh webview has no frame by construction,
and since the panel reports *changes* and is silent on mount, a panel disposed while framed and
reloaded would otherwise never contradict the value the host still held. The sidebar matches
`selected` on **host and session**, not on session alone — ids come from the engines, so two
gateways can issue the same one, and an id-only test lit the wrong card in exactly the
multi-gateway case this window exists to make legible. The webview clears its request in the
`wd-show-session` handler, because a request left standing across a session switch would frame one
session's `Task`
id against another's items.

### The ruling the navigation rule needed

**This is the one place the no-header/no-screens rule needed a ruling rather than an application.**
That rule was written about the sidebar and section views, where pushed screens broke VS Code's
native titles, `+` placement and back affordances, and the cure was to hand chrome back to the
editor. The agent panel is a different view and still draws no header: the takeover changes no
title, builds no navigation stack, and its strip is a line on the transcript's own grid — the same
category as an expanded `Task` row, taken to the whole scroller, with one boolean way back. The
strict reading ("never swap what a webview shows") has no implementable alternative here, there
being no native transcript for the editor to own, so it cannot be what the rule means.

### Unread watermarks & the workspace-scope facet

The cards carry it per session — an **unread badge** of messages since that session was last on
screen (`src/watermarks.ts`, globalState, written **only while the panel is visible and
showing it**, and monotonic so a compaction can't resurrect read rows). Messages, from
`SessionInfo.proseCount`: the badge answers *is there something to read*, so a
session grinding through forty tool calls badges nothing until it speaks. `unseenCount` walks
prose → rows → turns, the two lower rungs being what a gateway without the field can still
say —
rows (`activityCount`) because turns undercount badly (five tool calls in one turn is one turn)
and `lastSeq` overcounts absurdly (every stream delta). The panel turns the same mark into catch-up. The window's open
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

### Resume & dev reload

**Resume** is the same QuickPick rails as create (`workerdeck.resumeSession`), diverging only
at the last step: `listSdkSessions` for the chosen directory *and profile* — the engine store
is per-engine, so another profile's ids mean nothing here — gated on the capability record's
`listSessions`, and a pick is the same create call with `resume` set and no first prompt (the
engine replays the thread; a prompt on top would be an unasked-for turn). A session rename is a gateway edit
(`PATCH /sessions/:id` → `meta.title`), never a local override, so every client sees the
same name; it is reached by double-clicking the title, everything else the card can do being
in the `⋯` QuickPick. `src/dev-reload.ts` is development-mode only: a webview rebuild
re-renders the webviews in place, an extension-host rebuild reloads the window (VS Code
cannot swap extension code in a live host).

**A webview reload replaces the document but not the `WebviewView`**, so neither
`resolveWebviewView` nor `onDidDispose` runs — anything keyed to the *document* has to be torn
down in `WebviewHost.resetForReload()`, which the reloader calls before swapping the HTML.
Transports are the case that bites, and it is worth understanding once: `webview/bridge.ts`
allocates socket ids from a module-scope counter starting at 1, and the host routes purely on
that id. Sockets that outlived a reload therefore answered to ids the fresh document had since
handed to *other* sessions, and one session's transcript rows were delivered into another's —
nothing on the wire carries a session id, so no layer downstream could catch it. Note the
teardown must also *latch* silence (`WebviewTransportHost` drops posts once disposed): a socket
close is asynchronous, so its `close` event lands after `dispose()` returns and would otherwise
be posted into the new document. Per-view listeners still belong in `wire`, which must not be
re-run on reload or they double-register.
## `apps/embedded`

**the reference embedding**, and the thing to read before designing another
one: a wiki SPA whose right-hand rail is a sandboxed agent, with the gateway inside the app's
own server. Everything non-`/v1` (the `/api` wiki, the MCP endpoint, the built SPA) is served
through the gateway's `fallback`, so it is **one port** — a tab cannot header a WS upgrade, so a
cookie is the only credential an attach can carry and a cookie is per-origin. An express app is
a `(req, res)` handler, so the `fallback` can simply *be* one: no proxy hop, no second port, no
WS upgrade to forward. It checks `/trpc` **before** handing off to express, because silkweave's
`trpcNode` handler slices its own endpoint prefix off unconditionally and must only ever see
URLs that belong to it. `authenticate`
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
could choose. Below that, **every `WikiDb` query takes a `userId` and every WHERE clause carries
it** — deliberate duplication of the gateway's session scoping rather than a substitute for it:
the gateway decides who may *drive a session*, the db decides whose *documents* a call can
reach, and an agent that talked its way into the wrong tool arguments must still come up empty.
Two independent checks on two different questions is the whole reason both exist. It is also
where the 404-not-403 rule lives — another user's document is a plain not-found, matching the
gateway's uniform disclosure for an out-of-scope session.
`whoami`/`open_doc` are MCP-only: a shared action set is not an identical one, and the SPA
knows what it is showing. The cookie makes `/trpc` CSRF-able, so `sameOrigin()` checks
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
zero deps. **`.embedded/` is data, not build output, and nothing automated may delete it**:
`pnpm clean` removes `dist` only, and wiping the wiki is the separate, explicit `pnpm reset`.
That is not a tidiness rule — the two were once the same script, and it cost someone their
documents. Under `parking.persistLive` the parked records in `.embedded/sessions` hold each
session's whole transcript in plaintext, so they want the same protection as the database
beside them. `EMBEDDED_MODEL` (default `gpt-5.6-luna`) is env, not a constant; there is **one**
provider and one key, deliberately — the openai-compatible branch was removed because every
branch in a reference app is a branch a reader must hold that teaches nothing about embedding.
The one thing still deferred upstream is an express-free
`mcpTransport` mount; express stays here purely as a mounting mechanism for `/mcp` and the
static SPA.
- **`zod` stays on 3.x here while the rest of the monorepo is on 4.x — that is a pin, not a
  straggler.** `@silkweave/core` peer-requires `zod ^3.25.0`, and this is the only package that
  depends on silkweave. Nothing in `apps/embedded` imports `zod` directly, so the version reads
  like dead weight a dependency sweep should bump; bumping it breaks the peer instead. Revisit
  only when silkweave itself moves to zod 4.
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
`context_compacted` draws as an ordinary transcript item, not as a synthetic seam like the recap
row: it has a uuid, so it is addressable and bookmarkable, and it nests inside a sub-agent's
frame on `parentToolUseId`. It appends where `conversation_reset` empties, and leaves
`contextUsage` alone — the engine reports post-compaction occupancy itself. `TermFmt.compaction`
is Swift's own copy of `COMPACTION_TEXT`, pinned by `TerminalTextTests` because there is no
module the two sides can share.
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
**A phone has no hover, so a wash *is* the affordance**: `TerminalPalette.uiPressable`, drawn by
`BackdropView` behind any line that carries a press **and wears nothing else** — no band, not
`inOpen`. That carve-out is the design, not an optimisation: a tool call's preview rows are
pressable too, but they already sit in the output band, and a second wash on top would read as
"two targets" when the block is one. So what gets marked is the summary line — the folded run, the
task, the tool header. Strength is **0.028/0.024, deliberately below** the open wash (0.05/0.04)
and the bands (0.04/0.05), because a transcript is mostly pressable and at band strength every
second row would be washed and the rows carrying real meaning would stop standing out. If it ever
reads as noise the next move is to mark **fewer rows, not to lighten it further** — the honest
alternative is marking only blocks that fold something and leaving a plain tool call bare.
The same absent hover is why a **long-press opens a context menu** on a row (the collection view's
own `contextMenuConfigurationForItemsAt`, not a per-cell interaction, so UIKit installs one
recognizer per surface and coordinates it with the scroll instead of leaving a hand-added one to
win that fight alone). It carries what the web puts in its hover overlay: the bookmark toggle and
**Copy**, which had no home here at all. Two rules keep it honest. It addresses **the row's own
head item**, never the touched line — `TermLine` deliberately erases where a line came from, and
its `press` is a verb rather than an address (nil on exactly the prose rows most worth marking),
so per-line attribution would be a second answer to "what did this row draw", which is the drift
this renderer exists to refuse; a folded run therefore bookmarks the call its row is named for.
And Copy takes the row's **source** — an answer's raw markdown, a call's command — never its drawn
lines, since the body is already one selectable run and copying what is *visible* needs no menu.
A standing text selection refuses the menu, the same deference `handleTap` pays it. The
selection-long-press against the menu-long-press is the one interplay that still wants a device
check: idb's synthetic input drives neither recognizer — under it the ordinary tap does not
register either — but **XCUITest's input does reach this app** (`WorkerDeckAppUITests`, driven
through testmanagerd, is what proves the session row's tap contract), so that is the tool for the
next such check before a phone.
Hit targets are the standing tension: a one-line block is `metrics.line` tall, ~19pt at the
phone's 12pt cell against Apple's 44pt, and the grid forbids the obvious fix (a row is a whole
number of lines, and a taller row is a different transcript). What is there is free — `handleTap`
**clamps** the line index instead of bounds-checking it, so the blank line `gapAbove` puts above a
block, dead space belonging to nobody, becomes part of the row it separates and roughly doubles
the target for exactly the rows hardest to hit. It is a partial answer by construction: two
adjacent blocks with no gap between them get nothing. None of this is portable to `packages/ui`
and should not be — a pointer is exact and a thumb is not, and `press.tsx`'s rules (refuse a press
that travelled, refuse one with a selection standing) are the pointer's version of the same care.
A **deep link lands on the row that triggered it** rather than at the tail: `TranscriptSeqIndex`
(see `docs/GOTCHAS.md`) maps the push payload's `seq` to the first item appended at or after it,
and `resolveFocus()` is asked **once**, when the attach's stated seq is reached. Two limits are
permanent rather than debt. The **cards renderer ignores `seq`** — `TranscriptListView` has no row
model to land on, so a deep link there opens at the tail as it always has; deliberate, the
terminal theme being the default. And a **`seq` older than retention** lands on the top of what
remains, which is the closest the transcript can get, untested against a real retention cut.
The **row itself** mirrors the dashboard's (`packages/ui`'s `SessionBrowser`) rather than
inventing a phone shape: two lines, not three — a state *glyph*, title, unread badge and the
context ring on top; the engine's mark, one truncating run of model · project · gateway ·
profile · cost, then the age and the step disclosure underneath, in that order. **State leads both
lines**, in a 14pt cell the engine
mark lands in underneath — it used to trail, and a trailing glyph has no fixed x, so a list of
thirty gave the eye nothing to run down. The mark itself needed two new pieces the app had
neither of: `engineMark` ported into the kit (`EngineMark.swift`, tested at its edges, because a
row that drew OpenAI's mark beside a name the sidebar spells as Gemini's is worse than drawing no
mark), and **real vector assets**, since SwiftUI has no path-data parser — generated into the
catalog from the very table the web draws inline by `apps/ios/scripts/gen-engine-marks.mjs`, as
template images so `VendorPalette` (the `--vendor-*` hex pairs, ported the way `TerminalPalette`
ports `terminal.css`) tints them. An unrecognised engine draws **nothing at all** rather than the
web's placeholder dot: a dot earns its keep in a sidebar where two text columns share a gutter,
and is a smudge in front of a phone row.
`SessionItem.tsx` is the reference and this row owes it parity — it is a hand-mirror of the one
drawing the product otherwise has (see `docs/PACKAGES.md` §`packages/ui`), so every rule it does
not carry is drift. `UIPREVIEW=sessions` (`SessionsPreview`) is the phone's copy of the
`Sessions/SessionItem` `TheList` story, same sessions in the same order, so the two can be put
side by side; `SessionCardView` exists so that preview can draw the composition the list ships
rather than the row alone — and its `onOpen` is **required** for that reason. The first version of
this row shipped a collision the preview could not show: `route` was optional, the preview passed
none, so the card drew bare while the app wrapped it in a `NavigationLink` whose platform chevron
landed under the badge and ring. A preview that omits what the list passes is a preview of a
different composition; the card now has no optional that lets that happen twice.
Four rules were off and are now ported. The **step disclosure sits on line two**, where the
dashboard puts it, not centred on the row's trailing edge as a third column. The Figma frame
(`SessionLists`, node `17-1156`) settles the trailing edge outright: **no per-row chevron** —
line one ends with the ring, line two with the `ListDropdown`, and only the sub-items carry an
arrow. So the row is a `Button` that appends its route to the stack's path (the push notification
and create paths already navigate that way), not a `NavigationLink`: a link draws the chevron the
design has no room for, and `navigationLinkIndicatorVisibility(.hidden)` — annotated iOS 17 via
`@_alwaysEmitIntoClient` — is a **no-op on the iOS 18 runtime** (measured on the 18.5 simulator;
only 26 honours it), so the modifier could not carry a 17.0 deployment target. A list-row button
paints its label in the accent, which the card overrides to `.primary`; every other colour on the
row is explicit already. The disclosure stays **outside** the row's button — a hand-rolled button
inside the row's tap target is a coin toss under a thumb — as an `.overlay(alignment:
.bottomTrailing)` sibling in z-order, full row height for the thumb and bottom-aligned for the
eye. It is laid out by **the same view drawn twice**: `StepDisclosure` sits `.hidden()` at the end
of line two, reserving exactly its own width in the line's flow, and the overlaid button draws the
visible copy on top of it. Nothing is measured, so nothing can drift; the earlier
`DisclosureWidthKey` overhang measured the sibling and reached line one over a chevron it never
knew about. The two targets are **pressed, not asserted**: `WorkerDeckAppUITests` runs the
`UIPREVIEW=sessions` fixture and checks that the disclosure toggles without pushing and the row
pushes (`xcodebuild test … -only-testing:WorkerDeckAppUITests`, in `apps/ios/README.md`).
The **context ring reads off the ring ramp**, not the bar ramp: the web draws two off one
percentage and they turn in different places, so `meterSeverity` (80/95, neutral below) is now in
the kit and tested there, `ringTint` maps it, and `usageTint` (70/90, accent below) stays what a
*bar* fills with. A ring that was accent-blue from 1% to 79% had spent the accent saying nothing.
The **working spinner is tinted** (`text-info`) rather than left at the system's grey, and
**parked is neutral** rather than purple — the dashboard spends no hue on a state that wants
nothing. And a **running step draws a spinner**, the marker its own card already uses for the same
fact, where it drew a static `circle.dotted`.
Three divergences are deliberate. The web's `···` row actions are **hover-revealed**, and a phone
has no hover: rename/close stay on the swipe actions and the context menu rather than becoming a
third visible affordance. The age stays `4m` against the web's `4m ago` (`Fmt.ago` is the app's
one elapsed spelling). And there is **no selected-card fill** — the phone pushes where the sidebar
selects, so there is no standing selection to draw and no `activeStepKey` to weaken it to grey.
**The sub-agent takeover** is a real navigation push (`navigationDestination(item:)`), and the
one thing that shaped it is a SwiftUI fact worth stating on its own: **a push cancels the covered
view's `.task`**. Measured with a probe app on the simulator (iOS 26.5) — `onDisappear` fires at
the start of the push and the covered `.task` is cancelled ~0.5 s later, at the *end* of the
animation. macOS does not do this, which is probably where the opposite assumption came from. The
obvious shape — "push a destination that reads the already-attached state, the socket lives in
`SessionView`'s `.task`" — would therefore have **detached the socket underneath the takeover**,
freezing the one surface built for watching an agent work, and replayed with a spinner on the way
back. So the attach's lifetime moved into the view model as a **claim count**
(`TranscriptViewModel.holdOpen()`): both views await it, the socket lives while any claim stands,
and because the two appearances overlap in both directions the count never reaches zero across a
push or a pop. Two things that used to hang off `onDisappear` ride the claim transitions instead
— notification suppression and the unread truing-up — since under a push `onDisappear` now fires
*mid-session*, and the approval shown inside the takeover would otherwise ring the phone about
itself. There is never a second attach and never a second reducer.
The frame itself is the web's rule, ported: membership is the kit's `subagentItems`, and the
component owns the same three gates the web transcript (`Transcript.tsx`/`TranscriptRows.tsx`) owns — recap, sticky prompt, and deep-link
focus — because every one of them is keyed to a *full-transcript* index. **The scrubber stays**,
riding the frame's own items and fold with the kit's `ScrubberInput.frameParentId` deciding what
"top level" means (web `scrubber.tsx`, same rule: without it a frame's rail mounted, banded, and
marked nothing), and inside a frame every narration step marks on its own where the conversation
gets one mark per segment. Host **bookmarks** ride in unchanged, and can only because they are
addressed by **item id**: the seam was indices when this paragraph first said they would have to
stay out, and an index means nothing at a level it was not taken at. An id is level-independent,
so both screens pass the *same* set and inside a frame each id resolves against the frame's own
items or draws nothing — the web `TranscriptRows.tsx` rule exactly. A bookmark set on a frame's
child therefore shows at the frame's own offsets there, and on the `Task` row that absorbed it at
top level. The
composer goes and **the approvals stay** (`ApprovalPromptHost`, shared with the session screen), for
the reason `docs/PACKAGES.md` records: a sub-agent's tool calls raise session-level permission
requests, so hiding them deadlocks the agent you are watching. Entry from the transcript is
`TermPress.openSubagent`, attached to the Task header — **a deliberate divergence**: the web keeps
the toggle on the press and puts the takeover in a hover action, and a thumb has no hover, so the
one target goes to the deliberate move and inline task expansion gives way. `frameParentId` threads
planner → height book → plan cache → audit rather than staying cosmetic, because suppressing the
nested step inside a frame changes the wrap and therefore the height, and the book and the drawn
plan must read the same value. A takeover asked for *before its Task exists* (the list knows the
`toolUseId` from the rollup while the transcript is still replaying) is **held until the replay
hold lifts** and only then resolved — so the phone never frames a mid-replay transcript, which is
the risk `_docs/VERIFICATION-DEBT.md` records as unpaid on the web.
**A sub-agent's brief leads its frame** — what the agent was asked, then what it did. The
instruction is never in the stream (the engine puts it in the spawning call's `prompt`), so both
renderers splice it in as a synthetic first row, and it leads the inline task expansion as well as
the takeover. **The clip is a shared rule and one constant per client with the same value**: four
*wrapped* lines, since the web's `line-clamp` already cuts on wrapped lines and so the
char-vs-column divergence `ResultPreview` needed does not arise here. Two divergences that do, both
forced by the model this renderer runs on: the affordance is **explicit** (`… +N lines` under the
four, where the web fades the fourth) because a thumb needs a target that says what it does, and an
*unclipped* brief carries no press at all; and the open state is `ExpansionKey.brief(taskId)` rather
than component-local, because the height book must know every height — the frame row and the inline
twin therefore share one state. Codex draws no brief row at all, enforced where the row is built
rather than where it is drawn: its spawn message is encrypted on the wire, and there is nothing to
show.
Sub-agents are a count **and** a disclosure, and they are the **same target**: the count on the
row's trailing edge *is* the control, with a chevron beside it saying which way it will go —
the frame's `ListDropdown`, drawn where the frame draws it. It reads `2/3` while some are still
running and a bare total once they have settled (the two spellings `StepToggle` picks between),
and it wears the accent while anything is live.

It is a **sibling of the row's button, never a child**, and that part is not negotiable: a
hand-rolled button inside the row's tap target is a coin toss under a thumb, because the row takes
the tap. The row used to draw the count alone for exactly that reason — right about *nesting*, and
answered by not nesting rather than by refusing the disclosure, because "which agent" is a
question the list can answer and the alternative is opening the session to find out.

An earlier pass put the disclosure in a **reserved left gutter** instead, 26pt on every row so
the titles would line up. That is gone: it spent a column in front of the entire list to hold a
control most rows never showed, and it asked the reader to find the disclosure somewhere other
than on the thing being disclosed. A trailing control has nothing to line up with, so a session
with no agents simply has no disclosure and its row runs full width. Expanded, each agent is its **own
full-width row**, which is a real thumb target where a line inside a two-line row is not, and it
pushes `SessionRoute.session(…, subagent:)` — the session with that agent already framed, the
phone's spelling of the dashboard's `?subagent=`. The rows come from the kit's `sessionSteps`
(`SessionSteps.swift`, the port of `packages/ui`'s `SessionSteps.tsx`): **agents sort above
tasks**, and `isAgentRecord` decides the *destination* rather than whether there is one. Every
step presses; an agent pushes its takeover, a task pushes `SessionRoute.session(…, reveal:)` —
the session, landed on that tool call's own row (`toolCallItemIndex` → the same focus request a
tapped notification rides, and so **terminal-renderer only**, since the cards renderer has no row
model to land on). A task used to draw inert here on the argument that there was nowhere to send
it; there always was, and the equivalent bug on the web was the opposite mistake — framing a
task's id, which selects no items and drew an **empty agent view**. Both kinds are one row shape
(`SessionStepRow`) with two route payloads, never a variant branch inside the row.

Three parity ports share one shape worth stating once: **the phone reuses the kit's rule and
supplies its own drawing.** `TerminalTodos` (the `TodoWrite` checklist) and `PlanRequest` (is this
approval a plan?) are ports of `todos.ts` and `plan-request.ts`, and each is the *single* predicate
both of this client's renderers branch on, so the cards prompt and the terminal prompt can never
disagree about what a plan is. The checklist diverges from the web in one place, and the divergence
is the height model: the web counts todo rows whether or not the row is open, because its heights
are the scrubber's estimate, while here the plan **is** the height, so a checklist counted while
open would be a frame around lines nobody paints — it is therefore planned on exactly the condition
it is drawn on, the way a diff already was. A plan's markdown needs a third renderer
(`TerminalPromptMarkdown`): the Cards one scales headings, which this grid cannot afford, and the
planner has the right vocabulary but returns wrapped lines for a height book that a self-sizing
prompt does not have — so the *rules* are copied from `planBlocks` (weight, never size) and the
wrapping deliberately is not. **Image paste** needs a `UITextView` subclass for a reason no amount
of delegate work escapes: `shouldChangeTextIn` sees the text a paste produced and never the
pasteboard it came from, so `paste(_:)` is the only place the clipboard is still whole. It takes
the web's rule that the first image wins and short-circuits the text paste, and adds one the web
has no say in — raw clipboard bytes over `UIPasteboard.image`, because a screenshot is PNG and the
API takes PNG, and decoding to re-encode as JPEG would be a lossy round trip on the single thing
people paste into an agent most.

**The phone draws no list selection**, deliberately: the dashboard paints a card blue and moves
the blue down to a step when a sub-agent is framed, but that needs list and panel on screen
together, and a `NavigationStack` push means the list is gone. So `--row-selected`,
`--row-selected-weak`, `--row-hover` and `--row-active` have no expression here.
`--badge`/`--badge-fg` do (`ListPalette`, beside `VendorPalette`): an unread count wears the tint
while its session is live and drops to the neutral badge once it settles, because the same number
on a finished session is a record rather than a call to look. The old third line spent a third of every row on a labelled `Idle`
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
being written down. Sub-agents render now: `SessionSteps.swift` ports the shared step model,
`SessionListView` draws the expandable step rows, and a step press lands in the takeover
(`SubagentTakeoverView`) rather than inline expansion — no hover on a thumb.
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

