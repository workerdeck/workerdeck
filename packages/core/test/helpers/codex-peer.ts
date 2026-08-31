// The scripted app-server peer every codex suite drives. `codex-runner.test.ts` was one
// 2,200-line file holding this harness plus eight separate contracts; the harness is now an
// explicit module rather than an implicit one.
import type { SessionEvent } from '@workerdeck/protocol'
import type { AppServerConnectFn, AppServerConnection } from '../../src/engines/codex/types.ts'
import type { CodexRunner } from '../../src/engines/codex/runner.ts'

export type ScriptedPeer = ReturnType<typeof scriptedPeer>

export const THREAD_RESULT = {
  thread: { id: 'thread-1' },
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
}

export const GRANULAR_ASK = {
  granular: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
    request_permissions: true,
    skill_approval: true,
  },
}
export const GRANULAR_NEVER = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: false,
    skill_approval: false,
  },
}

export const USAGE_A = {
  inputTokens: 600,
  cachedInputTokens: 500,
  cacheWriteInputTokens: 30,
  outputTokens: 60,
  reasoningOutputTokens: 15,
  totalTokens: 675,
}
export const USAGE_B = {
  inputTokens: 400,
  cachedInputTokens: 300,
  cacheWriteInputTokens: 20,
  outputTokens: 40,
  reasoningOutputTokens: 10,
  totalTokens: 450,
}

export function scriptedPeer() {
  const requests: Array<{ method: string; params: unknown; connection: number }> = []
  const notifies: string[] = []
  const envs: Array<Record<string, string>> = []
  const responders = new Map<string, (params: unknown) => unknown>()
  let connectCount = 0
  let closedCount = 0
  let notificationHandler: ((method: string, params: unknown) => void) | undefined
  let requestHandler: ((method: string, params: unknown, id: string | number) => Promise<unknown>) | undefined
  let closeHandler: ((message: string) => void) | undefined

  responders.set('initialize', () => ({ codexHome: '/tmp/.codex' }))
  responders.set('thread/start', () => THREAD_RESULT)
  responders.set('thread/resume', () => THREAD_RESULT)

  const connectFn: AppServerConnectFn = (options) => {
    envs.push(options.env)
    const connection = ++connectCount
    const peer: AppServerConnection = {
      request: async (method, params) => {
        requests.push({ method, params, connection })
        const responder = responders.get(method)
        if (!responder) {
          return {}
        }
        return responder(params)
      },
      notify: (method) => {
        notifies.push(method)
      },
      onNotification: (handler) => {
        notificationHandler = handler
      },
      onRequest: (handler) => {
        requestHandler = handler
      },
      onClose: (handler) => {
        closeHandler = handler
      },
      close: () => {
        closedCount++
      },
    }
    return peer
  }

  return {
    connectFn,
    requests,
    notifies,
    envs,
    respond: (method: string, responder: (params: unknown) => unknown) => responders.set(method, responder),
    emit: (method: string, params: unknown) => notificationHandler!(method, params),
    serverRequest: (method: string, params: unknown, id: string | number = 'wire-1') => requestHandler!(method, params, id),
    die: (message: string) => closeHandler!(message),
    connections: () => connectCount,
    closed: () => closedCount,
  }
}

export function scriptTurn(
  peer: ScriptedPeer,
  script: (emit: (method: string, params: unknown) => void, turnId: string) => void,
  turnId = 'turn-1',
) {
  peer.respond('turn/start', () => {
    peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
    script(peer.emit, turnId)
    return { turn: { id: turnId, status: 'inProgress' } }
  })
}

export function collect(runner: CodexRunner): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  return events
}

export function ofType<T extends SessionEvent['type']>(events: SessionEvent[], type: T): Array<Extract<SessionEvent, { type: T }>> {
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
}
