# Changelog

All notable changes to the WorkerDeck VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the extension is versioned in lockstep
with the `@workerdeck/*` packages it is built from, so a version here is the same release as the
gateway and protocol it talks to.

## [3.0.0] - 2026-09-25

### Added

- **Images open in a viewer.** A picture a tool returned, an image codex generated or viewed, an
  image you attached, and a markdown image in the agent's reply all draw inline and open a viewer
  over the panel: fit and 1:1, zoom, pinch and ctrl-wheel zoom around the cursor, drag to pan,
  download, and `Esc` to leave. A markdown image may point at a file on the host
  (`![shot](/abs/path.png)`); it loads through the gateway's host-file routes.
- **The agent can use shells.** With `workerdeck.host.shellAgentWrite` it can start, type into and
  kill shells of its own, each keystroke on a permission card, and ask to take over one of yours.
  Grant or revoke that from the shell's row, strip or card.
- **Settings in seven groups**, one `WorkerDeck: Open Settings` command, and a Restart Now offer
  when a setting that reaches the local server's command line changes.

### Changed

- **Row actions live under the row.** Bookmark, copy, shell and sub-agent actions show on hover in
  the blank line below each block; `workerdeck.actionStyle` adds labels beside the icons.

### Removed

- **`workerdeck.transcriptDensity`.** The compact density is gone from every client.

### Fixed

- Typing `$` after backspacing the composer empty enters shell mode again.

## [2.14.0] - 2026-09-23

### Added

- **Shell sessions.** A `$` command the agent runs is a tracked PTY with a record of its own: it
  gets a row on the session card that outlives a `/clear`, a drill-in that replays what came
  before and streams what comes after, and a kill that reaches the whole process tree rather than
  the leader's group alone.

### Fixed

- **A file link to a gateway on this machine opens as a real file.** Only a loopback URL used to
  count as local, so a gateway bound to a LAN or tailnet name - the same Mac, reached by its own
  name - sent every transcript click through the read-only `workerdeck://` mount: a second editor
  for a file the explorer already had open, no Reveal in Finder, no git gutter. The gateway now
  reports an opaque machine fingerprint and the extension compares it with its own, so locality is
  a question about machines rather than about URLs. `Open Session Project Folder` follows the same
  test. A genuinely remote gateway is unchanged.

## [2.12.0] - 2026-09-21

### Changed

- The sub-agent visibility control is a **menu**, not an icon-only cycling button: three labelled
  options with the current one ticked, in the dashboard's labels and order. Three stops is one
  more than a single glyph can report.

### Fixed

- The three sub-agent menu items set the state they name. As a cycling button each command set the
  *next* state, which is right for a button and backwards as a menu - `Hide Completed` was setting
  `Show All`.
- Sessions refresh moved off the title bar and into the overflow.

## [2.10.0] - 2026-09-20

### Added

- Sessions open in **editor tabs** beside the Agent panel: Cmd+click (Ctrl on Windows and
  Linux) a session for a tab in the active column, Option/Alt+click for one to the side. A
  session lives in one surface at a time - opening a tab moves it out of the panel, which shows
  a short info state with a Focus button until the next click; closing the tab hands it back. A
  plain click on a session that has a tab reveals the tab. `Open in Editor Area` (panel title)
  and `Move to Panel` (editor title) switch a session between the two, and both rows sit in the
  session card's `⋯` menu. Tabs survive a window reload, carry the session title and a state
  dot, and the card shows a glyph while its session is in a tab.

### Changed

- The status bar, the secondary-sidebar views, the model and mode pickers, `Use Skill` and
  `Open Session Project Folder` follow the **focused** surface (the last tab or panel you clicked
  into), not only the bottom panel.
- Session cost is priced client-side for every engine (`@workerdeck/protocol`'s rate table), and
  the total survives a park, a dormant wake and a context clear instead of reading `$0.00` after
  a reattach.
- Picking a codex skill inserts codex's own `$name` mention, which the runner expands itself.

## [2.7.1] - 2026-09-16

First release published by CI rather than by hand. No behaviour change - 2.7.0 was uploaded
through the Marketplace's own web form to see the listing before it became automatic, and this
release exercises the tag-driven path that takes over from here.

### Changed

- Dependency refresh across the workspace it is built from (astro, oxlint, oxfmt, and `zod`
  unified on 4 - the extension bundles `@workerdeck/client`, `protocol` and `ui`, so their
  resolutions are its own).

## [2.7.0] - 2026-09-16

First Marketplace release. The extension has shipped as a side-loadable `.vsix` since 0.10.0; this
is the same extension, listed.

### Added

- **Sessions in the bottom panel**, beside Terminal - the real `SessionPanel` on a real client, so
  the streaming transcript, approvals, the composer (attachments, `/` and `@` completion) and the
  model and permission switches all behave as they do in the dashboard.
- **Gateways, Sessions and Profiles views** in the secondary sidebar, created and edited through
  native multi-step inputs rather than a settings file.
- **Host Mode** - the extension supervises a `workerdeck` gateway for you: adopt-or-spawn on the
  port, guard-backed stop and restart, and a tailed Output channel that follows an adopted server
  too.
- **Remote projects as a virtual workspace.** A session on a remote gateway mounts its project at
  `workerdeck://<hostId>/<path>`: reads and lists over the gateway's filesystem routes, and
  hash-guarded conditional writes, so a write that the agent beat you to fails loudly instead of
  overwriting silently.
- **A status-bar badge** reading `X/Y` - gateways answering their probe over gateways configured -
  and the Host Mode action QuickPick behind it.
- **Skills, todos, plan approval and bookmarks**, at parity with the dashboard and the iOS client.

### Security

- The webview never reaches the network. Its client's `fetch` and `WebSocket` are `postMessage`
  shims executed by the extension host, which injects the gateway's bearer token there. Keys live
  in VS Code `SecretStorage`; the webview's CSP has no external `connect-src`, and the bridge
  refuses any URL that does not belong to a registered gateway, so it cannot be used as an open
  proxy.

Earlier history is in the repository's release ledger, `docs/RELEASING.md`.
