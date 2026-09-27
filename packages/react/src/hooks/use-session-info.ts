import type { WorkerDeckClient } from '@workerdeck/client'
import { errorMessage, type SessionInfo } from '@workerdeck/protocol'
import { useAsync } from '../lib/async-guards.ts'

export type UseSessionInfoResult = {
  info: SessionInfo | undefined
  loading: boolean
  error: string | undefined
}

export function useSessionInfo(client: WorkerDeckClient, sessionId: string | undefined): UseSessionInfoResult {
  const { data, error, loading } = useAsync(() => client.getSession(sessionId!), [client, sessionId], { enabled: !!sessionId })
  return { info: data, loading, error: error === undefined ? undefined : errorMessage(error, 'Session not found') }
}
