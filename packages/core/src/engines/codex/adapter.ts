import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ENGINE_CAPABILITIES, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '../adapter.ts'
import { CodexRunner } from './runner.ts'
import { CODEX_CATALOG } from './catalog.ts'
import type { CodexFactory, CodexOptionsLike } from './types.ts'

const NOT_INSTALLED =
  '@openai/codex-sdk is not installed — add it (an optional peer of @workerdeck/core) to run codex profiles'

/**
 * The codex binary the SDK itself would spawn, resolved the way the SDK
 * resolves it (`findCodexPath`): the per-platform package installed next to
 * `@openai/codex`, `vendor/<target-triple>/bin/codex`. Probing this binary
 * rather than whatever `codex` is on PATH means the availability answer is
 * about the executable sessions will actually run. Undefined when it can't be
 * found; callers degrade to 'unknown'.
 */
export function resolveBundledCodexExecutable(): string | undefined {
  const triple = targetTriple()
  if (!triple) return undefined
  try {
    // Three hops on purpose (the claude-auth pattern): the platform package is
    // a dependency of @openai/codex, which is a dependency of the SDK, so
    // under pnpm's strict layout each only resolves from the previous one's
    // location. The first hop is the ESM resolver — the SDK's exports map has
    // no `require` condition for createRequire to use.
    const sdkPath = fileURLToPath(import.meta.resolve('@openai/codex-sdk'))
    const fromSdk = createRequire(sdkPath)
    const fromCodex = createRequire(fromSdk.resolve('@openai/codex/package.json'))
    const platformPackage = fromCodex.resolve(`@openai/codex-${platformPackageSuffix()}/package.json`)
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

/** The real SDK as a {@link CodexFactory}, or null when not installed. */
async function loadCodexFactory(): Promise<CodexFactory | null> {
  try {
    const sdk = (await import('@openai/codex-sdk')) as {
      Codex: new (options: CodexOptionsLike) => unknown
    }
    return (options) => new sdk.Codex(options) as ReturnType<CodexFactory>
  } catch {
    return null
  }
}

/**
 * Availability, mirroring **exec's actual credential chain** — decided in the
 * PRD (§6.4) because the naive probes are each wrong for one supported route:
 * `codex login status` exits 1 under a working CODEX_API_KEY-only setup, and
 * `codex doctor` reports ok under a broken OPENAI_API_KEY-only one.
 *
 * 1. SDK + binary resolvable, else unavailable with the install reason;
 * 2. CODEX_API_KEY present in the session env → available (a presence check
 *    on the *name*; the value is never read into a verdict or a message);
 * 3. else `codex login status` under the profile's complete session env:
 *    exit 0 → available; the "Not logged in" verdict → unavailable; anything
 *    else (a stray CODEX_ACCESS_TOKEN JWT error, a crashed spawn) → 'unknown'
 *    — the checkClaudeAuth never-overclaim discipline.
 *
 * Only the exit code and the fixed verdict line are consulted — never
 * surfaced: `login status` output includes a masked key fragment.
 */
async function checkCodexAvailability(
  profile: ProfileInfo,
  env: Record<string, string | undefined>,
  options: { timeoutMs?: number } = {},
): Promise<EngineAvailability> {
  if (!(await loadCodexFactory())) return { available: false, reason: NOT_INSTALLED }
  const executable = resolveBundledCodexExecutable()
  if (!executable) {
    return {
      available: false,
      reason: '@openai/codex is installed without its platform binary — reinstall with optional dependencies',
    }
  }
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value
  }
  if (profile.codexHome) childEnv.CODEX_HOME = profile.codexHome
  if (childEnv.CODEX_API_KEY) return { available: true }
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
          const hint = childEnv.OPENAI_API_KEY
            ? ' OPENAI_API_KEY alone is not used by codex — set CODEX_API_KEY, or run ' +
              '`codex login --with-api-key` under this profile’s CODEX_HOME.'
            : ''
          resolve({
            available: false,
            reason:
              `codex is not logged in for this profile's environment — run \`codex login\`` +
              (profile.codexHome ? ` with CODEX_HOME=${profile.codexHome}` : '') +
              `, or set CODEX_API_KEY.${hint}`,
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
 * OpenAI Codex as an engine: `@openai/codex-sdk` driving the codex CLI binary
 * — structurally the Claude engine's sibling (a local agent binary with
 * sessions, sandboxing and resume, resolving its own credentials from the
 * operator's environment). The SDK is an **optional peer**: absent, every
 * codex profile reports unavailable and createRunner throws the same message,
 * and no consumer downloads a ~40 MB per-platform binary it never uses.
 */
export const codexAdapter: EngineAdapter = {
  engine: 'codex',
  capabilities: ENGINE_CAPABILITIES.codex,
  catalog: CODEX_CATALOG,
  checkAvailability: (profile, env) => checkCodexAvailability(profile, env),
  async createRunner({ config, profile, restore }) {
    if (restore) throw new Error('the codex engine cannot rebuild a parked session')
    const codexFn = await loadCodexFactory()
    if (!codexFn) throw new Error(NOT_INSTALLED)
    return new CodexRunner({ ...config, codexHome: profile?.codexHome, codexFn })
  },
}
