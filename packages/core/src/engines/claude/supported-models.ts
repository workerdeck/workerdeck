import { tmpdir } from 'node:os'
import { query as sdkQuery, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption } from '@workerdeck/protocol'
import { withoutGatewaySecrets } from '../../lib/child-env.ts'
import { modelOptionsFromSdk } from '../../lib/normalize.ts'
import { withDeadline } from '../../lib/session-report.ts'

export type ClaudeModelsProbe = (env: Record<string, string | undefined>) => Promise<ModelOption[] | undefined>

export async function probeClaudeModels(
  env: Record<string, string | undefined>,
  options: { executable?: string; timeoutMs?: number; queryFn?: typeof sdkQuery } = {},
): Promise<ModelOption[] | undefined> {
  const abort = new AbortController()
  const q = (options.queryFn ?? sdkQuery)({
    prompt: idle(abort.signal),
    options: {
      cwd: tmpdir(),
      env: withoutGatewaySecrets(env),
      pathToClaudeCodeExecutable: options.executable,
      mcpServers: {},
      strictMcpConfig: true,
      abortController: abort,
    },
  })
  try {
    const models = await withDeadline(q.supportedModels(), options.timeoutMs ?? 30_000)
    const rows = models === undefined ? [] : modelOptionsFromSdk(models)
    return rows.length > 0 ? rows : undefined
  } catch {
    return undefined
  } finally {
    abort.abort()
    q.close()
  }
}

// No prompt is ever sent: the probe only needs the engine's init handshake, so it costs no model tokens.
function idle(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
    signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true }),
  )
  return { [Symbol.asyncIterator]: () => ({ next: () => ended }) }
}
