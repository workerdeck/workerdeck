# WorkerDeck for VS Code

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/silkweave.workerdeck-vscode?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=silkweave.workerdeck-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/silkweave.workerdeck-vscode)](https://marketplace.visualstudio.com/items?itemName=silkweave.workerdeck-vscode)
[![License](https://img.shields.io/badge/license-MIT-black.svg)](https://github.com/workerdeck/workerdeck/blob/HEAD/LICENSE)

> **Run Claude Code or OpenAI Codex as a session that lives in your editor, and keeps running
> when you close the window.**

The agent sits in the bottom panel where a terminal would be. You watch the transcript stream,
you approve or deny each tool call, and the session itself runs in a server outside VS Code, so
the same session is still there in the next window, in a browser tab, or on your phone.

![WorkerDeck in VS Code](https://github.com/workerdeck/workerdeck/raw/HEAD/apps/vscode/media/hero.png)

## 🎯 Why you might want it

- **No terminal to babysit.** The session is a server-side object, not a process attached to a
  shell you have to leave open.
- **Approve or deny, per tool call.** Nothing touches your checkout until you say so, and the
  tool blocks while it waits.
- **It survives the window.** Close VS Code, reopen it, reattach. The transcript replays and the
  turn is where you left it.
- **Same session, other screens.** A browser tab, an iPhone, another editor. They all attach to
  one ordered event stream and stay in step.
- **Two engines.** Claude Code via the Agent SDK, OpenAI Codex via the codex CLI. Any AI SDK
  provider through a second engine.
- **Remote projects mount as folders.** A gateway on another machine shows up as a
  `workerdeck://` workspace folder you can open files from.
- **Bring your own login.** The extension holds no model credentials. Your agent's own CLI
  resolves its login exactly as it does in your terminal.

## 🚀 Getting started

**1. Install the extension** from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=silkweave.workerdeck-vscode),
or from the command line:

```sh
code --install-extension silkweave.workerdeck-vscode
```

**2. Start a server.** Open the Command Palette and run **WorkerDeck: Start Server**. Host Mode
is off until you ask for it, so the first run offers an **Enable Host Mode** button; click it
and the server comes up. That is all the setup there is.

Behind that button, the extension supervises the published `workerdeck` CLI as a background
process: it uses the binary on your `PATH` if there is one, otherwise it runs it through `npx`.
The first `npx` run downloads a few hundred megabytes and can take several minutes, so it shows
a progress notification.

Already running a gateway somewhere, or want to point at one on another machine? Skip this step
and use the **Gateways** view instead (the plug icon above the Sessions list) to add it by URL
and auth key.

**3. Start a session.** Click **+** above the Sessions list in the Explorer sidebar, pick a
directory and an engine, and type a prompt. The Agent panel opens at the bottom, beside
Terminal.

**Requirements:** VS Code 1.106 or newer, Node 22 or newer, and a logged-in
[Claude Code](https://claude.ai/code) or [Codex](https://developers.openai.com/codex/cli) CLI.

## ✨ What you get

### The Agent panel

The conversation, docked at the bottom next to Terminal, in your editor font. Streaming
transcript, tool calls you can expand, a composer with `@` file references, `/` slash commands
and image paste. Click anywhere that is not a control and the caret lands in the composer.

Want more than one on screen? **Cmd+click** (Ctrl on Windows and Linux) a session in the
sidebar to open it as an editor tab, **Option+click** (Alt) to open it to the side, and arrange
the tabs like any other editors. A single click on a session that has a tab brings that tab
forward; the panel keeps showing whichever session you clicked plainly. **Open in Editor Area**
on the panel and **Move to Panel** on a tab switch a session between the two.

Come back to a session that moved on without you and it opens in **catch-up**: a recap row at
the boundary counting what happened while you were gone (turns, tool calls, files, errors,
approvals waiting), everything above it dimmed, and a bar offering jump or dismiss.

### Approvals

A tool call your permission mode does not already cover becomes a card in the transcript, and
the tool blocks until someone answers. Edits arrive as a diff. VS Code raises a native
notification when a session needs you and the panel is not on screen.

Permission modes range from approving everything by hand to letting the agent run unattended.
Switch modes mid-session from the status bar.

### The status bar

Session state, context window, plan usage for the five-hour and weekly windows, model picker,
permission-mode picker, and an unread count across every session your filter is showing. Click
the model or the mode and you get a Quick Pick. Every badge is a setting, so turn off the ones
you do not want.

### The sidebar views

**Sessions** sits in the Explorer beside your files, and lists every gateway's sessions at once,
with a search box and a funnel holding the facets (gateway, engine, state, plus group and sort).
Session cards carry the engine mark, the model, the folder, turn count and cost, an unread
badge, and the state at a glance. Double-click a name to rename it, and the dashboard and your
phone see the new name too.

Five more views live in the secondary sidebar and describe the session you have open: **Usage**,
**Context**, **MCP Servers**, **Tasks** and **Session Info**. They appear only when a session is
open. Drag any of them to whichever sidebar or panel you prefer.

### Remote gateways

Point the extension at a gateway on another machine and its projects mount as a
`workerdeck://` workspace folder. Files open, edit and save over the gateway, with a conflict
check on write, so you find out if the agent got there first instead of overwriting it. A
Remote SSH window is simpler still: the extension runs on the remote host, where the gateway is
local.

## 💡 How people use it

**Review what the agent wants to do before it does it.**

> Ask for a refactor across a handful of files. Each edit arrives as a diff in the panel with
> Allow and Deny under it. You read the diff, allow the three that are right, deny the one that
> is not, and tell it why in the same breath.

**Start something long, then walk away.**

> Kick off a migration in the morning and close the laptop. The session keeps running on the
> gateway. When it needs an approval your phone gets a push, you answer it from the lock screen,
> and it carries on. Open VS Code that afternoon and the whole transcript replays.

**Work on a repo that is not on this machine.**

> Add your workstation's gateway from a laptop. Its projects appear as workspace folders, you
> start a session in one, and you are reading and editing the real files over the gateway.

**Keep one server for every window.**

> Host Mode probes the port on activation and adopts whatever already answers, so a second VS
> Code window attaches to the first window's server rather than starting its own. The server is
> detached, so closing a window does not kill the sessions another window is watching.

## ⚙️ Settings

Every key is optional. The ones people actually change:

| Setting | Default | What it does |
| --- | --- | --- |
| `workerdeck.host.enabled` | `false` | Let the extension run its own server. **WorkerDeck: Start Server** offers to turn this on for you. |
| `workerdeck.host.autoStart` | `true` | Once Host Mode is on, bring the server up on activation rather than waiting for the command. |
| `workerdeck.host.port` | `8787` | Port the managed server listens on, and the port every window probes. |
| `workerdeck.host.cwdRoots` | `[]` | Confine sessions to these directory trees. |
| `workerdeck.fontFamily` | `editor` | Typeface for the Agent panel: the editor font, or VS Code's UI font. |
| `workerdeck.fontSize` | `0` | Panel font size. `0` follows the editor. |
| `workerdeck.transcriptDensity` | `comfortable` | Row spacing in the transcript. |
| `workerdeck.catchUpMode` | `true` | The recap row when you return to a session that moved on. |
| `workerdeck.newSession.permissionMode` | `remember` | Permission mode for new sessions. `remember` follows your last one. |
| `workerdeck.statusBar.*` | mixed | One toggle per status-bar badge: status, context, session usage, weekly usage, per-model usage, unread, subagents, model, mode. |

Host Mode keys are machine-scoped on purpose, so a cloned repo's `.vscode/settings.json` can
never quietly expose an agent runner on your network. The auth key is generated for you and
kept in VS Code's SecretStorage.

## 🔒 Security

The webview never talks to the network. It runs a client whose transport is a `postMessage`
shim; the extension host performs the actual requests and injects the gateway's
`Authorization` header there. Auth keys live in SecretStorage, which is your OS keychain, and
never enter the webview. The webview's CSP has no external `connect-src`, and the bridge
refuses any URL that does not belong to a registered gateway, so it cannot be used as an open
proxy.

The extension implements no model-provider authentication at all. It never sees your Anthropic
or OpenAI credentials; the official CLI resolves those from your own environment.

## 📚 More

- [Documentation](https://workerdeck.github.io/workerdeck/), including the embedding guide and
  the protocol reference
- [GitHub repository](https://github.com/workerdeck/workerdeck)
- [Report an issue](https://github.com/workerdeck/workerdeck/issues)
- [Extension design notes](https://github.com/workerdeck/workerdeck/blob/HEAD/docs/CLIENTS.md),
  if you want to know why the sidebar is shaped the way it is
- [Building from source](https://github.com/workerdeck/workerdeck/blob/HEAD/docs/DEVELOPMENT.md)

MIT licensed. Self-hosted. No telemetry.
