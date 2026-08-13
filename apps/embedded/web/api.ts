import type {
  AgentConfigResponse,
  Doc,
  DocResponse,
  DocsResponse,
  MeResponse,
  User,
} from '../src/shared.ts'

/**
 * The wiki's own API. Same origin as the gateway, so the session cookie rides
 * every call and there is no token to hold in the tab.
 */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new ApiError(res.status, await errorText(res))
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const errorText = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

/** Carries the status, so a caller can tell "signed out" from "it broke". */
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
  login: (userId: string) =>
    call<MeResponse>('/api/login', { method: 'POST', body: JSON.stringify({ userId }) }),
  logout: () => call<MeResponse>('/api/logout', { method: 'POST' }),

  listDocs: () => call<DocsResponse>('/api/docs').then((r) => r.docs),
  getDoc: (id: string) => call<DocResponse>(`/api/docs/${id}`).then((r) => r.doc),
  createDoc: (title?: string) =>
    call<DocResponse>('/api/docs', { method: 'POST', body: JSON.stringify({ title }) }).then(
      (r) => r.doc,
    ),
  updateDoc: (id: string, patch: { title?: string; body?: string }) =>
    call<DocResponse>(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(
      (r) => r.doc,
    ),
  deleteDoc: (id: string) => call<void>(`/api/docs/${id}`, { method: 'DELETE' }),

  agent: () => call<AgentConfigResponse>('/api/agent'),

  /** Tell the server what is on screen, so the agent's `whoami` can answer. */
  setUiState: (openDocId: string | undefined) =>
    call<void>('/api/ui-state', { method: 'PUT', body: JSON.stringify({ openDocId }) }),
}

/** What the agent asks the app to do, streamed from `/api/ui-events`. */
export type UiIntent =
  | { type: 'open_doc'; docId: string }
  | { type: 'doc_deleted'; docId: string }

export type { Doc, User }
