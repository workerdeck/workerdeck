// The package entry is a *path*, not a component tree: this is a built
// application, not a library. Hand-written rather than bundled — there is
// nothing here worth a build step, and keeping it out of vite's graph means the
// published entry can never drift from the published dist.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the built dashboard — an `index.html` plus content-hashed
 * assets, ready to serve.
 *
 * Two constraints come with it, both baked in at build time:
 *
 * 1. **Mount it at a domain root.** `vite.config.ts` sets no `base`, so assets
 *    resolve from an absolute `/assets/...`. A subpath mount serves a blank page.
 * 2. **Serve the gateway on the same origin, under `/v1`.** The app builds its
 *    client from `location.origin`, and same-origin is also what lets a browser
 *    authenticate the session WebSocket at all — a tab cannot put a header on an
 *    upgrade, so a same-origin cookie is its only option.
 *
 * Routing needs no server support: the app uses hash history, so every route is
 * `#/…` and only `index.html` is ever requested. Serve hashed assets immutable
 * and `index.html` with `no-cache`, or a deployed update never reaches a browser
 * that already has the old one.
 *
 * If you just want this served correctly, the `workerdeck` package already
 * does all of the above.
 *
 * @type {string}
 */
export const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), 'dist')

/**
 * Absolute path to the entry document, for hosts that serve it explicitly on
 * every non-asset route.
 *
 * @type {string}
 */
export const dashboardIndexHtml = join(dashboardDir, 'index.html')
