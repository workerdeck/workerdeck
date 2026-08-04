# @workerdeck/web

The [WorkerDeck](https://github.com/tobiasstrebitzer/workerdeck) dashboard, **prebuilt**:
session list, create/resume flow, live transcript panel with approve/deny controls, jobs, profiles,
settings. TanStack Router, React 19, Tailwind v4.

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
git clone https://github.com/tobiasstrebitzer/workerdeck
cd workerdeck && pnpm install
pnpm --filter @workerdeck/web run build   # -> packages/web/dist
```

`workerdeck` will serve a custom build if you point its config at one (`webRoot`).

MIT
