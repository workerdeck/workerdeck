import { spawn } from 'node:child_process'
import { withoutGatewaySecrets } from '@workerdeck/core'
import { screenText } from './setup-token.ts'

const CODEX_CREDENTIAL_ENV_KEYS: readonly string[] = ['OPENAI_API_KEY', 'CODEX_API_KEY']
const URL_PATTERN = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
const USER_CODE_PATTERN = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/

export type CodexDeviceLoginOptions = {
  executable: string
  env: Record<string, string | undefined>
  codexHome?: string
  cwd?: string
  startTimeoutMs?: number
}

export type CodexDeviceLogin = {
  verificationUrl: string
  userCode: string
  done: Promise<void>
  cancel: () => void
}

export class CodexLoginError extends Error {
  readonly reason: 'no-code' | 'failed' | 'timeout' | 'cancelled'

  constructor(reason: CodexLoginError['reason'], message: string) {
    super(message)
    this.reason = reason
  }
}

export function codexLoginEnv(env: Record<string, string | undefined>, codexHome?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutGatewaySecrets(env))) {
    if (value !== undefined && !CODEX_CREDENTIAL_ENV_KEYS.includes(key)) {
      out[key] = value
    }
  }
  if (codexHome) {
    out.CODEX_HOME = codexHome
  }
  out.BROWSER = 'true'
  out.NO_COLOR = '1'
  return out
}

export function parseDeviceLogin(text: string): { verificationUrl: string; userCode: string } | undefined {
  const plain = screenText(text)
  const verificationUrl = plain.match(URL_PATTERN)?.find((url) => url.includes('/device'))
  const prompt = plain.search(/one-time code/i)
  const userCode = prompt >= 0 ? plain.slice(prompt).match(USER_CODE_PATTERN)?.[0] : undefined
  return verificationUrl && userCode ? { verificationUrl, userCode } : undefined
}

// Runs the official `codex login --device-auth`: codex itself talks to OpenAI and writes its own auth.json under
// CODEX_HOME. This side only relays the link and the one-time code; the output is parsed, never logged or forwarded.
export function startCodexDeviceLogin(options: CodexDeviceLoginOptions): Promise<CodexDeviceLogin> {
  const child = spawn(options.executable, ['login', '--device-auth'], {
    cwd: options.cwd ?? process.cwd(),
    env: codexLoginEnv(options.env, options.codexHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let raw = ''
  let exitCode: number | null | undefined
  let cancelled = false
  let onChange: (() => void) | undefined
  const append = (chunk: Buffer): void => {
    raw += chunk.toString('utf8')
    onChange?.()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('exit', (code) => resolve(code))
  })
  void exited.then((code) => {
    exitCode = code
    onChange?.()
  })
  const cancel = (): void => {
    cancelled = true
    if (exitCode === undefined) {
      child.kill()
    }
  }
  const done = exited.then((code) => {
    if (code === 0) {
      return
    }
    throw cancelled
      ? new CodexLoginError('cancelled', 'the sign-in attempt was cancelled')
      : new CodexLoginError('failed', 'codex login did not complete; start a new sign-in')
  })
  done.catch(() => {})

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onChange = undefined
      cancel()
      reject(new CodexLoginError('timeout', 'codex login did not print a device code in time'))
    }, options.startTimeoutMs ?? 30_000)
    onChange = () => {
      const parsed = parseDeviceLogin(raw)
      if (parsed) {
        clearTimeout(timer)
        onChange = undefined
        resolve({ ...parsed, done, cancel })
      } else if (exitCode !== undefined) {
        clearTimeout(timer)
        onChange = undefined
        reject(new CodexLoginError('no-code', 'codex login exited before printing a device code'))
      }
    }
    onChange()
  })
}

export function codexLogout(options: {
  executable: string
  env: Record<string, string | undefined>
  codexHome?: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(options.executable, ['logout'], { env: codexLoginEnv(options.env, options.codexHome), stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), 15_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}
