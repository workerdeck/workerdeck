# Changelog

All notable changes to the WorkerDeck VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the extension is versioned in lockstep
with the `@workerdeck/*` packages it is built from, so a version here is the same release as the
gateway and protocol it talks to.

## [3.6.1] - 2026-10-06

### Added

- **Status line.** Every session shows a short status under its name, like a chat status. Agents
  set it with the new `set_status` tool; set or clear it yourself with *Set status* in the card menu.
  It stays until changed and clears when the conversation resets.
- **Change avatar.** *Change avatar* in an agent's card menu offers candidates to pick from, and an
  agent can give itself a new one with `change_avatar`. New avatars come from three art packs:
  monkeys, dogs and toads.
- **Cards that need you turn orange**: an approval or question waiting, on the card itself or on a
  lead whose team member is waiting.
- **Custom groups** get a colour badge, or an image you choose from disk, and keep the case you type.

### Changed

- An agent card shows the model first, then the status; the time sits dimmed beside the name.
- Less space between groups.

### Fixed

- An agent card no longer repeats its name on the second line.

## [3.5.0] - 2026-10-06

### Added

- **Agents and teams.** *New Agent* (the person icon in the Sessions title) starts a named,
  long-lived agent with an avatar and a standing brief; *Make agent* turns a session into one.
  Agents keep their identity across restarts, and *New conversation* starts them fresh.
- **Teams.** Drag an agent onto another to join its team (or use *Add to team* in the card menu);
  drag a member out to leave. Members sit under their lead, and a folded team shows its members'
  avatars and status on the lead's line. One level deep: a lead cannot join another team.
- An agent's editor tab shows its avatar, and a member's tab names its team.
- **`workerdeck.host.agentSleepAfterMinutes`** (default 15, 0 never) puts idle agents to sleep.
- `#` mentions find agents by their name.

## [3.4.0] - 2026-10-06

### Added

- **Reasoning effort.** The status bar shows the session's effort level; click it (or run *Select
  Reasoning Effort*, or type `/effort`) to change it. `workerdeck.host.effortDefaults` sets a
  default per model.
- **Sleep.** *Sleep Session* stops an idle session's engine to free its memory; the next message
  wakes it with its history intact. `workerdeck.host.engineSleepAfterMinutes` puts unwatched idle
  sessions to sleep on their own (0, the default, never does).
- **Agents can reset their own context** between turns with a reason you see in the transcript,
  rate limited. Governed by `workerdeck.host.agentContextReset`.
- **Live tool rows.** A running command shows its elapsed time and the tail of its output. On
  claude, a running Bash call or sub-agent can be moved to the background, and after five seconds
  the composer offers ⌥↵ to send a message now and background the command.
- **`#` mentions across gateways** in the composer, when a relay is running.
- **`workerdeck.host.name`** names the integrated gateway; group headers show gateway and project
  apart.
- Every agent can call `session_info` to read its own context use, cost and rate limits.

### Fixed

- Hover actions on a transcript row stay reachable.
- A peer message no longer shows as raw XML after a session is resumed.

## [3.3.0] - 2026-09-29

### Added

- **Custom session groups.** Group the sidebar by *Custom*, add groups with *New group*, drag
  sessions between them, drag a heading to reorder, double-click to rename. They are kept per
  client, in the extension's own storage.
- **A `+` on every project heading** starts a new session on that gateway, in that project's
  folder, skipping the folder step.
- **Agents on your other gateways.** With a `workerdeck relay` running, sessions on other gateways
  appear to your agents' peer tools as `gateway:session`, and a message from one shows its sender
  as `Name@gateway`.

### Changed

- **Grouping by gateway merged into grouping by project.** Project groups were always per gateway;
  with more than one gateway a heading now reads `mac-mini WorkerDeck`. A stored gateway grouping
  opens as project grouping.

## [3.2.0] - 2026-09-29

### Added

- **Sonnet 5.5** is the model behind `sonnet`, and Sonnet 5 stays selectable beside it.
- **GPT-6 Sol and GPT-6 Luna** for codex sessions. GPT-5.2, which codex no longer offers, is gone
  from the picker.
- **Every older Claude model the CLI offers** (down to Opus 4.6 and Sonnet 4.6) is in the model
  picker before a session starts, not only after.

### Changed

- **The Claude model picker reads the CLI's own names and descriptions**, and its values follow
  the CLI's current aliases (`opus` rather than `opus[1m]`).
- **Cost estimates price Sonnet 5.5, GPT-6 Sol and GPT-6 Luna** at their list rates.

### Fixed

- **Haiku no longer offers an effort setting** it does not support.

## [3.1.0] - 2026-09-27

### Changed

- **`workerdeck.newSession.permissionMode` is read from user settings only.** A workspace's
  `.vscode/settings.json` can no longer pick a mode such as `bypassPermissions` for you.
- **The Sessions sidebar is the same list as the dashboard's**, built on the shared session
  browser: selection, cmd/alt-click, rename, grouping and empty states now behave identically in
  both.
- **Remote markdown images are click-to-load**, and the webview's image sources are narrowed to
  the extension itself and gateways on loopback.
- **Agents and shells no longer see `WORKERDECK_AUTH_KEY`**: the gateway strips its own key from
  every engine child and shell it starts.

### Fixed

- **A sleeping session can be renamed** without waking it; renaming one used to fail.
- **A woken session keeps its generated title.** A session saved before its title arrived could
  come back named after its truncated first prompt, for good.

## [3.0.1] - 2026-09-25

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
