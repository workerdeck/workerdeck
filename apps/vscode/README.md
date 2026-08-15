# WorkerDeck for VS Code

The agent rides in the editor: WorkerDeck sessions in the bottom panel (next to Terminal),
gateways and sessions in a left sidebar, and — for remote gateways — the session's project
mounted as a `workerdeck://` virtual workspace folder. The panel is the real
`@workerdeck/ui` `SessionPanel` on a real `@workerdeck/client`, so everything the dashboard's
session surface does (streaming transcript, approvals, composer with attachments and `/` `@`
completion, model/permission switches, capability gating per engine) works here unchanged.

Design + decisions: [`docs/ROADMAP.md`](../../docs/ROADMAP.md) (what shipped, and what is still
open) and the extension section of the root [`CLAUDE.md`](../../CLAUDE.md) (the navigation rule
the sidebar was rebuilt around). Not published to the Marketplace yet — build the `.vsix` and
side-load it.

## How it connects

The webview never talks to the network. It runs a `WorkerDeckClient` whose `fetchImpl` and
`WebSocketImpl` are `postMessage` shims (`webview/bridge.ts`); the extension host executes
them with Node `fetch` / `ws`, injecting the gateway's `Authorization: Bearer` header there
(`src/panel.ts`). Auth keys live in VS Code `SecretStorage` (the OS keychain) and never enter
the webview; the webview CSP has no external `connect-src`. The bridge refuses URLs that
don't belong to a registered gateway, so it can't be used as an open proxy.

Local vs remote is decided per gateway from its URL (`isLoopbackHost`), never by probing
paths. Three tiers:

- **loopback gateway** — transcript paths open real files; "Open Session Project Folder"
  adds the real folder.
- **remote gateway** — paths open `workerdeck://<hostId>/<path>` via the FileSystemProvider
  (`src/fsp.ts`): reads/lists over `/fs/*`, hash-guarded conditional writes (a 409 tells you
  the agent got there first — nothing silently overwrites), no mkdir/delete/rename (the
  gateway has no such routes), read-only when the gateway hasn't opted into `hostFiles.write`.
- **Remote SSH window** — `extensionKind: ["workspace", "ui"]` runs the extension on the
  remote host, where its loopback gateway is local and the first tier applies. Zero
  extension code; full fidelity.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `workerdeck.fontFamily` | `editor` | Typeface for the **agent panel**: the editor font (monospace) or VS Code's UI font. The sidebar and section views always use the UI font. |
| `workerdeck.statusBar.status` | `true` | The session-status badge in the window status bar. |
| `workerdeck.statusBar.context` | `true` | The context-window badge. Absent anyway for engines that report no context window. |
| `workerdeck.statusBar.usage` | `true` | The plan-usage badge (the fullest rate-limit window). |
| `workerdeck.statusBar.model` | `true` | The model picker. Click → Quick Pick. |
| `workerdeck.statusBar.mode` | `true` | The permission-mode picker. Click → Quick Pick. |
| `workerdeck.dev.autoReload` | `true` | Extension Development Host only: re-render the webviews on rebuild. |

## Develop

```sh
pnpm install               # repo root — apps/vscode is a workspace member
cd apps/vscode
pnpm build                 # esbuild (extension host) + vite (webview) → dist/
# then: File → Open… apps/vscode in VS Code, F5 (Extension Development Host)
```

From a terminal (no F5, no VS Code window needed to start it):

```sh
pnpm dev:host              # build, open an Extension Development Host, keep watching
```

That is the whole loop. The extension watches its own `dist/` **in development mode only**
(`src/dev-reload.ts`) and reacts to each rebuild: a **webview** change re-renders the webviews
in place (instant; the extension host keeps its gateways, selection and sockets), an
**extension-host** change reloads the window — VS Code cannot swap an extension's code in a
live host, so the window is the unit. Turn it off with `workerdeck.dev.autoReload`. The
webview has no dev server on purpose: webview assets must be files on disk.

To run the extension in the window you are *working* in, install it like any other extension:

```sh
pnpm install:local         # package a .vsix and install it into `code`
```

That one needs a manual **Developer: Reload Window** afterwards, and it is a real install —
it shadows nothing, but it also does not hot-reload. Prefer `dev:host` while iterating.

Try it against a local gateway: `pnpm server` at the repo root, then in the dev host add a
gateway (sidebar plug icon → Add gateway; the first one is prefilled with
`http://127.0.0.1:8787`).

## Package

```sh
pnpm package               # → workerdeck.vsix (side-load: Extensions ⋯ → Install from VSIX)
```

## Design

Two surfaces with a hard split (there are no floating custom dialogs in VS Code, so nothing
pretends otherwise):

- **Agent panel** (bottom dock, tabbed as **Agent** beside Terminal) — purely the
  conversation. A click on anything that isn't itself a control puts the caret in the
  composer (`focusComposerOnClick`): a dock is focussed in order to type in it. Expanding a
  tool row, following a path, or ending a text selection stays what it was. `SessionPanel` runs with
  `panelSurface: 'external'`: no dialogs, no `⋯` menu; the composer sits flush to the panel
  edges. Panel-open intents (status-bar clicks, `/mcp`) and live vitals flow OUT to the
  sidebar via the extension host. The transcript runs `transcriptVariant: 'lines'`: vertical
  space is the scarce resource in a dock, so nothing is boxed — every event is one
  full-width, transparent, hover-highlit row behind a fixed gutter glyph (`❯` typed, `●` said
  or called, `✻` thought, `⎿` the collapsed first line of a tool's output), everything
  left-aligned on one column. The panel's typeface follows `workerdeck.fontFamily`, which
  defaults to the **editor font** — monospace, so it reads as part of the editor rather than
  as a web app docked beside it. **Model and permission mode are not in the composer**: they
  live in the window status bar, where a click opens a Quick Pick — a `StatusBarItem` carries
  one command and no dropdown, so command → Quick Pick is the native shape (it is what the
  language-mode and encoding items do). The composer is then a single line that grows with the
  message, attach and send beside the field. Both the transcript variant and the controls seam
  (`controlsSurface`, `onControls`) are `@workerdeck/ui` props, not local CSS: vitals carry the
  *options* out, `onControls` carries the setters back in, and no second attach is involved.
  Returning to a session that moved on without you opens in **catch-up**: a `※ recap:` row at
  the boundary counting what happened (turns, tool calls and their names, files, errors,
  approvals waiting — counted from the transcript, never written by the model), everything
  above it dimmed, and a bar offering `jump` or `dismiss`. Sending a message dismisses it too.
- **WorkerDeck views** — management and switching, split across both sidebars and with no
  activity-bar container of its own. **Sessions** sits in **Explorer** beside the file tree;
  the other five sit in a **`secondarySidebar` container titled "WorkerDeck"**, one tab
  stacked vertically: Usage → Context → MCP Servers → Session Info → Gateways. The four detail
  views are `when`-gated on `workerdeck.hasSession` — they are *about the session you have
  open*, Outline and Timeline's shape — so they do not exist at all with no session on screen.
  The secondary-sidebar contribution point is why `engines.vscode` is `^1.106.0` (finalized
  there; the schema is `additionalProperties: false`, so an older build drops the key and the
  views vanish). A contributed location is only a default: any view drags to either sidebar or
  the panel, and `contextualTitle` names the container it lands in. Note VS Code cannot order
  an extension view against a built-in one, so Sessions appears *under* the file tree until
  you drag it up, and a stored `views.customizations` beats any new default — **View: Reset
  View Locations** is how you get back to the shipped layout. **Unread lives in the window status bar** (`$(bell) N`,
  `workerdeck.statusBar.unread`): the **total new rows across the sessions the list is
  showing** — the webview mirrors its filter to the extension host (`wd-view-config`, one-way:
  the webview owns it, the host only counts with it), so it never announces work in a session
  the filter or the workspace scope is hiding. It is not a view badge, and that is the point:
  VS Code aggregates a view badge onto its *container's* icon, which here would be Explorer's,
  beside a user's files. Because it is the extension's only always-visible signal, the sessions
  poll runs while it is enabled even with every WorkerDeck view closed; turning the setting off
  releases that watcher. The rules themselves live in `@workerdeck/protocol`
  (`session-list.ts`) — the dashboard renders the same list and iOS mirrors it in Swift —
  and `src/view-config.ts` re-exports them beside the one thing that is ours, turning the
  bridge state into rows. Sessions waiting on a human lead its tooltip and turn it amber, since
  they are the more urgent thing without being the bigger number. The **Sessions** view lists **every
  gateway's sessions at once**: the gateway is a facet, not the frame the list lives in.
  Above the list, the Extensions view's shape: a **search box that is always there** and a
  **funnel** beside it holding the facets — scope/gateway/adapter/state dropdowns plus group
  and sort, laid out label left, control right. Multi-select with nothing chosen means
  "all", and the funnel wears a dot while any facet is hiding rows (the list is scoped by
  default, so the control that explains a short list must not itself be hidden). The row
  lives inside the webview because VS Code's own search/filter row is workbench chrome — a
  view title can contribute commands, never an input. State persists across reloads in
  webview state. The view-title icons are New Session and the
  **Gateways** screen, the only place a gateway is viewed, added, edited or removed. The
  window's **open folders are a facet too, and the only one on by default** — a session counts
  as inside a folder only where its gateway could be (a real folder scopes loopback gateways;
  a `workerdeck://` mount scopes its own), and because it hides without being asked, the scope
  and a one-click "show all" sit above the list rather than behind the icon. Session
  cards are rich — the title starts at the left edge with the second line under it (engine
  mark, friendly model name, folder, turns, cost), and everything status-ish rides the right:
  unread badge (transcript rows since you last had the session on screen), age, state icon (spinner
  while working, ringing bell when a human is needed, moon when idle) last of all. Stop and
  Delete are hover icons at the right of the second line — off the line you read, and away
  from the state icon; Delete confirms in a native modal, so the icon is a request rather
  than the deed. **Double-click the name** to rename in place: a rename is a
  `PATCH /sessions/:id` on the gateway, so the dashboard and the phone see the same name, and
  clearing it restores the derived title. New Session and the gateway form are
  **pushed screens** with a back arrow. New Session is also the **resume** picker where the
  engine has a browsable store: it lists what is on disk for that directory and profile, and
  picking one continues that engine session instead of starting a fresh one. There is no implicit localhost gateway: an
  unconfigured install shows an empty list with an add affordance rather than a phantom
  entry that is usually unreachable. The scoped surfaces —
  **Session Info / Context / Usage / MCP Servers** — are each their **own VS Code view**
  (one shared bundle, the provider stamps which section a view is), so collapse, reorder,
  and drag-to-anywhere are native. All four are **always present** and start collapsed
  (`visibility: "collapsed"`): views that came and went on `when` clauses changed the
  sidebar's shape under the pointer every time a session was selected. A view can't be
  disabled or collapsed through the API, so an inert one says so the two ways that exist —
  the header's description (`no session`, `not reported`) and an empty state in its body.
  Context and Usage render from vitals the panel relays — the
  panel holds the one live attach; no sidebar surface ever attaches. Everything on this side
  renders in **VS Code's UI font** (`--vscode-font-family`) — it is workbench UI, and the
  panel's monospace setting deliberately does not reach it.

Vendor marks come from `@workerdeck/ui`'s `EngineIcon` (it moved out of this app once the
dashboard needed the same glyphs) — single-path `currentColor` SVGs inlined
from [`@lobehub/icons-static-svg`](https://lobehub.com/icons) (MIT) — the React package pulls
antd and a whole UI kit, which is not a trade worth making for a few 12px glyphs. Claude and
codex are named by engine; a `provider` session is identified from its model id (gemini,
deepseek, moonshot/kimi, gpt/o1/o3), and falls back to no mark rather than a wrong one.

## Layout

- `src/` — extension host (Node): `extension.ts` activation/commands, `hosts.ts` the gateway
  store (URL normalization is `@workerdeck/client`'s `apiUrl`/`isLoopbackHost`),
  `sessions-model.ts` the poll model, `sidebar.ts` +
  `panel.ts` the two webview providers, `webview-transports.ts` the shared bridge host side,
  `fsp.ts` the virtual filesystem, `gateway.ts` host-side clients, `watermarks.ts` the
  `globalState` backing for protocol's unread model, `bridge-protocol.ts` the postMessage wire
  (shared with the webviews, type-only) and `view-config.ts` the list's rows.
  The filter/group/sort rules and the unread arithmetic are protocol's now
  (`session-list.ts`, `watermarks.ts`) but still *executed* on both sides here — the webview
  renders the list with them, the host counts the badge with them.
- `webview/` — browser side: `bridge.ts` transport shims (shared), `App.tsx` the agent
  panel, `sidebar/` the sidebar app (cards, sections, push screens), `forms/` the two
  forms, `theme.ts` VS Code→`data-theme` mapping, `styles.css` Tailwind over the ui
  package's source styles plus the VS Code token skin.

Rules that bind this app: it imports `client`/`react`/`ui`/`protocol` only — never
`core`/`server` — and session-surface features belong in `ui`/`react` so every embedder gets
them; the extension adds only VS Code glue (per the repo-wide rule in the root CLAUDE.md).
