import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { withoutGatewaySecrets } from '../../lib/child-env.ts'

export const AGY_KEY_FILE = 'gemini-api-key'
export const AGY_TRACE_ENV = 'WORKERDECK_ACP_TRACE'

const INHERITED_CREDENTIALS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY']

export type AgyAuth = { methodId: 'gemini-api-key' } | { methodId: null }

export function resolveAgyExecutable(env: Record<string, string | undefined>, override?: string): string | undefined {
  const candidates = [
    override,
    env.WORKERDECK_AGY_PATH,
    ...(env.PATH ?? '').split(delimiter).map((dir) => (dir ? join(dir, 'agy') : undefined)),
    join(homedir(), '.local', 'bin', 'agy'),
  ]
  return candidates.find((path): path is string => !!path && existsSync(path))
}

export function agyKeyFile(agyHome: string): string {
  return join(agyHome, AGY_KEY_FILE)
}

function readAgyKey(agyHome: string | undefined): string | undefined {
  if (!agyHome) {
    return undefined
  }
  try {
    const key = readFileSync(agyKeyFile(agyHome), 'utf8').trim()
    return key || undefined
  } catch {
    return undefined
  }
}

// An inherited Gemini key is dropped so a profile bills only the key it names; without a key file of its own, the
// profile runs on agy's cached login.
export function agyChildEnv(base: Record<string, string | undefined>, agyHome?: string): { env: Record<string, string>; auth: AgyAuth } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutGatewaySecrets(base))) {
    if (value !== undefined && !INHERITED_CREDENTIALS.includes(key)) {
      env[key] = value
    }
  }
  const key = readAgyKey(agyHome)
  if (key) {
    env.GEMINI_API_KEY = key
    return { env, auth: { methodId: 'gemini-api-key' } }
  }
  return { env, auth: { methodId: null } }
}

// agy resolves `--app-data-dir` under ~/.gemini and refuses an absolute path, so a profile's store is named after
// its home directory.
export function agyArgs(agyHome?: string): string[] {
  const args = ['acp']
  if (agyHome) {
    args.push('--app-data-dir', `antigravity-wd-${basename(agyHome)}`)
  }
  return args
}
