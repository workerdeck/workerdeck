/**
 * The wire shapes the SPA and the server agree on **by hand** — only what no
 * silkweave action describes (the documents API is inferred from
 * `wiki/actions.ts`). Imported by both tsconfigs, so it stays dependency-free
 * and type-only.
 */

export type User = {
  id: string
  name: string
  /** For the demo's login screen; see `USERS` in `src/auth/users.ts`. */
  avatar: string
}

/** A wiki document, as the SPA sees it. `body` is absent in list responses. */
export type Doc = {
  id: string
  title: string
  body?: string
  updatedAt: number
}

export type MeResponse = { user: User | null }
export type LoginRequest = { userId: string }

/** `GET /api/agent` — what the SPA needs to talk to the gateway. */
export type AgentConfigResponse = {
  /** Gateway REST base, same origin. */
  baseUrl: string
  /** Profile the sidebar creates sessions under. */
  profile: string
  /** False when the server has no model credentials, so the sidebar can say so
   * instead of failing at create time. */
  available: boolean
  unavailableReason?: string
}
