# WorkerDeck for VS Code

The agent rides in the editor: WorkerDeck sessions in the bottom panel (next to Terminal),
gateways and sessions in a left sidebar, and — for remote gateways — the session's project
mounted as a `workerdeck://` virtual workspace folder. The panel is the real
`@workerdeck/ui` `SessionPanel` on a real `@workerdeck/client`, so everything the dashboard's
session surface does (streaming transcript, approvals, composer with attachments and `/` `@`
completion, model/permission switches, capability gating per engine) works here unchanged.

Design + decisions: `_docs/plans/VSCODE-EXTENSION-PRD.md` (local only). Not published to the
Marketplace yet — build the `.vsix` and side-load it.

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

- **Agent panel** (bottom dock) — purely the conversation. `SessionPanel` runs with
  `panelSurface: 'external'`: no dialogs, no `⋯` menu; the composer sits flush to the panel
  edges. Panel-open intents (status-bar clicks, `/mcp`) and live vitals flow OUT to the
  sidebar via the extension host.
- **WorkerDeck sidebar** — management and switching. The **Sessions** view lists **every
  gateway's sessions at once**: the gateway is a facet, not the frame the list lives in. One
  view-title icon toggles the whole view config (search + scope/gateway/adapter/state filters +
  group and sort), which persists across reloads in webview state; a second opens the
  **Gateways** screen, the only place a gateway is viewed, added, edited or removed. The
  window's **open folders are a facet too, and the only one on by default** — a session counts
  as inside a folder only where its gateway could be (a real folder scopes loopback gateways;
  a `workerdeck://` mount scopes its own), and because it hides without being asked, the scope
  and a one-click "show all" sit above the list rather than behind the icon. Session
  cards are rich (spinner while working, ringing bell when a human is needed,
  age/model/folder/turns/cost, a `⋯` menu with Rename/Stop/Delete) and renameable in place —
  a rename is a `PATCH /sessions/:id` on the gateway, so the dashboard and the phone see the
  same name; clearing it restores the derived title. New Session and the gateway form are
  **pushed screens** with a back arrow. New Session is also the **resume** picker where the
  engine has a browsable store: it lists what is on disk for that directory and profile, and
  picking one continues that engine session instead of starting a fresh one. There is no implicit localhost gateway: an
  unconfigured install shows an empty list with an add affordance rather than a phantom
  entry that is usually unreachable. The scoped surfaces —
  **Session Info / Context / Usage / MCP Servers** — are each their **own VS Code view**
  (one shared bundle, the provider stamps which section a view is), so collapse, reorder,
  and drag-to-anywhere are native, and `when`-clause contexts hide a view whose capability
  the selected engine forswears. Context and Usage render from vitals the panel relays — the
  panel holds the one live attach; no sidebar surface ever attaches.

## Layout

- `src/` — extension host (Node): `extension.ts` activation/commands, `hosts.ts` +
  `host-url.ts` gateway store, `sessions-model.ts` the poll model, `sidebar.ts` +
  `panel.ts` the two webview providers, `webview-transports.ts` the shared bridge host side,
  `fsp.ts` the virtual filesystem, `gateway.ts` host-side clients, `bridge-protocol.ts` the
  postMessage wire (shared with the webviews, type-only).
- `webview/` — browser side: `bridge.ts` transport shims (shared), `App.tsx` the agent
  panel, `sidebar/` the sidebar app (cards, sections, push screens), `forms/` the two
  forms, `theme.ts` VS Code→`data-theme` mapping, `styles.css` Tailwind over the ui
  package's source styles plus the VS Code token skin.

Rules that bind this app: it imports `client`/`react`/`ui`/`protocol` only — never
`core`/`server` — and session-surface features belong in `ui`/`react` so every embedder gets
them; the extension adds only VS Code glue (per the repo-wide rule in the root CLAUDE.md).
