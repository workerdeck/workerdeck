import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

export type ClaudeAuthStatus = 'logged_in' | 'logged_out' | 'unknown'

export type ClaudeAuthProbe = (env: Record<string, string | undefined>) => Promise<ClaudeAuthStatus>

export function resolveBundledClaudeExecutable(): string | undefined {
  try {
    // Two hops: the platform package is a dependency of the SDK, not of this one, so under
    // pnpm's strict layout it resolves only from the SDK's own location.
    const fromHere = createRequire(import.meta.url)
    const fromSdk = createRequire(fromHere.resolve('@anthropic-ai/claude-agent-sdk'))
    const suffix = process.platform === 'win32' ? '.exe' : ''
    const platforms =
      process.platform === 'linux' ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`]
    for (const platform of platforms) {
      try {
        const path = fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/claude${suffix}`)
        if (existsSync(path)) {
          return path
        }
      } catch {}
    }
  } catch {}
  return undefined
}

export function checkClaudeAuth(
  env: Record<string, string | undefined>,
  options: { executable?: string; timeoutMs?: number } = {},
): Promise<ClaudeAuthStatus> {
  const executable = options.executable ?? resolveBundledClaudeExecutable()
  if (!executable) {
    return Promise.resolve('unknown')
  }
  return new Promise((resolve) => {
    execFile(
      executable,
      ['auth', 'status'],
      { env: env as NodeJS.ProcessEnv, timeout: options.timeoutMs ?? 10_000 },
      // The exit code is ignored on purpose: 2.1.217 exits 1 on a logged-out verdict where
      // other versions exit 0, so only the parsed `loggedIn` boolean is a verdict.
      (_error, stdout) => {
        try {
          const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
          if (typeof parsed.loggedIn === 'boolean') {
            resolve(parsed.loggedIn ? 'logged_in' : 'logged_out')
            return
          }
        } catch {}
        resolve('unknown')
      },
    )
  })
}
