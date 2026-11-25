import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { withoutGatewaySecrets } from '../../lib/child-env.ts'

export const GEMINI_KEY_FILE = 'gemini-api-key'
export const GEMINI_TRACE_ENV = 'WORKERDECK_ACP_TRACE'

const INHERITED_CREDENTIALS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY']

export type GeminiAuth = { methodId: 'gemini-api-key' } | { methodId: null }

export function resolveAgyExecutable(env: Record<string, string | undefined>, override?: string): string | undefined {
  const candidates = [
    override,
    env.WORKERDECK_AGY_PATH,
    ...(env.PATH ?? '').split(delimiter).map((dir) => (dir ? join(dir, 'agy') : undefined)),
    join(homedir(), '.local', 'bin', 'agy'),
  ]
  return candidates.find((path): path is string => !!path && existsSync(path))
}

export function geminiKeyFile(geminiHome: string): string {
  return join(geminiHome, GEMINI_KEY_FILE)
}

function readGeminiKey(geminiHome: string | undefined): string | undefined {
  if (!geminiHome) {
    return undefined
  }
  try {
    const key = readFileSync(geminiKeyFile(geminiHome), 'utf8').trim()
    return key || undefined
  } catch {
    return undefined
  }
}

// An inherited Gemini key is dropped so a profile bills only the key it names; without a key file of its own, the
// profile runs on agy's cached login.
export function geminiChildEnv(base: Record<string, string | undefined>, geminiHome?: string): { env: Record<string, string>; auth: GeminiAuth } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutGatewaySecrets(base))) {
    if (value !== undefined && !INHERITED_CREDENTIALS.includes(key)) {
      env[key] = value
    }
  }
  const key = readGeminiKey(geminiHome)
  if (key) {
    env.GEMINI_API_KEY = key
    return { env, auth: { methodId: 'gemini-api-key' } }
  }
  return { env, auth: { methodId: null } }
}

// agy resolves `--app-data-dir` under ~/.gemini and refuses an absolute path, so a profile's store is named after
// its home directory.
export function geminiArgs(geminiHome?: string): string[] {
  const args = ['acp']
  if (geminiHome) {
    args.push('--app-data-dir', `antigravity-wd-${basename(geminiHome)}`)
  }
  return args
}
