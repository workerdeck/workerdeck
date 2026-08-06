import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ENGINE_CAPABILITIES, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '../adapter.ts'
import { CodexRunner } from './runner.ts'
import { CODEX_CATALOG } from './catalog.ts'
import { connectAppServer } from './process.ts'

const NOT_INSTALLED =
  '@openai/codex is not installed — add it (an optional peer of @workerdeck/core) to run codex profiles'

/**
 * The codex binary sessions will run: the per-platform package installed next
 * to `@openai/codex`, `vendor/<target-triple>/bin/codex` — the same file the
 * npm wrapper's own `bin/codex.js` launcher execs. Probing this binary rather
 * than whatever `codex` is on PATH means the availability answer is about the
 * executable sessions will actually run. Undefined when it can't be found;
 * callers degrade to 'unknown'.
 */
export function resolveBundledCodexExecutable(): string | undefined {
  const triple = targetTriple()
  if (!triple) return undefined
  try {
    // Two hops on purpose (the claude-auth pattern): the platform package is a
    // dependency of @openai/codex, so under pnpm's strict layout it only
    // resolves from @openai/codex's own location, never from ours. Plain
    // createRequire throughout — neither package has an exports map.
    const fromHere = createRequire(import.meta.url)
    const wrapper = fromHere.resolve('@openai/codex/package.json')
    const fromWrapper = createRequire(wrapper)
    const platformPackage = fromWrapper.resolve(`@openai/codex-${platformPackageSuffix()}/package.json`)
    const path = platformPackage.replace(/package\.json$/, `vendor/${triple}/bin/codex`)
    if (existsSync(path)) return path
  } catch {
    // not installed — nothing to probe
  }
  return undefined
}

function targetTriple(): string | undefined {
  const { platform, arch } = process
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  }
  if (platform === 'win32') return 'x86_64-pc-windows-msvc'
  return undefined
}

function platformPackageSuffix(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * Availability, mirroring **the app-server surface's actual credential chain**
 * (verified 2026-08-05 against 0.146.0 by driving the raw binary): auth comes
 * solely from the CODEX_HOME auth store (`codex login`, file or keyring). The
 * env-key routes are dead ends here — `CODEX_API_KEY` is read only by
 * `codex exec` (a turn goes out with no credential at all: "Missing bearer"),
 * and `OPENAI_API_KEY` was never read by either surface. So, in order:
 *
 * 1. Binary resolvable, else unavailable with the install reason;
 * 2. `codex login status` under the profile's complete session env:
 *    exit 0 → available; the "Not logged in" verdict → unavailable, with an
 *    exact remedy when a stranded env key explains the misconfiguration;
 *    anything else (a stray CODEX_ACCESS_TOKEN JWT error, a crashed spawn) →
 *    'unknown' — the checkClaudeAuth never-overclaim discipline.
 *
 * Only the exit code and the fixed verdict line are consulted — never
 * surfaced: `login status` output includes a masked key fragment. The
 * `smoke:codex --canary` run is the drift alarm for all of this.
 */
async function checkCodexAvailability(
  profile: ProfileInfo,
  env: Record<string, string | undefined>,
  options: { timeoutMs?: number } = {},
): Promise<EngineAvailability> {
  const executable = resolveBundledCodexExecutable()
  if (!executable) return { available: false, reason: NOT_INSTALLED }
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value
  }
  if (profile.codexHome) childEnv.CODEX_HOME = profile.codexHome
  return new Promise((resolve) => {
    execFile(
      executable,
      ['login', 'status'],
      { env: childEnv, timeout: options.timeoutMs ?? 10_000 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ available: true })
          return
        }
        // The verdict line lands on stderr (0.146.0); check both streams so a
        // future move doesn't silently degrade every verdict to 'unknown'.
        if (`${stdout}\n${stderr}`.includes('Not logged in')) {
          // Presence checks on the NAMES only; values are never read.
          const hint = childEnv.CODEX_API_KEY
            ? ' CODEX_API_KEY is read only by `codex exec`, never by the app-server — run ' +
              '`codex login --with-api-key` under this profile’s CODEX_HOME to persist it.'
            : childEnv.OPENAI_API_KEY
              ? ' OPENAI_API_KEY is not used by codex — run `codex login --with-api-key` ' +
                'under this profile’s CODEX_HOME.'
              : ''
          resolve({
            available: false,
            reason:
              `codex is not logged in for this profile's environment — run \`codex login\`` +
              (profile.codexHome ? ` with CODEX_HOME=${profile.codexHome}` : '') +
              `.${hint}`,
          })
          return
        }
        // An errored probe (not a verdict) is not evidence of a missing login.
        resolve({ available: 'unknown' })
      },
    )
  })
}

/**
 * OpenAI Codex as an engine: the codex CLI binary driven over its `app-server`
 * JSON-RPC surface — structurally the Claude engine's sibling (a local agent
 * binary with sessions, sandboxing and resume, resolving its own credentials
 * from the operator's environment). `@openai/codex` — the npm package that
 * carries the binary — is an **optional peer**: absent, every codex profile
 * reports unavailable and createRunner throws the same message, and no
 * consumer downloads a ~40 MB per-platform binary it never uses.
 */
export const codexAdapter: EngineAdapter = {
  engine: 'codex',
  capabilities: ENGINE_CAPABILITIES.codex,
  catalog: CODEX_CATALOG,
  checkAvailability: (profile, env) => checkCodexAvailability(profile, env),
  createRunner({ config, profile, restore }) {
    if (restore) throw new Error('the codex engine cannot rebuild a parked session')
    const executable =
      (config as { codexPathOverride?: string }).codexPathOverride ??
      resolveBundledCodexExecutable()
    if (!executable) throw new Error(NOT_INSTALLED)
    return new CodexRunner({
      ...config,
      codexHome: profile?.codexHome,
      connectFn: (options) => connectAppServer({ executable, ...options }),
    })
  },
}
