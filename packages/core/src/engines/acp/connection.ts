import { spawn } from 'node:child_process'
import { JsonRpcStdioConnection } from '../../lib/jsonrpc-stdio.ts'
import type { AcpConnection } from './types.ts'

const STDERR_TAIL_BYTES = 4096

export type AcpSpawnOptions = {
  executable: string
  args: readonly string[]
  env: Record<string, string>
  cwd: string
  label: string
  traceEnv?: string
}

const SECRET_METHODS = new Set(['authenticate', 'logout'])

export function connectAcpAgent(options: AcpSpawnOptions): AcpConnection {
  const child = spawn(options.executable, [...options.args], { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const rpc = new JsonRpcStdioConnection({
    input: child.stdout,
    output: child.stdin,
    label: options.label,
    envelope: 'jsonrpc2',
    traceEnv: options.traceEnv,
    traceSkip: (method) => SECRET_METHODS.has(method) || method.startsWith('auth/'),
  })
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })
  let closeHandler: ((message: string) => void) | undefined
  let done = false
  const settle = (message: string) => {
    if (done) {
      return
    }
    done = true
    rpc.fail(message)
    closeHandler?.(message)
  }
  child.on('error', (error) => settle(`${options.label} failed to start: ${error.message}`))
  child.on('exit', (code, signal) => {
    const tail = stderrTail.trim()
    settle(`${options.label} exited (${signal ?? `code ${code}`})` + (tail ? `: ${tail.slice(-500)}` : ''))
  })
  return {
    request: (method, params) => rpc.request(method, params),
    notify: (method, params) => rpc.notify(method, params),
    onNotification: (handler) => rpc.onNotification(handler),
    onRequest: (handler) => rpc.onRequest(handler),
    onClose: (handler) => {
      closeHandler = handler
    },
    close: () => {
      done = true
      rpc.fail(`${options.label} connection closed`)
      child.kill()
    },
  }
}
