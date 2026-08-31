import { spawn } from 'node:child_process'
import { JsonRpcStdioConnection } from './jsonrpc.ts'
import type { AppServerConnection } from './types.ts'

const STDERR_TAIL_BYTES = 4096

export function connectAppServer(options: { executable: string; env: Record<string, string> }): AppServerConnection {
  const child = spawn(options.executable, ['app-server'], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rpc = new JsonRpcStdioConnection({ input: child.stdout, output: child.stdin })

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
  child.on('error', (error) => settle(`codex app-server failed to start: ${error.message}`))
  child.on('exit', (code, signal) => {
    const tail = stderrTail.trim()
    settle(`codex app-server exited (${signal ?? `code ${code}`})` + (tail ? `: ${tail.slice(-500)}` : ''))
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
      // Suppress the exit callback so a deliberate close doesn't read as a crash.
      done = true
      rpc.fail('codex app-server connection closed')
      child.kill()
    },
  }
}
