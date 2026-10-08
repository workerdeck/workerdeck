import { withoutGatewaySecrets } from '@workerdeck/core'
import type { PtyModule } from '../services/shell-types.ts'

export const CREDENTIAL_ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

const COLS = 400
const ROWS = 50
const PASTE_SETTLE_MS = 800
const TOKEN_SETTLE_MS = 1500
const TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]+/g
const URL_PATTERN = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g

export type SetupTokenOptions = {
  pty: PtyModule
  executable: string
  env: Record<string, string | undefined>
  cwd?: string
  urlTimeoutMs?: number
  completeTimeoutMs?: number
  pasteSettleMs?: number
}

export type SetupTokenAttempt = {
  authorizeUrl: string
  complete: (code: string) => Promise<{ token: string }>
  cancel: () => void
}

export class SetupTokenError extends Error {
  readonly reason: 'no-url' | 'rejected' | 'exited' | 'timeout' | 'cancelled'

  constructor(reason: SetupTokenError['reason'], message: string) {
    super(message)
    this.reason = reason
  }
}

export function setupTokenEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutGatewaySecrets(env))) {
    if (value !== undefined && !CREDENTIAL_ENV_KEYS.includes(key)) {
      out[key] = value
    }
  }
  out.BROWSER = 'true'
  out.TERM = 'xterm-256color'
  return out
}

// Cursor moves stand in for the spaces and line breaks the CLI draws, so they become a space rather than nothing.
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?]*m/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b./g, '')
}

export function findAuthorizeUrl(text: string): string | undefined {
  return text.match(URL_PATTERN)?.find((url) => url.includes('/oauth/authorize?'))
}

function squeezed(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function lastToken(text: string): string | undefined {
  return text.match(TOKEN_PATTERN)?.at(-1)
}

export function startClaudeSetupToken(options: SetupTokenOptions): Promise<SetupTokenAttempt> {
  const child = options.pty.spawn(options.executable, ['setup-token'], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: options.cwd ?? process.cwd(),
    env: setupTokenEnv(options.env),
  })
  let raw = ''
  let exited = false
  let onChange: (() => void) | undefined
  child.onData((data) => {
    raw += data
    onChange?.()
  })
  child.onExit(() => {
    exited = true
    onChange?.()
  })
  const kill = (): void => {
    if (!exited) {
      try {
        child.kill()
      } catch {}
    }
  }

  return new Promise((resolve, reject) => {
    const urlTimer = setTimeout(() => {
      onChange = undefined
      kill()
      reject(new SetupTokenError('timeout', 'claude setup-token did not print a sign-in link in time'))
    }, options.urlTimeoutMs ?? 30_000)
    onChange = () => {
      const text = screenText(raw)
      const url = findAuthorizeUrl(text)
      if (url && squeezed(text).includes('pastecodehere')) {
        clearTimeout(urlTimer)
        onChange = undefined
        resolve({ authorizeUrl: url, complete: (code) => complete(code), cancel: kill })
      } else if (exited) {
        clearTimeout(urlTimer)
        onChange = undefined
        reject(new SetupTokenError('no-url', 'claude setup-token exited before printing a sign-in link'))
      }
    }
    onChange()
  })

  function complete(code: string): Promise<{ token: string }> {
    const from = raw.length
    return new Promise((resolve, reject) => {
      if (exited) {
        reject(new SetupTokenError('exited', 'the sign-in attempt has ended; start a new one'))
        return
      }
      let settle: NodeJS.Timeout | undefined
      const finish = (outcome: { token: string } | SetupTokenError): void => {
        clearTimeout(deadline)
        clearTimeout(settle)
        onChange = undefined
        kill()
        if (outcome instanceof SetupTokenError) {
          reject(outcome)
        } else {
          resolve(outcome)
        }
      }
      const deadline = setTimeout(
        () => finish(new SetupTokenError('timeout', 'claude setup-token did not confirm the code in time')),
        options.completeTimeoutMs ?? 60_000,
      )
      onChange = () => {
        const text = screenText(raw.slice(from))
        const token = lastToken(text)
        if (token && (exited || settle === undefined)) {
          if (exited) {
            finish({ token })
          } else {
            settle = setTimeout(() => finish({ token: lastToken(screenText(raw.slice(from))) ?? token }), TOKEN_SETTLE_MS)
          }
          return
        }
        const plain = squeezed(text)
        if (plain.includes('oautherror') || plain.includes('pressentertoretry')) {
          finish(new SetupTokenError('rejected', 'the sign-in code was not accepted; start again and paste the new code'))
        } else if (exited) {
          finish(new SetupTokenError('exited', 'claude setup-token exited without printing a token'))
        }
      }
      // The code and its Enter in one write read as a paste, and the Enter never submits.
      child.write(code.trim())
      setTimeout(() => {
        if (!exited) {
          child.write('\r')
        }
      }, options.pasteSettleMs ?? PASTE_SETTLE_MS)
    })
  }
}
