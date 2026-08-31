import type { AgentConfigResponse, Doc, MeResponse, User } from '../../src/shared.ts'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await errorText(res))
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const api = {
  users: () => call<{ users: User[] }>('/api/users'),
  me: () => call<MeResponse>('/api/me'),
  login: (userId: string) => call<MeResponse>('/api/login', { method: 'POST', body: JSON.stringify({ userId }) }),
  logout: () => call<MeResponse>('/api/logout', { method: 'POST' }),

  agent: () => call<AgentConfigResponse>('/api/agent'),

  setUiState: (openDocId: string | undefined) => call<void>('/api/ui-state', { method: 'PUT', body: JSON.stringify({ openDocId }) }),
}

export type { UiIntent } from '../../src/app/state.ts'

export type { Doc, User }
