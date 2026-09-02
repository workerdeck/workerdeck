#!/usr/bin/env node
// The terminal dev loop: build once, open an Extension Development Host on this extension, and
// keep rebuilding into `dist/` while it runs — `src/dev-reload.ts` picks the rebuild up.
//
//   node scripts/dev-host.mjs [folder-to-open]   # defaults to the repo root
//
// `pnpm install:local` is a different thing: it packages a .vsix into the editor you are reading
// this in, and needs a manual "Developer: Reload Window".
import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(extensionDir, '..', '..')
const target = resolve(process.argv[2] ?? repoRoot)

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: extensionDir, ...opts })
}

if (run('pnpm', ['run', 'build']).status !== 0) {
  console.error('build failed — not launching')
  process.exit(1)
}

const code = spawnSync('code', ['--version'], { stdio: 'ignore' })
if (code.status !== 0) {
  console.error("the `code` CLI is not on PATH — in VS Code run: Shell Command: Install 'code' command in PATH")
  process.exit(1)
}

console.log(`launching an Extension Development Host on ${target}`)
spawn('code', [`--extensionDevelopmentPath=${extensionDir}`, '--new-window', target], {
  stdio: 'inherit',
  detached: true,
}).unref()

console.log('watching for changes — edit and the dev host reloads itself (ctrl-c to stop)')
spawn('pnpm', ['run', 'dev'], { stdio: 'inherit', cwd: extensionDir })
