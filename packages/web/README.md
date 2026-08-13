# @workerdeck/web

The [WorkerDeck](https://github.com/workerdeck/workerdeck) dashboard, **prebuilt**:
session list, create/resume flow, live session runner (streaming transcript, approve/deny with a
reason, attachments, `@file` and `/command` completion, and panels for session info, context, plan
usage, MCP servers and the project tree), jobs, profiles, settings. TanStack Router, React 19,
Tailwind v4.

This package ships static files and **no runtime dependencies** — React, the router and the rest
are compiled into `dist/`, not installed by you.

> Most people want [`workerdeck`](https://www.npmjs.com/package/workerdeck) instead:
> `npx workerdeck` serves this dashboard *and* the gateway on one port, already wired — it
> depends on this package to do it. Reach for this one directly when you want to serve the
> dashboard from your own host.

## Serving it

```js
import { dashboardDir } from '@workerdeck/web'
// -> absolute path to a directory containing index.html + assets/
```

```js
import express from 'express'
import { dashboardDir, dashboardIndexHtml } from '@workerdeck/web'

const app = express()
// Hashed filenames — safe to cache forever.
app.use('/assets', express.static(`${dashboardDir}/assets`, { immutable: true, maxAge: '1y' }))
// Hash history: every route is `#/…`, so only the entry document is requested.
app.get('*', (_req, res) => res.sendFile(dashboardIndexHtml, {
  headers: { 'cache-control': 'no-cache' },   // or an update never reaches a warm browser
}))
```

## Three constraints, all baked in at build time

1. **Mount it at a domain root.** The build sets no `base`, so assets resolve from an absolute
   `/assets/...`. Behind a subpath you get a blank page. Mounting elsewhere needs a rebuild.
2. **Serve the gateway on the same origin, under `/v1`.** The app builds its client from
   `location.origin`. This is not just convenience: a browser cannot set headers on a WebSocket
   handshake, so a same-origin cookie is the only credential a tab can present when it attaches to
   a session. Split the origins and you need a proxy that stamps credentials server-side.
3. **No SPA rewrite rules needed** — hash history means the server only ever serves `index.html`.

Cache headers matter: hashed assets `immutable`, `index.html` `no-cache`.

## Building it yourself

The dist is a plain vite build, so a fork can change any of the above:

```bash
git clone https://github.com/workerdeck/workerdeck
cd workerdeck && pnpm install
pnpm --filter @workerdeck/web run build   # -> packages/web/dist
```

`workerdeck` will serve a custom build if you point its config at one (`webRoot`).

MIT

## Rules you cannot infer from the types

- **It must mount at a domain root.** The build sets no Vite `base`, so serving it from a subpath
  produces a page whose assets 404.
- **The entry is a path, not a component.** `dashboardDir` points at prebuilt static files; React,
  the router and Tailwind are compiled into `dist/`, which is why every one of them is a devDep and
  the package has zero runtime dependencies.
- **`primaryClient()` marks what is not yet per-gateway.** Jobs, profiles and the create form's
  pickers all answer from one gateway while the sessions list spans them all — the accessor exists
  to make that visible rather than to hide it.

