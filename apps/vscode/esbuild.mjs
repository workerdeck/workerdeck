// Extension-host bundle. The webview bundle is Vite's job (vite.config.ts) —
// this one is Node-side only: TreeView, FSP, the bridge's real fetch/ws.
import esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  // .cjs, explicitly: the package is `"type": "module"` (so its .ts sources are
  // ESM to every Node-side tool), but VS Code loads extension mains as CJS.
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  // VS Code 1.90 ships Node 18; the extension host loads CJS.
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  // Resolve workspace deps to their TS source, same as every dev entry in the
  // repo — dev never builds packages.
  conditions: ['@workerdeck/source'],
  external: [
    'vscode',
    // Optional native accelerators `ws` requires in a try/catch. Left external
    // so esbuild doesn't fail the resolve; absent at runtime, ws falls back to JS.
    'bufferutil',
    'utf-8-validate',
  ],
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
