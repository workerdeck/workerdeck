import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ENGINE_CAPABILITIES, type ProfileInfo, type SdkSessionSummary } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '../adapter.ts'
import { CodexRunner } from './runner.ts'
import { CODEX_CATALOG } from './catalog.ts'
import { codexChildEnv, INITIALIZE_PARAMS } from './connect.ts'
import { connectAppServer } from './process.ts'
import type { AppServerConnectFn, AppServerThreadListResponse, AppServerThreadSummary } from './types.ts'

const NOT_INSTALLED = '@openai/codex is not installed — add it (an optional peer of @workerdeck/core) to run codex profiles'

export function resolveBundledCodexExecutable(): string | undefined {
  const triple = targetTriple()
  if (!triple) {
    return undefined
  }
  try {
    // Two hops: the platform package is a dependency of @openai/codex, not of this one, so under
    // pnpm's strict layout it resolves only from @openai/codex's own location.
    const fromHere = createRequire(import.meta.url)
    const wrapper = fromHere.resolve('@openai/codex/package.json')
    const fromWrapper = createRequire(wrapper)
    const platformPackage = fromWrapper.resolve(`@openai/codex-${platformPackageSuffix()}/package.json`)
    const path = platformPackage.replace(/package\.json$/, `vendor/${triple}/bin/codex`)
    if (existsSync(path)) {
      return path
    }
  } catch {}
  return undefined
}

function targetTriple(): string | undefined {
  const { platform, arch } = process
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc'
  }
  return undefined
}

function platformPackageSuffix(): string {
  return `${process.platform}-${process.arch}`
}

async function checkCodexAvailability(
  profile: ProfileInfo,
  env: Record<string, string | undefined>,
  options: { timeoutMs?: number } = {},
): Promise<EngineAvailability> {
  const executable = resolveBundledCodexExecutable()
  if (!executable) {
    return { available: false, reason: NOT_INSTALLED }
  }
  const childEnv = codexChildEnv(env, profile.codexHome)
  return new Promise((resolve) => {
    execFile(executable, ['login', 'status'], { env: childEnv, timeout: options.timeoutMs ?? 10_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ available: true })
        return
      }
      // The verdict line lands on stderr (0.146.0); check both streams so a future move doesn't
      // degrade every verdict to 'unknown'. Neither stream may reach `reason`: the success line
      // carries a masked key fragment.
      if (`${stdout}\n${stderr}`.includes('Not logged in')) {
        // Presence checks on the NAMES only; values are never read.
        const hint = childEnv.CODEX_API_KEY
          ? ' CODEX_API_KEY is read only by `codex exec`, never by the app-server — run ' +
            '`codex login --with-api-key` under this profile’s CODEX_HOME to persist it.'
          : childEnv.OPENAI_API_KEY
            ? ' OPENAI_API_KEY is not used by codex — run `codex login --with-api-key` under this profile’s CODEX_HOME.'
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
    })
  })
}

const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 40

function cwdFilter(dir: string): string[] {
  const forms = new Set([dir])
  try {
    forms.add(realpathSync(dir))
  } catch {}
  return [...forms]
}

function secondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined
}

function summarizeThread(row: AppServerThreadSummary): SdkSessionSummary {
  const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : undefined
  const preview = typeof row.preview === 'string' && row.preview.length > 0 ? row.preview : undefined
  return {
    // The resume handle is the row's `id`; codex's own `sessionId` field is a different value.
    sessionId: row.id,
    summary: name ?? preview ?? row.id,
    lastModified: secondsToMs(row.updatedAt) ?? secondsToMs(row.createdAt) ?? 0,
    createdAt: secondsToMs(row.createdAt),
    customTitle: name,
    firstPrompt: preview,
    gitBranch: typeof row.gitInfo?.branch === 'string' && row.gitInfo.branch.length > 0 ? row.gitInfo.branch : undefined,
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
  }
}

export async function listCodexSessions(options: {
  connectFn: AppServerConnectFn
  profile?: ProfileInfo
  env: Record<string, string | undefined>
  dir?: string
  limit?: number
  offset?: number
}): Promise<SdkSessionSummary[]> {
  const childEnv = codexChildEnv(options.env, options.profile?.codexHome)
  const connection = options.connectFn({ env: childEnv })
  const rows: AppServerThreadSummary[] = []
  try {
    await connection.request('initialize', INITIALIZE_PARAMS)
    connection.notify('initialized')
    const base: Record<string, unknown> = {
      limit: LIST_PAGE_SIZE,
      sortKey: 'updated_at',
      ...(options.dir ? { cwd: cwdFilter(options.dir) } : {}),
    }
    const want = options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = (await connection.request('thread/list', {
        ...base,
        ...(cursor ? { cursor } : {}),
      })) as AppServerThreadListResponse
      const data = Array.isArray(result?.data) ? result.data : []
      rows.push(...data)
      if (want !== undefined && rows.length >= want) {
        break
      }
      if (data.length === 0 || typeof result?.nextCursor !== 'string') {
        break
      }
      cursor = result.nextCursor
    }
  } finally {
    connection.close()
  }
  const summaries = rows
    // An ephemeral thread was never materialized on disk — nothing to resume.
    .filter((row) => typeof row.id === 'string' && row.id.length > 0 && !row.ephemeral)
    .map(summarizeThread)
  const start = options.offset ?? 0
  return options.limit === undefined ? summaries.slice(start) : summaries.slice(start, start + options.limit)
}

export const codexAdapter: EngineAdapter = {
  engine: 'codex',
  capabilities: ENGINE_CAPABILITIES.codex,
  catalog: CODEX_CATALOG,
  checkAvailability: (profile, env) => checkCodexAvailability(profile, env),
  createRunner({ config, profile, restore, id }) {
    if (restore) {
      throw new Error('the codex engine cannot rebuild a parked session')
    }
    const executable = (config as { codexPathOverride?: string }).codexPathOverride ?? resolveBundledCodexExecutable()
    if (!executable) {
      throw new Error(NOT_INSTALLED)
    }
    return new CodexRunner(
      {
        ...config,
        codexHome: profile?.codexHome,
        connectFn: (options) => connectAppServer({ executable, ...options }),
      },
      id,
    )
  },
  async listSessions(options) {
    const executable = resolveBundledCodexExecutable()
    if (!executable) {
      throw new Error(NOT_INSTALLED)
    }
    return listCodexSessions({
      ...options,
      connectFn: (connect) => connectAppServer({ executable, ...connect }),
    })
  },
}
