---
title: Embedding
description: Host WorkerDeck in your own app, from the styled SessionPanel down to an in-process SessionRunner.
order: 1
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

Four levels, from most batteries-included to most raw:

1. **`SessionPanel`** (`@workerdeck/ui`) — status bar, streaming transcript, tool-call cards,
   permission prompts, composer. `<SessionPanel client={client} sessionId={session.id} />`.
2. **Headless `useClaudeSession`** (`@workerdeck/react`) — the hook attaches to a session,
   folds the event stream through a pure transcript reducer, and hands back live state plus the
   control surface (send, approve/deny, interrupt, permission mode, model). Bring your own
   rendering.
3. **Raw client stream** — `client.attach(sessionId).on('event', …)` with your own state
   handling; the framework-free reducer (`applyEvent`, `initialTranscriptState`) is exported
   from `@workerdeck/react` if you want it without React.
4. **In-process `SessionRunner`** (`@workerdeck/core`) — no server at all: subscribe to
   events, `sendMessage()`, `resolvePermission()` directly in your Node process.

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
`body`/focus rings — embedding into an app with its own conflicting design system may need
scoping. Dark mode is driven only by `[data-theme='dark']` on the root element (the Tailwind
`dark:` variant is remapped to it); `prefers-color-scheme` is not consulted at CSS level. Every
component takes `className` and carries `data-slot` attributes for targeted overrides.
