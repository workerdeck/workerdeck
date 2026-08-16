import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Credential presence for one Claude Code environment, as the CLI itself reports
 * it. 'unknown' means the check could not run at all (no binary, a CLI too old
 * for `auth status`, unparseable output) — which is NOT evidence of a missing
 * login and must never be surfaced as one.
 */
export type ClaudeAuthStatus = 'logged_in' | 'logged_out' | 'unknown'

/** Injectable form of {@link checkClaudeAuth} (tests, custom probes). */
export type ClaudeAuthProbe = (
  env: Record<string, string | undefined>,
) => Promise<ClaudeAuthStatus>

/**
 * The native Claude Code binary the Agent SDK itself spawns, resolved the way
 * the SDK resolves it: the platform-specific optional dependency installed next
 * to the SDK package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`).
 * Probing this binary rather than whatever `claude` is on PATH means an auth
 * check answers for the executable sessions will actually run — the two can be
 * different versions logged into different places. Returns undefined when it
 * can't be found (optional dep skipped, unsupported platform); callers degrade
 * to 'unknown', and the SDK surfaces its own error if a session is created.
 */
export function resolveBundledClaudeExecutable(): string | undefined {
  try {
    // Two hops on purpose: the platform package is a dependency of the SDK, not
    // of this package, so under pnpm's strict layout it only resolves from the
    // SDK's own location.
    const fromHere = createRequire(import.meta.url)
    const fromSdk = createRequire(fromHere.resolve('@anthropic-ai/claude-agent-sdk'))
    const suffix = process.platform === 'win32' ? '.exe' : ''
    // On linux only the matching libc variant installs (os/cpu/libc on the
    // optional deps), so trying both flavours needs no musl detection.
    const platforms =
      process.platform === 'linux'
        ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
        : [`${process.platform}-${process.arch}`]
    for (const platform of platforms) {
      try {
        const path = fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/claude${suffix}`)
        if (existsSync(path)) return path
      } catch {
        // not installed — try the next candidate
      }
    }
  } catch {
    // the SDK itself doesn't resolve here; nothing to probe
  }
  return undefined
}

/**
 * Ask the CLI whether `env` holds usable credentials: `claude auth status`
 * prints a JSON verdict covering every source the CLI itself consults for that
 * environment — `<CLAUDE_CONFIG_DIR>/.credentials.json`, the macOS login
 * Keychain, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, Bedrock/Vertex
 * (verified against 2.1.217). Only the `loggedIn` boolean is ever read; the
 * identity fields in the payload (email, org, subscription) never leave the
 * parse. The exit code is deliberately ignored — 2.1.217 exits 1 on a
 * logged-out verdict where other versions exit 0 — and anything that doesn't
 * parse to a `loggedIn` boolean is 'unknown', because `auth status` is not a
 * stable contract. Never rejects.
 */
export function checkClaudeAuth(
  env: Record<string, string | undefined>,
  options: { executable?: string; timeoutMs?: number } = {},
): Promise<ClaudeAuthStatus> {
  const executable = options.executable ?? resolveBundledClaudeExecutable()
  if (!executable) return Promise.resolve('unknown')
  return new Promise((resolve) => {
    execFile(
      executable,
      ['auth', 'status'],
      // The timeout kills a hung CLI rather than leaking it; the killed child's
      // partial output then fails the parse below, which is the right verdict.
      { env: env as NodeJS.ProcessEnv, timeout: options.timeoutMs ?? 10_000 },
      (_error, stdout) => {
        try {
          const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
          if (typeof parsed.loggedIn === 'boolean') {
            resolve(parsed.loggedIn ? 'logged_in' : 'logged_out')
            return
          }
        } catch {
          // not this CLI's JSON — fall through
        }
        resolve('unknown')
      },
    )
  })
}
