import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export type LaunchSpec = {
  command: string
  args: string[]
  // npx may have to fetch the package - and its per-platform engine binaries are hundreds of
  // megabytes - so the first run of that path is minutes, not seconds.
  readyTimeoutMs: number
  viaNpx: boolean
}

const PATH_TIMEOUT_MS = 30_000
const NPX_TIMEOUT_MS = 600_000

const WINDOWS_EXTENSIONS = ['.cmd', '.exe', '.bat', '']

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// VS Code resolves the user's login-shell environment for the extension host, so PATH here is the
// PATH that also has `claude` and `codex` on it - the two binaries the server goes on to spawn.
export function onPath(name: string): string | undefined {
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(dir, `${name}${extension}`)
      if (executable(path)) {
        return path
      }
    }
  }
  return undefined
}

export function resolveLaunch(options: { binaryPath?: string; npxSpec: string; allowNpx: boolean }): LaunchSpec | { error: string } {
  if (options.binaryPath) {
    return executable(options.binaryPath)
      ? { command: options.binaryPath, args: [], readyTimeoutMs: PATH_TIMEOUT_MS, viaNpx: false }
      : { error: `no executable at \`${options.binaryPath}\` (\`workerdeck.host.binaryPath\`)` }
  }
  const installed = onPath('workerdeck')
  if (installed) {
    return { command: installed, args: [], readyTimeoutMs: PATH_TIMEOUT_MS, viaNpx: false }
  }
  if (!options.allowNpx) {
    return { error: 'the `workerdeck` command is not on this machine’s PATH' }
  }
  const npx = onPath('npx')
  if (!npx) {
    return { error: 'neither `workerdeck` nor `npx` is on this machine’s PATH' }
  }
  return { command: npx, args: ['--yes', options.npxSpec], readyTimeoutMs: NPX_TIMEOUT_MS, viaNpx: true }
}
