#!/usr/bin/env node
/**
 * Regenerate the engine-mark imagesets from `packages/ui`'s `EngineIcon.tsx`.
 *
 * The marks are single-path, `fill="currentColor"` SVGs — the web draws them
 * inline from a `PATHS` table, and iOS cannot: SwiftUI has no path-data parser,
 * so the phone needs real vector assets in the catalog. Generated rather than
 * copied so the two can never drift into two different silhouettes, and checked
 * in rather than built, because the asset catalog is compiled by Xcode and there
 * is no node in that build.
 *
 * Rendered as *template* images so `.foregroundStyle` tints them — the vendor
 * colour is the row's to apply (see `VendorPalette`), exactly as the web passes
 * `vendorMarkClass` into `EngineIcon`.
 *
 * Run: `node apps/ios/scripts/gen-engine-marks.mjs` (from the repo root).
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const src = readFileSync(join(root, 'packages/ui/src/components/agent/EngineIcon.tsx'), 'utf8')

const table = src.slice(src.indexOf('const PATHS'), src.indexOf('\n}\n', src.indexOf('const PATHS')))
const marks = [...table.matchAll(/(\w+): \{\s*title: '([^']+)',\s*d: '([^']+)',/g)].map(([, key, title, d]) => ({ key, title, d }))
if (marks.length === 0) {
  throw new Error('no marks parsed — did PATHS change shape?')
}

const catalog = join(root, 'apps/ios/App/Assets.xcassets')
for (const { key, title, d } of marks) {
  const name = `Engine${key[0].toUpperCase()}${key.slice(1)}`
  const dir = join(catalog, `${name}.imageset`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${key}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill-rule="evenodd" clip-rule="evenodd">\n  <title>${title}</title>\n  <path d="${d}"/>\n</svg>\n`,
  )
  writeFileSync(
    join(dir, 'Contents.json'),
    `${JSON.stringify(
      {
        images: [{ filename: `${key}.svg`, idiom: 'universal' }],
        info: { author: 'xcode', version: 1 },
        properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' },
      },
      null,
      2,
    )}\n`,
  )
  console.log(`${name}.imageset`)
}
