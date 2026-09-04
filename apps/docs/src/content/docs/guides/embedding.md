---
title: Embedding the UI
description: Point a UI at a gateway — the SessionWorkspace/SessionPanel ladder, the client, and Tailwind wiring.
order: 2
---

## Server side

The host app supplies the authenticator — return a truthy principal to accept, null/undefined to
reject with 401. `createWorkerServer` refuses to start without `authenticate` unless you
explicitly pass `allowUnauthenticated: true` (loopback dev only — never expose that):

```ts
import { createWorkerServer } from '@workerdeck/server'

const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
  allowedCwdRoots: ['/srv/checkouts'],          // clamp where sessions may run
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env } }),
  requireApiKey: true,                          // fail closed on subscription credentials
})
const { port } = await worker.listen(8787)
// worker.server (node:http), worker.registry, worker.queue, worker.close()
```

- `allowedCwdRoots` — session `cwd` must resolve inside one of these roots; strongly recommended.
- `buildRunnerConfig` — map/patch the incoming `CreateSessionRequest` into the runner config:
  inject `env`, tool policy, per-skill constraints. The server trusts its host app, so this hook
  plus your auth is where you clamp what clients may request.

The full options reference lives at [Server](/workerdeck/docs/reference/server/).

## Client side

```ts
import { WorkerDeckClient } from '@workerdeck/client'

const client = new WorkerDeckClient({
  baseUrl: 'http://127.0.0.1:8787/v1', // ws:// URL is derived from it
  headers: { authorization: 'Bearer …' }, // REST auth; use buildWsUrl/cookies for WS auth
})

const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'], // pick up the repo's skills + CLAUDE.md
})

const handle = client.attach(session.id) // auto-reconnects, replays from last seen seq
handle.on('attached', (frame) => console.log('snapshot', frame.session.status))
handle.on('event', (event) => console.log(event.seq, event.type))
```

On reconnect the handle asks the server for events after the last seq it saw, so the stream is
gapless and duplicates are dropped; commands sent while disconnected are buffered and flushed on
reopen. Browsers cannot set WebSocket headers — authenticate the socket with a ticket query
param via `buildWsUrl(sessionId, afterSeq)` or with cookies.

## The UI options ladder

Five levels, from most batteries-included to most raw:

0. **`SessionWorkspace`** (`@workerdeck/ui/workspace`) — a VS Code-shaped layout *around* the
   panel: project tree and fuzzy search on the left, editor tabs above, the agent below, with the
   agent claiming the whole column when nothing is open.
   `<SessionWorkspace client={client} sessionId={session.id} />`. It sits at its own entry point
   and takes **`monaco-editor` as an optional peer dependency**, so a host that only wants the
   panel installs neither. It needs the gateway's
   `hostFiles` routes (without them the rail is absent and you get the panel), and editing
   additionally needs `hostFiles.write`, which is a separate opt-in defaulting to off — the
   editor renders read-only otherwise. Saves are conditional on the hash the tab read, so a
   collision with the agent's own edits is refused and offered as a choice, never a silent
   overwrite. **Vite hosts need `optimizeDeps: { exclude: ['monaco-editor'] }`** — see the
   `@workerdeck/ui` README for why.
1. **`SessionPanel`** (`@workerdeck/ui`) — status bar, streaming transcript, tool-call cards,
   permission prompts, composer. `<SessionPanel client={client} sessionId={session.id} />`.
   Untouched by the workspace and complete on its own; an app with its own file tree wants this.
2. **Headless `useClaudeSession`** (`@workerdeck/react`) — the hook attaches to a session,
   folds the event stream through a pure transcript reducer, and hands back live state plus the
   control surface (send, approve/deny, interrupt, permission mode, model). Bring your own
   rendering.
3. **Raw client stream** — `client.attach(sessionId).on('event', …)` with your own state
   handling; the framework-free reducer (`applyEvent`, `initialTranscriptState`) is exported
   from `@workerdeck/react` if you want it without React.
4. **In-process `SessionRunner`** (`@workerdeck/core`) — no server at all: subscribe to
   events, `sendMessage()`, `resolvePermission()` directly in your Node process.

## Fitting `SessionPanel` to your chrome

The panel is one component for every engine — each affordance is gated on the session's
capability record — and it owns the session's **one** attach. That last part is the rule behind
most of these props: an embedder that subscribed separately would open a second attach, and the
tool bridge only ever asks the *first* attached client, so the second sees nothing. Everything
your chrome needs therefore comes *out* of the panel rather than from a second connection.

Independent seams, each defaulting to the batteries-included behavior:

| Prop | What it moves |
| --- | --- |
| `panelSurface: 'external'` | Hands the dialog surface to you: no dialogs and no `⋯` menu, intents arrive via `onOpenPanel`, and live readings via `onVitals` — which is what lets external chrome render context and usage without a second attach. |
| `statusSurface: 'external'` | Drops the status bar itself, for a host whose chrome already has a status line (VS Code's window bar). It carries the `⋯` menu's only home, so combining it with an internal panel surface needs a **function** `header` to take the menu. |
| `controlsSurface` | `'external'` moves model and permission mode out to your chrome — the *options* ride `SessionVitals` (already filtered by the capability record and the bypass grant) and the setters come back through `onControls`. `'status'` is the same trade for a host with no chrome to put them in: the pickers move into the panel's own status bar, beside the readings they act on. Either way the composer collapses to a single growing line. |
| `readOnly` | No composer and no approval prompts — for a surface that is *about* a run rather than in it (the dashboard's job detail). Absent, not disabled: a greyed-out composer says the session is busy, an absent one says this screen does not drive it. **Not an authorization boundary** — it removes the affordance, the gateway does the enforcing. |
| `transcriptVariant` | `'cards'` (the chat convention) or `'terminal'` — the CLI's own form, every row on a character cell, no boxes anywhere. See [the terminal theme](/workerdeck/docs/guides/terminal-theme/). |
| `terminalMetrics` | Terminal theme only: `{ fontSize, lineHeight }` in **whole pixels**, the character cell. Feeds all three of the panel's terminal surfaces at once (transcript, prompts, composer) so they cannot disagree. |
| `affordances` | Terminal theme only: the hover fill and the hover-revealed copy — the things a real terminal cannot do. `false` for none; each costs no layout, so off is the pure article rather than a degraded mode. |
| `transcriptDensity` | `'comfortable'` (a blank line between rows, what the Claude Code CLI leaves) or `'compact'`. **`cards` only** — a terminal has one line height, which is the premise. |
| `transcriptFont` | `'sans'` or `'mono'` — one attribute on the panel root repointing the font token for that subtree only, so a monospace agent view cannot leak into your sidebars and dialogs. **`cards` only**: the terminal theme is monospace by construction. |
| `midTurnSend` | `'fold'` (the default) sends a message typed mid-turn straight through, and the engine folds it into the running turn — the Claude Code CLI's catch-up behaviour. `'hold'` queues it in the panel and sends it once the turn ends. There is no engine option for this, so it is a client preference: you own the storage, the panel reads the resolved value, and nothing about it travels on the wire. |
| `toolHost` | Options for the panel's own browser tool host, or `false` for none — the escape hatch for a host that wants to run the bridge itself. |

`SessionVitals` carries `connection` precisely so an external bar can obey the panel's own rule: a
session status held over a dropped socket is a stale reading, and the link state has to win the
slot. If you are building a non-React status line, `@workerdeck/ui/format` is a third,
React-free entry with the same formatters and `statusPresentation` / `meterSeverity` rules the
panel uses — so an extension host bundle spells `45.2k` and `2h 10m` identically without pulling
React in.

## Listing sessions

`SessionBrowser` (`@workerdeck/ui`) is the styled sessions list built on the protocol's
[view model](/workerdeck/docs/reference/protocol/#the-shared-view-models): search, the
gateway/adapter/state facets, grouping, the "12 of 30" subset line, unread badges and inline
rename. Use it when you want the dashboard's list without reimplementing the rules — the rules
being the point, since a client that filtered differently would announce work it is hiding.
`SessionList` stays beside it for the plain fixed-set case.

`SessionItem` is the **card itself** — one session, two lines, its sub-agents under them — and it
is exported separately because a host with its own filtering chrome wants the row without the list
around it. That is exactly what the VS Code sidebar does: native controls above, `SessionItem`
below. It takes the selection at both grains (`active` for the session, `activeStepKey` for a
sub-agent it has framed), and routes a press on a **sub-agent** to `onSelectSubagent` and a press on
a **task** to `onRevealStep` — different destinations, because a task has no agent behind it and
framing one shows an empty screen.

## Tailwind v4 wiring for @workerdeck/ui

The package ships **source styles + source classnames** — your app's Tailwind build compiles
them. Three steps:

1. Your Tailwind entry CSS:

```css
@import 'tailwindcss';
@import '@workerdeck/ui/theme.css';
/* Let Tailwind see this package's classnames (node_modules is not scanned by default). */
@source '../node_modules/@workerdeck/ui';
/* streamdown (the markdown renderer) also styles itself with Tailwind classes, split across
 * chunk files — scan its whole dist dir. With npm/yarn it's hoisted to node_modules/streamdown;
 * with pnpm it's nested under this package: */
@source '../node_modules/@workerdeck/ui/node_modules/streamdown/dist';
```

2. Set the theme attribute before first paint (no-flash), e.g. in `index.html`:

```html
<script>
  ;(function () {
    var t = localStorage.getItem('my-app.theme')
    var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  })()
</script>
```

3. Fonts (optional but recommended): the tokens reference Inter + JetBrains Mono with safe
   fallbacks. Import `@fontsource/inter/{400,500,600,700}.css` and
   `@fontsource/jetbrains-mono/{400,500,600}.css` to get the real faces.

Caveats: token names are unprefixed (`--bg`, `--accent`, `--primary`, …) and `theme.css` styles
`body`/focus rings — this wiring is for an app that hands its whole page to WorkerDeck's design
system. **If your app has its own Tailwind build or design system, do not use it — use
[`scoped.css`](#embedding-into-an-app-with-its-own-design-system-scopedcss) below instead.** Dark
mode is driven only by `[data-theme='dark']` on the root element (the Tailwind `dark:` variant is
remapped to it); `prefers-color-scheme` is not consulted at CSS level. Every component takes
`className` and carries `data-slot` attributes for targeted overrides.

## Embedding into an app with its own design system: scoped.css

`theme.css` cannot coexist with a host design system: its raw tokens (`--bg`, `--accent`,
`--radius-md`, …) collide with any app that names tokens the obvious way, and — worse — Tailwind's
`@theme` is global, so both sides map the *same utility names* to *different semantics*
(`bg-accent`, `text-code`, `font-sans`, `rounded-md`). Whichever theme the bundler emits last
silently restyles the other side. No import order fixes that.

For this case the package ships a second, **self-contained** stylesheet:
`@workerdeck/ui/scoped.css`. It is prebuilt from this package's own sources against its own
theme (streamdown included), with every rule — preflight, tokens, utilities, the terminal theme —
rewritten to live under a `.wd-root` scope class. Your app's Tailwind build is not involved and
must stay uninvolved.

```tsx
import '@workerdeck/ui/scoped.css'

<div className='wd-root' style={{ height: '100%' }}>
  <SessionPanel session={session} … />
</div>
```

That is the whole integration:

- **Import `scoped.css` once**, anywhere in your app's entry. It touches nothing outside
  `.wd-root` — no `body`, no `:root`, no `*`, no focus rings, no `svg.lucide` sizing outside the
  wrapper.
- **Wrap the WorkerDeck subtree in one element with the `wd-root` class.** Design tokens and the
  panel's canvas (background, font, text color) land on this element; give it a size (the panel
  is `h-full`).
- **Theme follows your app automatically.** The scoped tokens key off `data-theme='light'|'dark'`
  on *any ancestor* — your existing theme switcher on `<html>` drives the panel with zero extra
  wiring. No attribute anywhere means light. You can also pin one panel independently:
  `<div className='wd-root' data-theme='dark'>`.
- **Popups are handled.** Menus, dialogs, selects and tooltips portal to `document.body`; each
  re-establishes the scope itself (a `display: contents` element carrying `wd-root`), so they are
  fully styled and follow the theme without a portal-container prop.

What **not** to do — each of these re-creates the collision `scoped.css` exists to prevent:

- do not *also* import `@workerdeck/ui/theme.css`;
- do not `@source` this package (or streamdown) into your own Tailwind build;
- do not merge WorkerDeck's `@theme` variables into your theme.

Fonts: same as step 3 above — the scoped tokens reference Inter and JetBrains Mono by family
name with safe fallbacks, so if your app already loads those faces the panel simply uses them;
`scoped.css` itself declares no `@font-face` and fetches nothing.

Known sharp edge: a host stylesheet can still reach *into* the panel with rules of the shape
"element/attribute selector, unlayered or `!important`" (e.g. an unlayered global `a { color: … }`
beats any layered rule of ours). Tailwind-built hosts are safe in practice — their styles live in
layers and their utilities lose to the scoped ones on specificity inside `.wd-root` — but if you
have unlayered global element styles, expect to see them in the panel too.

`theme.css` remains the right choice when WorkerDeck *is* the app's design system (the dashboard,
`apps/embedded`): it is the same tokens without the scope, and your build owns utility generation.

## Customizing the look

Both wiring paths give you the same theming levers — CSS token overrides, `className` props,
`data-slot` selectors, and source imports via the `@workerdeck/source` condition. The full
reference is in [Theming & styling](/workerdeck/docs/guides/theming/).
