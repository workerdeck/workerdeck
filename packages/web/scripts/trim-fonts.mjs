// Post-build: drop the legacy .woff font files.
//
// @fontsource ships every face as both .woff2 and .woff, and vite copies both
// into dist/. The generated @font-face lists woff2 first, so on any browser that
// can run this dashboard (React 19, ES2022, WebAssembly) the .woff files are
// never requested — they are ~700 KB of download that exists only for browsers
// that could not render the app anyway.
//
// Done here rather than in the consumer so the published package and every
// embedding of it agree on one payload.
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

let removed = 0
let bytes = 0
for (const entry of await readdir(dist, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.woff')) {
    continue
  }
  const path = join(entry.parentPath, entry.name)
  bytes += (await stat(path)).size
  await rm(path)
  removed += 1
}

console.log(
  removed === 0 ? '[web] no legacy .woff files to trim' : `[web] trimmed ${removed} legacy .woff files (${Math.round(bytes / 1024)} KB)`,
)
