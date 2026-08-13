/**
 * The wire shapes the SPA and the server agree on.
 *
 * Imported by both tsconfigs (node and browser), so it must stay dependency-free
 * and type-only — the same discipline `@workerdeck/protocol` follows for the
 * gateway's own wire.
 */

export type User = {
  id: string
  name: string
  /** For the demo's login screen. There are three of these and they are in the
   * source; see `USERS` in `src/users.ts` for why that is the point. */
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
export type DocsResponse = { docs: Doc[] }
export type DocResponse = { doc: Doc }
export type CreateDocRequest = { title?: string }
export type UpdateDocRequest = { title?: string; body?: string }

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
