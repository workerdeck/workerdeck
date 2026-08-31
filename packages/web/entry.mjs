// The package entry is a *path*, not a component tree: this is a built
// application, not a library. Hand-written rather than bundled — there is
// nothing here worth a build step, and keeping it out of vite's graph means the
// published entry can never drift from the published dist.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the built dashboard — `index.html` plus content-hashed assets. Mount it at a
 * **domain root** (the build sets no `base`) and serve the gateway on the **same origin** under
 * `/v1`; routing is hash history, so no rewrite rules are needed. Serve hashed assets `immutable`
 * and `index.html` `no-cache`. The `workerdeck` package already does all of this.
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
