import type { Readable, Writable } from 'node:stream'
import { JsonRpcStdioConnection } from '../../lib/jsonrpc-stdio.ts'

export { JsonRpcError, JsonRpcStdioConnection } from '../../lib/jsonrpc-stdio.ts'

export const CODEX_TRACE_ENV = 'WORKERDECK_CODEX_TRACE'

export function codexRpc(options: { input: Readable; output: Writable }): JsonRpcStdioConnection {
  return new JsonRpcStdioConnection({
    ...options,
    label: 'codex app-server',
    traceEnv: CODEX_TRACE_ENV,
    // account/* and login* are the one place this protocol carries a masked credential fragment.
    traceSkip: (method) => method.startsWith('account/') || method.startsWith('login'),
  })
}
