# WorkerDeck for iOS

Native iOS remote control for a self-hosted [WorkerDeck](../../README.md) server: watch and
drive coding agent sessions from your phone — streaming transcript, permission prompts, session
creation/resume, context + rate-limit HUD, and a browser/editor for the host's project tree —
over your own network (typically Tailscale). No relay, no cloud: the app is a plain HTTP/WS
client to the gateway you already run.

Plan and research: `_docs/features/mobile-client.md` (gitignored, local).

## Layout

- `WorkerDeckKit/` — SwiftPM package, the platform-agnostic core (builds on iOS + macOS, unit
  tests run with plain `swift test` on a Mac):
  - `ProtocolTypes.swift` / `RestTypes.swift` / `JSONValue.swift` — hand-written Swift mirror of
    `@workerdeck/protocol` (see `WorkerProtocol.version`, kept in lockstep with
    `PROTOCOL_VERSION`). Decoding is lenient by contract: unknown event/frame/block types degrade
    to `.unknown`, never a stream error.
  - `WorkerClient.swift` / `SessionHandle.swift` — REST client + WebSocket session handle
    (attach/replay via `afterSeq`, reconnect with backoff, command outbox). Auth is
    `Authorization: Bearer <key>` on both REST and the WS handshake — native apps don't need the
    cookie machinery the web dashboard uses.
  - `Transcript.swift` — pure transcript reducer, a 1:1 port of
    `packages/react/src/lib/transcript.ts`. Keep the two in sync when transcript semantics change.
  - `ReplayHold.swift` — opening a session without watching its history stream past. The end of
    the replay is **stated**, not detected: the `attached` frame arrives before the replayed
    events and names the seq they end on. What the backstop decides is only *when to give up*,
    and it gives up on a **stall** rather than on a flat deadline from the attach — a phone
    replaying thousands of events over a tailnet does not finish in 1.5s, and the flat version
    fired on exactly the sessions the hold exists for. Progress is `state.lastSeq`, never raw
    arrival, so a reconnect storm cannot hold the screen. Not the quiet-window latch this design
    refuses: that refusal is about detecting the replay's *end* by timing, and the end is still
    stated. `TranscriptViewModel` holds the **whole reduced state** while it stands, not the
    transcript view — a session screen is more than its transcript, and approvals, the question
    prompt, the meters, the composer's busy state and the empty state all read the same state, so
    a replay used to drive every one of them through the session's entire history on the way past.
    Holding one view was never the fix; holding the state deletes the question of which views
    remembered to opt in. The placeholder is a spinner and a live `seq / target` counter, because
    a blank screen for several seconds is indistinguishable from a session that failed to open.
  - `MarkdownBlocks.swift` — splits assistant text into blocks: headings, lists, quotes, rules
    and fenced code, with anything it doesn't model (tables included) falling through as prose
    rather than being lost. Pure, so it lives here (this package is the only part of the app
    under test); the SwiftUI rendering stays in `App/`. **Streaming is the design constraint**:
    the classifier is strictly line-local, so a block renders in its final shape from its first
    character — a bullet that appeared as a paragraph and snapped into place a token later would
    be worse than not rendering it at all.
  - `Terminal/` — the terminal transcript's rules, ported from
    `packages/ui/src/components/terminal/`. Pure and testable, which is the point: the geometry
    of this theme is arithmetic, and arithmetic belongs where `swift test` can reach it.
    - `TerminalBlocks.swift` / `TerminalRows.swift` — the two folds (a run of consecutive tool
      calls is one row; a `Task` and everything its subagent produced is one row) and the row
      addressing over them. The load-bearing distinction: a run is built from **adjacency**, a
      task from **membership** (`parentToolUseId`), because parallel Tasks interleave in the
      stream. So a row covers a *membership*, never a contiguous `[index, index + n)` range —
      anything positional (a scrubber mark, a catch-up jump, "reveal that sub-agent") must go
      through `TerminalRows.rowIndex(forItem:)`.
    - `TerminalCells.swift` — the cell model and the wrap: grapheme widths, wide/pictographic
      clusters flagged inexact, break-after-hyphen (so `protocol-0.16.0` stays together), and
      preserved spaces that **hang** past the last column rather than forcing a break.
    - `TerminalPlanner.swift` / `TerminalPlan.swift` / `TerminalHeightBook.swift` — the port of
      `height.ts`, **turned inside out**. On the web the browser wraps and `height.ts` predicts
      how many lines that will be. Here the planner wraps, the renderer draws the lines it
      returned, and a row's height is `lines.count × line` by definition — there is no
      prediction that can be wrong and no post-mount correction. It costs nothing: the wrap was
      computed to measure the row anyway. `TerminalPlanCache` is what keeps a refold cheap on
      every streamed token, standing in for the web client's `WeakMap` on item identity (a Swift
      array is a value; there is no identity to hang one on).
    - `TerminalExpansion.swift` — which blocks are open, as an **input to the planner**. This is
      the one place the port deliberately inverts the web client rather than mirroring it: there,
      expansion is component-local `useState` and an expanded row is mounted and self-measures.
      Here nothing self-measures — a `UICollectionViewLayout` takes every frame from the height
      book — so a height the book does not know about is a frame the layout gets wrong. So the
      planner plans **both** states, `ResultPreview`'s expanded budgets stop being decorative
      (the whole of a hundred-thousand-character result lands in *one* virtual row), and the plan
      cache is keyed on the slice of the expansion **that row** can read — an epoch-wide
      invalidation would re-plan sixteen thousand rows for one finger. Two rules that are bugs if
      dropped: a call with nothing folded behind it (no result text, or a file edit whose only
      content is the diff already drawn) advertises **no press**, because a target that visibly
      does nothing reads as the theme being broken rather than the row being empty; and closing a
      result forgets that its character budget was lifted, so re-opening never lands back on the
      unclipped form for a reader who has long since scrolled away.
    - `MarkdownInline.swift` — inline markdown rendered once and shared by the measurer and the
      renderer, so `**bold**` cannot be measured as eight characters and drawn as four. The web
      client strips inline syntax with a regex chain; a second answer to "what does this render
      as" is a second answer that drifts.
    - `TerminalScrubber.swift` — the overview ruler's arithmetic, and **the thing the height book
      was built for**: a mark's position is its row's *pixel offset*, and almost every row a rail
      draws is unmounted, so only a computed height can answer for it. It lives in the kit for the
      reason the web client exports `buildClusters`/`railScale` for its tests alone — both have
      shipped pure-logic bugs, and neither is visible in a screenshot: a live answer with no
      `turn_result` yet went unmarked for the whole two minutes it was the only thing worth
      navigating to, and a replayed history (which carries no turn rows at all) came back with an
      empty response lane. So a response mark anchors on **the answer**, with a `turn_result` only
      *decorating* it. Two rules that are bugs if dropped: `railScale`'s denominator is
      `max(totalSize, viewportHeight)` and never `totalSize` alone (a transcript shorter than its
      window otherwise hangs thousands of points of empty scroll under three rows), and **a mark's
      item index is not its row index** — every one goes through `rowIndex(forItem:)`. Merging is
      what keeps a press cheap as well as legible: a dense session chain-merges each lane into one
      bar, so the cluster count is bounded by the rail rather than by the session, and the bar
      answers by its **nearest member** rather than by whichever mark founded it.
    - `ToolRun.swift` / `ResultPreview.swift` / `TerminalFormat.swift` — the exact strings. In
      this theme **the string is the height**, so every summary, preview and affordance is
      spelled once, here, and never in a view.
  - `SessionList.swift` / `Watermarks.swift` — ports of `packages/protocol/src/session-list.ts`
    and `watermarks.ts`, the same way `Transcript.swift` is a port of the react reducer. The
    sessions-list view model (the `attention/working/idle/ended` buckets, the gateway/adapter/
    state facets, filter/group/sort, `subsetSummary`) and the unread model (monotonic marks
    behind a storage seam, `unseenCount`'s rows-not-turns arithmetic). These are **rules**, not
    this app's preferences — the VS Code extension's activity-bar badge counts the same rows its
    list shows and the dashboard renders the same list, so a client that filtered differently
    would be announcing work it is hiding. Two Swift-specific notes: JS `sort` is stable and
    Swift's is not, so both the row and the group sort carry an explicit insertion-index
    tiebreak; and `ViewConfig` decodes leniently over its defaults, the Swift spelling of the
    webview's spread.
  - `PromptToken.swift` — the `@file` and `/command` rules in one place: which words are tokens,
    which are being typed, which are finished, and how one is replaced. Here for the same reason
    as `MarkdownBlocks` — pure string logic whose interesting cases are all edges — and shared, so
    a token looks the same in the composer as it does once sent. Both need a word boundary and
    nothing more — so `toby@example.com` isn't a file picker, and a command completes mid-draft
    as well as at the front (the CLI only *runs* one from the front, but the picker is an editing
    aid). What keeps an absolute path from reading as a command is the charset: a command name
    may not contain a slash.
- `App/` — the SwiftUI app (hosts, sessions, transcript, permissions, HUD). Hosts + auth keys
  are stored in the Keychain.
  - `App/Sources/Sessions/{SessionListModel,SessionListView}.swift` — **one list across every
    configured gateway**. The gateway is a facet of that list (filter/group/sort), never the
    frame it lives in: there is no "current server" mode, and a gateway that is unreachable or
    unauthorized is a banner beside the rows rather than a broken screen — on a tailnet the usual
    failure is "the VPN dropped", not "the data is gone". Everything visible is derived through
    the kit's shared rules (`rows → filtered → groups`, plus the subset line), with the workspace
    scope passed as `nil` throughout: a phone has no open folders, so that filter is genuinely
    inert here rather than hiding everything. The poll follows the work (2s while anything runs
    or waits on a human, 5s otherwise) and runs only while the list itself is on screen — inside
    a session, that session's socket is the fresher source. Each row carries an **unread count**
    (`App/Sources/Model/UnreadModel.swift`, the kit's `Watermarks` over `UserDefaults`), and the
    same sum — over the rows the filter is *showing*, never the hidden ones — is stamped on the
    app icon. Marks are written only while a session is genuinely on screen and attached; the
    session view re-fetches once on disappear and marks a final time, so rows produced after the
    last snapshot don't come back as unread. Renaming is a leading swipe or a context menu →
    `PATCH /sessions/:id`, a gateway edit rather than a local override, so the name reaches the
    dashboard and the extension too (and an empty one restores the derived title).
  - `App/Sources/Session/Terminal/` — the terminal transcript's *rendering* half, over the rules
    in the kit's `Terminal/`. It is a **renderer, not a set of branches**: it draws every row
    itself, and nothing under the cards path asks which variant it is in. (That is the lesson of
    the deleted `lines` variant, which survived only as an `isLines` branch duplicated across
    fifteen view bodies.)
    - `TranscriptMetrics.swift` — the cell, **measured** over 200 characters rather than derived
      from the font size (a 12pt monospace face advances ~7.4pt, not 7.2). The cell keeps its
      exact fractional advance and only the **line** is rounded to a whole point: a fractional
      line puts every second row on a half-pixel, which softens the text and seams the diff
      bands, while rounding the *cell* up costs a fraction of a point per cell — four characters
      a line at phone widths, about nine percent of the transcript.
    - `TerminalRowCell.swift` / `TerminalPalette.swift` — the row, **drawn by hand in UIKit**,
      and the palette, ported value-for-value from `styles/terminal.css` so a session reads the
      same here as in the dashboard. Three views per row — a backdrop, a gutter and a body —
      where there used to be a `UIHostingConfiguration` holding two SwiftUI views per *line*.
      The reason is not performance (that came free): **the body has to be one selectable text
      run**, and a stack of per-line `Text`s cannot be selected across. So each `TermLine`
      becomes one TextKit *paragraph* with wrapping off (`.byClipping`) and
      `minimumLineHeight == maximumLineHeight == metrics.line`, its head indent set to where its
      body column starts — N planned lines are N line fragments of exactly `line` points, and
      the height the book handed the layout is the height the text occupies, by construction.
      Get `lineFragmentPadding`, `textContainerInset`, the min/max line heights or the break
      mode wrong and every row is off by a fraction with nothing visibly wrong, which is why
      `TerminalAudit.measureHeights` exists beside the width gate.
      **The gutter stays its own column, and it is drawn, never text** — not for layout, for
      what lands on the clipboard: `●`, `⎿` and a diff's line numbers are scaffolding nobody
      typed and nobody wants pasted into a commit message. (It also gives every wrapped line its
      hanging indent for free, which is why the planner pads gutters to a cell count rather than
      prefixing the text.) The bands, the open wash and the nested rule are drawn per line for
      the same reason the gutter is: an expanded result is fifty lines, and fifty background
      views per row is exactly the per-cell view count this shed. Presses ride the plan
      (`TermLine.press`), resolved by dividing the touch's `y` by the line — **the whole block,
      not just its header, which is where the web client puts its `Pressable`**: a pointer can
      hit a 19px strip and a thumb cannot. A press is refused while a selection stands in the
      row, because collapsing the block would take the selection with it. An open block keeps a
      full-bleed wash (`TermLine.inOpen`, the web's `.term-open`) so eighty lines that arrived
      at once read as one block rather than as the transcript having grown.
    - `TranscriptLayout.swift` / `VirtualizedTranscriptView.swift` — a `UICollectionView` with a
      custom layout whose frames come **entirely** from the height book; no self-sizing anywhere.
      That is what makes the rest possible: an overview scrubber needs the pixel offset of rows
      that were never mounted, and only a computed height can answer for a view that does not
      exist. Stick-to-bottom and size-change correction are split into two regimes, as on the
      web — pinned, corrections are suppressed entirely (being at the bottom *is* the scroll
      position); escaped, the row under the viewport's top edge is re-anchored **by key**, since
      "the same row" is a membership question once folds are in play. Expansion is part of that
      epoch and has to be: it moves no row and changes no key, so the coordinator's guard would
      otherwise swallow it and the layout would keep drawing collapsed frames. `reveal` is the
      other half — the iOS spelling of `useRevealOnOpen`, one-directional and only on the open
      transition. The escaped case barely needs it (the anchor already holds the pressed row
      still); it exists for the **pinned** case, where expanding near the tail re-pins to the
      bottom and pushes the header you pressed clean off the top of the screen.
    - `TerminalStickyPromptView.swift` / the kit's `StickyPrompt.swift` — the prompt of the turn
      you are reading, held at the top of the scroller. **One line, and the prompt's first line**:
      a pasted twenty-line prompt pinned whole covers the very answer being read. The arithmetic
      is in the kit (and unit-tested) and the view only draws what it returns — a
      `UIViewRepresentable` overlay cannot be driven by a test, and the arithmetic is the part
      that can be wrong. Where the web client needs real machinery for this (a lane per turn, an
      absolutely positioned head, a sentinel `IntersectionObserver`, and the compositor doing pin
      and push-off because a JS-written pin trails it and wobbles), here it is a binary search and
      a subtraction: the height book knows the pixel offset of every row, mounted or not. Two
      rules earned their tests. **Content offsets, never frame offsets** — the blank line above a
      row belongs to the row, so a prompt's frame starts one line before its text does and that
      strip is visually the *previous* turn's; searching by frame handed over a line early. And a
      **subagent's brief is not a prompt** — it really is a `user_message` on the wire, which is
      why it once drew the human's own `❯`, but a turn is a thing a person started.
    - `TerminalScrubberView.swift` — the rail, drawn, and where the phone parts company with the
      web design twice. **There is no hover**: a pointer resting on a mark opens the peek there and
      a drag *dismisses* it, which would leave a finger no way to see a mark before committing to
      it — so here a drag scrubs **and** peeks what it is passing, and a clean press with no travel
      is a jump on a mark, a scroll-to-here on the ground. And **12 points is not a touch target**:
      the paint is the theme's 12 (the one place the `ch` rule is set aside — the rail is chrome
      beside the grid, not a column of text) and the hit strip is wider, though deliberately not
      the HIG's 44, because this sits where a right thumb scrolls. Three structural notes: it is a
      `Canvas` with arithmetic hit-testing rather than a view per mark, since a dense rail is
      hundreds of clusters repainted per scroll tick; the band is **its own view**, because
      observation is per body and reading the scroll offset beside the clusters would rebuild every
      one of them per frame of a fling; and the whole thing is a **full-width overlay with only the
      strip taking touches**, because a peek is wider than the rail and laying it out inside a
      28-point container puts it off the screen. A scrub goes to a content offset, never to a row —
      a rail drag is continuous, and snapping to row boundaries makes a hundred-line answer a dead
      zone. The transcript's wrap width is reduced by the rail for the same reason it is reduced by
      the bleed: the rail is an overlay, and a row wrapped to the full screen has its last column
      drawn underneath it — silent clipping the audit cannot see, because the line fits the column
      it was planned for and the column is simply covered.
    - `TerminalAudit.swift` — the gate. The planner counts cells; if a line's real rendered width
      ever exceeds the column it was planned for, it is clipped *silently*, which is worse than a
      wrong height because nothing about it looks wrong. Debug-only and deliberately not a unit
      test: a unit test would check the calculator against its author's assumptions. It is
      reported on screen by the `terminal` preview — a gate nobody reads is a gate that has never
      run. It ignores trailing spaces on purpose, those being the wrap model's own hanging
      spaces rather than an overflow. It audits **both states**: a summary that wraps correctly
      says nothing about the fifty result lines folded behind it, and planning is pure, so the
      second pass costs a calculation and draws nothing. `UIPREVIEW=terminalOpen` is the visual
      counterpart — the same fixture with every block open, through a real layout pass, which is
      the only thing that can show a planned line and a drawn line parting company.
      `measureHeights` is the **second** claim, and the one the hand-rolled renderer added: the
      text really draws at the height the book handed the layout. It mounts a real text view per
      row, so it is **capped and says so** (`heights exact over first 400 rows`) — a gate that
      quietly covered a tenth of the rows reads as a gate that covered them all.
  - `App/Sources/Session/SessionStatusBar.swift` — the mini status bar, one glass line floating
    just above the composer where a thumb reaches it: status, model, permission mode, usage. The
    status slot is **shared with connectivity, and connectivity wins it** — while the socket is
    down the session status the app holds is stale, so "Reconnecting…"/"Offline" replaces it
    rather than sitting beside it. (The handle retries forever; "Offline" is the app's judgement
    after three failed attempts, not a state the handle reports.) Model and permission mode are
    chips that open their own menus — the two settings worth changing mid-run, so they are not in
    the toolbar. Usage is per-window presence, not a mode flag: a radial gauge for each rate-limit
    window the session reports — session, weekly, then whichever per-model window it has — and the
    session's `$` cost only when it reports none. Each ring carries its own label *inside* it —
    0–99 for the context percentage, then S (session), W (weekly) and the model's initial for a
    per-model window — because four rings and four adjacent percentages is more line than a phone
    has. Three tap targets, not one: the status opens `SessionInfoSheet`, the context ring
    `ContextSheet`, the usage rings `UsageSheet`, with a wider gap between the two ring groups so
    a thumb can find the seam. The rings are hand-drawn (`Circle().trim()`) rather than stock:
    `ProgressView`'s `.circular` style is indeterminate-only on iOS, and a `Gauge` with
    `.accessoryCircular` is sized for a watch complication and goes hairline when scaled to fit
    here.
    Neither chip ever says "Default": a running session has a concrete model and permission
    mode, and naming them is the point of the bar. "Default" is a *choice you make when starting
    a session*, so it survives only as a DEFAULT tag on one row of each picker — which row, the
    app learns from `system_init` (the CLI resolves the default; nothing lets you ask what it
    would pick, so the answer is what it did pick). A promptless session has no `system_init`
    until its first message, so until then the model chip reads "Model" rather than claiming a
    value — except that it usually does know: `capabilities` carries `defaultModel` (what the
    CLI's own `default` row points at), which lands seconds after the session starts and long
    before any `system_init`, so the chip names the model from the first frame. The permission
    mode named `default` on the wire is shown as **Manual**, which is what
    Claude Code calls it — the two readings of the word ("ask me every time" and "whatever the
    server picked") are exactly what the bar must not conflate.
  - `App/Sources/Session/SelectionSheets.swift` — the model and mode pickers, shaped like the
    CLI's own selectors: a title, a close button, one rounded card of rows with what each choice
    *does*, coloured icons for the modes, a blue check on what is in force and a blue DEFAULT tag
    on what the session started with. Sheets rather than `Menu`s because a `Menu` is rendered by
    UIKit and gives you a title, a subtitle and an image per row — no descriptions worth reading,
    no icon colour, no styled tag. Every model row comes from the CLI, including its own
    "Default (recommended)" entry — which the **server** drops, along with naming and grouping
    the rest (`modelOptionsFromSdk` in core, so the dashboard and the phone agree). Matching the
    model a session *reports* (`claude-opus-5[1m]`) to the row that names it (`opus[1m]`) is
    `ModelOption.matches` in the kit: exact, then `resolvedModel` — **authoritatively**, including
    when it disagrees, or "Opus 4.8" would check itself alongside "Opus 5" — and only for a row
    that declares none, the family token, which is what keeps the chip readable against an older
    server. The chip drops a trailing parenthetical, so "Opus (1M context)" fits as "Opus".
  - `App/Sources/Session/SessionEmptyState.swift` — what a session shows before it has said
    anything: which directory the agent is in, and that the composer takes `/commands` and
    `@files` (each hint conditional on the thing actually being available). **It is sized from
    the height it is offered and sheds parts rather than pushing**: icon first, then the path,
    then everything. The space it decorates halves when the keyboard opens and is small to begin
    with in landscape, and a decorative panel must never be the reason the composer ends up
    underneath the keyboard. The measurement is a `GeometryReader`, floored by the composer's
    focus state — belt and braces, because whether SwiftUI shrinks this particular stack for the
    keyboard is not something to bet a layout on.
  - The New Session form opens the *same* model and mode pickers as a live session. Its model
    list comes from `ProfileInfo.models`, which the server remembers from the last session that
    ran on that profile — so a server that has never run one still shows a text field.
  - `App/Sources/Session/{ContextSheet,UsageSheet,SessionInfoSheet}.swift` — the three sheets
    that were one "Session details" list. They answer different questions at different moments
    (what is in the window / how much plan is left / what is this session), so scrolling past
    two of them to reach the third was the whole problem. Each is also in the toolbar menu.
    `UsageSheet` draws a **pace marker** on every window: a tick at the elapsed share of the
    window's duration, so "17% used" can be read against how far into the week you are. The
    duration comes from the key (`five_hour` → 5h, `seven_day*` → 7d) because the CLI reports a
    reset time and a percentage and never a duration; a window whose key doesn't say gets no
    marker. The plan capsule says "Max", not "Max 20x" — `subscription_type` is a tier, and the
    multiplier a subscription page shows is not in the data.
  - `App/Sources/Session/ComposerView.swift` — the input card, in two shapes. At rest it is the
    field and nothing else; once it has focus, a draft, a staged photo, or a turn to stop, an
    action row unfolds underneath: attach on the left, hide-keyboard and send on the right. There
    is deliberately **no dictate button** — iOS puts a microphone on the keyboard itself, under
    the thumb that is already there, and a second one would only compete with it. One send button
    does both jobs: a draft always sends — messages queue behind a running turn — and stop takes
    the slot only while a turn is live *and* there is nothing to send. Tapping the transcript puts
    the keyboard away.
  - `App/Sources/Session/{AddMediaSheet,ComposerAttachments,AttachmentThumbnail}.swift` — the plus
    button's three sources (Camera / Photos / Files) and everything behind them. Files are
    **uploaded as they are picked**, not at send time, so by the time a message is typed its
    photos are already on the gateway and the command carries three short ids; the chip shows the
    thumbnail the phone already has, so nothing waits on the network to appear. `AttachmentNormalizer`
    is the load-bearing part: an iPhone shoots HEIC, which no model accepts, so a photo is
    transcoded to JPEG here rather than refused by the gateway with a media type the user never
    chose — and downscaled to 1568px, roughly what a vision model resizes to anyway. A failed
    upload blocks the send (tap the chip to retry) instead of being silently dropped from it.
    Transcript thumbnails go through `AttachmentLoader`, because the gateway authenticates with a
    header and an `AsyncImage` pointed at the URL would 401.
  - `App/Sources/Session/McpServersView.swift` — the `/mcp` screens, four levels deep like the
    CLI's own picker (servers → server → tools → tool), grouped by config scope. Reachable from
    the actions menu, and by typing `/mcp`, which the composer **answers locally** rather than
    sending: the CLI's `/mcp` is an interactive picker, not a prompt, so forwarding it would spend
    a turn on a model reading the word "/mcp". One thing the CLI shows that this cannot is a
    tool's parameters — the engine's status payload carries no input schema.
  - `App/Sources/Session/PromptSuggestionList.swift` — the `/` and `@` picker, filling everything
    the header and the floating stack leave. It is a **`ZStack` sibling of the transcript, not an
    overlay on it**: an overlay on a `ScrollView` is proposed the scroll content's *ideal* size
    (measured at 305×616 on a 402×874 screen), so the panel came out neither full width nor full
    height. Inside the stack the frame is already safe-area-inset, so the only offset it needs is
    the floating stack's own measured height. The status bar steps aside while it is open, and the
    panel's height is fixed rather than fitted to the rows — a list that shrank as the filter
    narrowed would move the row you were reaching for.
  - `App/Sources/Support/GlassPanel.swift` — the one translucency decision, in one place.
    `glassEffect` on iOS 26, a blurred material with a hairline border below it. Nothing in the
    session screen is docked: the navigation bar and the bottom stack (warnings, approval, status
    bar, composer) both float, and the transcript scrolls under them.
  - `App/Assets.xcassets/AppIcon.appiconset` — the app icon, three 1024 renditions (opaque,
    plus the transparent-ground Dark and Tinted appearances iOS 18 asks for). The PNGs are
    generated from `docs/assets/app-icon-apple-{master,layer}.svg`; regenerate with the command
    in `docs/assets/BRAND.md` §"Regenerating the iOS app icon" rather than editing them.
    `ClaudeCode.imageset` is the exception to everything in `BRAND.md`: it is **Anthropic's**
    mark, not ours, copied from `docs/assets/claude-code.svg` and kept at its own colour. It
    labels the plan line in `UsageSheet` — the one place the app names whose limits it is
    showing — and is used nowhere else. The catalog vectors the SVG
    (`preserves-vector-representation`), so there is no PNG rendition to regenerate.
  - `App/Sources/Push/` — remote notifications, which exist because iOS will not hold a WebSocket
    open in the background: the WS is for while you're looking at the screen, APNs is the resume
    signal for every other moment. The token is registered **per gateway** (`POST /apns/devices`
    on the server's own origin, behind the same auth key), tagged with the app's own `hostId` so
    a push can say which server sent it, and with the APNs environment read out of the embedded
    provisioning profile rather than guessed from `#if DEBUG` — see `docs/GOTCHAS.md` §APNs for
    why that distinction is expensive to get wrong. A `permission_requested` push carries
    Approve/Deny actions that answer over REST without opening the app; tapping the body deep-links
    to the session. A gateway with no forwarder configured answers 404 and the app stops asking.
    **The session on screen is never announced**: `PushCoordinator.visibleSessionId` is claimed by
    `SessionView` and released when it leaves or the app backgrounds, and `willPresent` returns no
    options for it. Every other session still banners in the foreground — the app holds a socket
    only for the one you are looking at, so those are as invisible as they are in the background.
    (The server-side alternative — have `SessionNotifier` skip sessions with an attached client —
    would fix this for the dashboard too, at the cost of coupling the notifier to the registry.)
  - `App/Sources/Files/` — the host file browser, reached from the folder button in an open
    session's toolbar. **Scoped to that session's `cwd`**: rooted there, with no roots list and no
    way up, because what you want on a phone is this project's tree, not an inventory of what the
    gateway exposes. (The server's `--fs-root` roots are still the security boundary; this scope
    is only what's offered.) Directory per navigation level so the stack *is* the path, a
    monospaced `TextEditor` for text files, base64 content refused rather than opened. Three
    server facts drive the UI: `/fs/roots` 404s on a gateway with no `--cwd-root` and no
    `--fs-root`, which renders as "no file access" with the flag to add; a cwd outside those roots
    404s its listing, which gets its own screen because the fix is different (it should be rare —
    reading follows the cwd roots, so a session that was allowed to start is normally browsable);
    and `canWrite` is false without `--fs-write`, which hides Save. Saving sends the hash the read returned, so a 409 means the
    agent edited the file first — the alert offers Reload, never a force.
    `FolderPickerView` is the same tree asked a different question: the New Session form's cwd
    picker, which starts at the **roots** (there is no cwd yet — that is what is being chosen),
    lists directories only, and makes every level selectable as well as enterable. Those roots
    are the server's read roots, so a folder picked here is one the gateway will also start a
    session in. Typing a path by hand still works, which is what a gateway with no roots leaves
    you.
  - `App/Sources/Session/PromptCompletion.swift` — one suggestion list, two tokens. `/commands`
    come from the `capabilities` event, so filtering is local, synchronous and complete;
    `@files` are a search over `GET /fs/find`, debounced and single-flight, and a 404 turns file
    completion off for the session rather than re-asking per keystroke. The text half is
    `PromptTokens` in the kit. Accepting appends a space, which is also what closes the list.
  - `App/Sources/Session/RichTextEditor.swift` — the app's **only UIKit bridge**: a
    `UIViewRepresentable` over `UITextView`. On the 17.0 deployment target SwiftUI can neither
    style part of a draft nor say where the caret is, and both wants have the same fix — so the
    bridge buys styled tokens *and* mid-message completion at once. Styling goes through
    `textStorage` attributes (the undo stack and selection survive), skips while `markedTextRange`
    is non-nil (IME composition), and only paints *confirmed* tokens — the word still being typed
    stays plain. Everything else in `App/` remains plain SwiftUI.
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; the `.xcodeproj` is
  generated, not checked in. So are `Info.plist` and `WorkerDeckApp.entitlements` — declare
  capabilities here, because Xcode's "+ Capability" button edits the generated project and is
  erased by the next `xcodegen generate`. `aps-environment` stays `development` in the file:
  that is what an Xcode build needs, and Xcode rewrites it on export for TestFlight.

## Building

```sh
# Kit tests (no Xcode project needed)
cd apps/ios/WorkerDeckKit && swift test

# What an attach actually costs, over a REAL replay — both opt-in, both silent
# without their inputs, so the suite stays green on a machine with neither.
node _docs/capture-attach.mjs <host> <sessionId> /tmp/attach.jsonl   # from the repo root
WD_ATTACH_CAPTURE=/tmp/attach.jsonl swift test -c release --filter AttachReplayBench
WD_ATTACH_HOST=<host> WD_ATTACH_SESSION=<id> swift test -c release --filter AttachPipelineBench

# App
cd apps/ios && xcodegen generate && open WorkerDeckApp.xcodeproj
# or headless:
xcodebuild -project WorkerDeckApp.xcodeproj -scheme WorkerDeckApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

The app target needs Xcode's **iOS platform** installed (`xcodebuild -downloadPlatform iOS`, or
Xcode → Settings → Components). Without it `xcodebuild` reports *"iOS <version> is not installed"*
and offers no simulator destinations at all — even though `xcodebuild -showsdks` lists the SDK.

Point the app at your server's base URL (e.g. `http://your-mac.tailnet-name.ts.net:8787`) and
paste the `--auth-key`. The app talks to `<base>/v1`. Plain-`http` hosts on a tailnet are
allowed via an ATS exception in the app — tighten this if you ever distribute beyond personal
use.

## Pushing a build to your phone

```sh
apps/ios/scripts/deploy.sh              # generate, build, install, launch
apps/ios/scripts/deploy.sh --no-launch  # install only — works on a locked phone
apps/ios/scripts/deploy.sh --release    # optimized build — what a shipped app costs
```

`--release` matters for one thing and it is not cosmetic: **any performance number taken off a
Debug build is a number about the build.** The transcript fold alone is ~5.6× slower unoptimized
(26 ms → 151 ms over a captured 779-event replay, measured 2026-08-19), and every build this
script has ever pushed was Debug. `--hot` still needs Debug — InjectionNext swaps code the
optimizer inlined away — so the two refuse each other.

This is the loop to run while working on the app, so a change can be looked at on the real
device rather than in a simulator screenshot. It works over Wi-Fi with no cable: CoreDevice
reaches a paired phone on the same network (`transportType: localNetwork`).

Configuration is machine-local, in `apps/ios/.deploy.env` (gitignored) or the environment:

```sh
IOS_DEVELOPMENT_TEAM=XXXXXXXXXX   # device signing; project.yml deliberately pins no team
IOS_DEVICE="Your iPhone"          # optional when exactly one device is available
```

Three facts the script exists to encode, each of which costs a build to rediscover:

- **Build with `generic/platform=iOS`, never `id=<udid>`.** A device-targeted build wants to talk
  to the phone ("may need to be unlocked to recover from previously reported preparation errors")
  and fails when it is locked. A generic build never touches it.
- **Installing to a locked phone works; launching does not** — `FBSOpenApplicationErrorDomain
  error 7`. The script reports that as a sentence and exits 3, so an agent can install
  continuously and only ask for an unlock when it wants the app in the foreground. (`devicectl
  device info lockState` does *not* answer this: it reports `passcodeRequired` and
  `unlockedSinceBoot`, not whether the screen is locked right now.)
- **Device signing needs an explicit team** on the command line, since `project.yml` pins none.

The pragmatic answer to "can it relaunch while the phone is locked" is no; a longer auto-lock
window during a work session is the workaround.

## Hot reload (InjectionNext)

Debug builds are wired for [InjectionNext](https://github.com/johnno1962/InjectionNext): edit a
view, and the running app swaps in the new code with its navigation stack and state intact —
no rebuild, no relaunch, no losing your place. Three pieces, all Debug-only:

- `project.yml` links Debug with `-Xlinker -interposable` (function implementations become
  replaceable) and sets `EMIT_FRONTEND_COMMAND_LINES=YES` (how InjectionNext learns to recompile
  one file the way this project compiles it).
- A `--hot` build phase copies InjectionNext's prebuilt bundle into the app and codesigns it.
  Opt-in per build because it also copies the XCTest frameworks and costs seconds:
  `scripts/deploy.sh --hot`. The **Simulator needs none of this** — it reads the bundle straight
  out of `/Applications/InjectionNext.app`.
- `App/Sources/Support/HotReload.swift` loads the bundle at launch and provides `@HotReloaded`.

**`@HotReloaded` is not optional.** Add it as a stored property to any view you want to
hot-reload:

```swift
struct UsageSheet: View {
  @HotReloaded private var hot
  ...
}
```

A single observer at the root does not work, and it is worth knowing why: injection replaces the
implementations, but SwiftUI only re-runs a `body` whose *inputs* changed — a redrawing parent
hands its child the same struct value as before, and the child is skipped. Measured, not
assumed: a root-only observer logged "Rebound 5 symbols" and left the old pixels on screen. This
is the same reason the [Inject](https://github.com/krzysztofzablocki/Inject) package's API is a
per-view `@ObserveInjection` — `@HotReloaded` is that idea in a dozen lines, so the app keeps its
zero-third-party-Swift-dependencies rule. Swapping in `Inject` would be a fair trade if this ever
needs maintaining; it also handles UIKit view controllers, which this app has one of.

**Running it:** install `InjectionNext.app` in `/Applications`, launch it, and use its own menu
to open Xcode on this project — its supervised mode is the reliable one. Injection into a
headless `xcodebuild` loop half-works: the app connects and injects via the "builtin" fallback,
but the log-scanning path that finds the real compiler command is brittle against a custom
`-derivedDataPath`. Set `INJECTION_PROJECT_ROOT=<apps/ios>` in the environment (or
`SIMCTL_CHILD_INJECTION_PROJECT_ROOT` for a simulator launch) to make it file-watch this project.

For a **device**, InjectionNext additionally needs "Enable Devices" turned on in its menu, a
network port opened, and the expanded codesigning identity selected — GUI steps, done once.

What it cannot do: add or remove stored properties, change a function's signature, or introduce a
new file. Those still need `scripts/deploy.sh`.

## Looking at a screen without a gateway

Most screens need a live session against a real server before they render anything. Set
`UIPREVIEW` to render one of them from canned data instead of the app —
`App/Sources/Support/UIPreviewHarness.swift`, which is where the variants and their fixtures
live:

```sh
SIMCTL_CHILD_UIPREVIEW=usage xcrun simctl launch --terminate-running-process booted \
  bi.atomic.workerdeck.ios
xcrun simctl io booted screenshot /tmp/usage.png
```

`terminal` renders the terminal transcript over a fixture built to exercise the row model rather
than to look plausible — a folded run, two `Task`s whose children interleave, a diff carrying the
engine's own line numbers, and a result long enough to hit both preview budgets. It reports the
**overflow audit** across the top: the one thing that can catch the cell model disagreeing with
real text layout, which would clip a line silently. `terminalStress` is the same screen over
16,000 rows, which is what the virtualized engine exists for.

Two things that don't work and are worth not re-trying: driving the simulator's UI with System
Events (clicking needs an Accessibility grant a CLI shell doesn't have), and guessing a layout
bug from pixels — when a SwiftUI layout misbehaves, render the geometry numbers into the view
and screenshot those.

## Push on the Simulator

The Simulator has no APNs connection — `deviceToken` is nil there forever — but `simctl push`
injects a payload locally, which is enough to check the part that is easy to get wrong: that the
category identifier matches and the Approve/Deny actions actually appear. Install the app, launch
it once and tap **Allow** on the notification prompt, then:

```sh
cat > /tmp/perm.json <<'JSON'
{
  "aps": {
    "alert": { "title": "Approval needed — my-repo", "body": "Bash · pnpm test --filter content-gate" },
    "sound": "default",
    "category": "PERMISSION_REQUEST",
    "thread-id": "sess_demo"
  },
  "type": "permission_requested",
  "sessionId": "sess_demo",
  "seq": 42,
  "hostId": "host_demo",
  "requestId": "req_demo"
}
JSON
xcrun simctl push booted bi.atomic.workerdeck.ios /tmp/perm.json
```

**Long-press the banner.** Swiping it only ever offers "Open" — the Approve/Deny buttons live
under the expanded notification, and mistaking that for a missing category is the trap here. The
payload above is the shape `buildPush` emits (`packages/cli/src/apns/forwarder.ts`); keep it in
step with that function, and with `PushCategory` in `App/Sources/Push/PushPayload.swift`.

Approve/Deny answer over REST, so on the Simulator they will fail against `host_demo` — what this
proves is the notification surface, not the round trip. The round trip needs a real device against
the sandbox gateway.

## Protocol lockstep

This app speaks the wire protocol directly (it replaces `packages/client` + `react` + `web` on
mobile). When `packages/protocol` changes:

1. Bump-check: the app warns when `AttachedFrame.protocolVersion` ≠ `WorkerProtocol.version`.
2. Mirror the type change in `ProtocolTypes.swift`/`RestTypes.swift` and update
   `WorkerProtocol.version`.
3. If transcript semantics changed, port the `transcript.ts` diff into `Transcript.swift`.

Not yet mirrored (later phases): the job-queue REST/WS surface, profile create/update/delete,
browser-bridge tool hosting (the app answers `tool_call_request` with a polite refusal).

**Truncated tool results.** The attach asks for `?truncateResults=1` (in `TranscriptViewModel.run`
and nowhere else — the opt-in belongs to the unit that renders), so an oversized `tool_result`
arrives as its head with `truncated`/`total_chars` set, and the rest is one
`WorkerClient.toolResult` away. The press is the terminal renderer's third expansion state:
`TerminalExpansion.pending`, drawn as `… fetching N chars` with no press of its own, promoted to
`full` by `TerminalTranscriptModel.update` when the fetched text lands on the item. It is
deliberately not planned from `total_chars` — that would invent a line count for text nobody has
seen, which is the estimate-and-correct model this renderer exists not to be. The cards renderer
carries the same affordance, because the variant is a preference and a head reaches both.

**Tool-result images.** The attach also asks for `?imageRefs=1` — its **own** flag beside
`truncateResults`, not a widening of it, and asked for in the same one place. A `tool_result`'s
base64 `image` parts then arrive as `image_ref` addresses (`media_type`, decoded `bytes`,
`part_index`) and the bytes are fetched over `WorkerClient.toolResultImage` when the row is
actually on screen. This is where the payload was: measured across 214 local sessions, **91% of
all tool-result payload is base64 no client renders** — `joinedText` drops it exactly as the web's
`blockText` does — so this makes a tool's pictures visible on the phone for the first time *and*
takes them off the wire.

The height model is what shapes the rendering. Everything else here is planned and then drawn, so
an image cannot be sized by its own pixels: nobody has fetched them, and a row that self-corrected
on load would be the estimate-and-correct model this renderer exists not to be. So the planner
reserves a **fixed box of `TermImage.boxLines` (12) whole lines per image** — the same constant
the web client uses — carried on the box's first `TermLine` as a `TermImageBox` with the lines
under it merely holding the grid. The box is that size in all three states (placeholder
`image · 335.0 KB`, the picture, `image unavailable`), so a fetch landing or failing can never
reflow the transcript, and `TerminalAudit` needs no new claim: a box of K lines is exact by
definition.

Two divergences from the web client, both deliberate:

- **The box stays fixed when the row is expanded.** There an expanded row is mounted and
  self-measures, so an image may reveal its intrinsic size; here nothing self-measures. Tested as
  a divergence, like run-of-one.
- **Cards does not draw them.** The terminal renderer is the one that reserves grid, and a
  fixed-height frame in the cards renderer is a separate piece of work. Images in the cards
  variant stay as invisible as they are today, which is a gap rather than a regression.

Laziness is the collection view's own: `willDisplay` fires the fetch, `didEndDisplaying` cancels
the `URLSession` task, and `TerminalImageLoader` holds an `NSCache` of *decoded* images between —
so a scroll back is free and a fast scrub through an image session does not pull fifty screenshots
nobody read. A failure is remembered rather than retried, because a stale address after a dormant
wake 404s by design (the gateway verifies `toolUseId` rather than serving another call's pixels).
