export type User = {
  id: string
  name: string
  avatar: string
}

// `body` is absent in list responses.
export type Doc = {
  id: string
  title: string
  body?: string
  updatedAt: number
}

export type MeResponse = { user: User | null }
export type LoginRequest = { userId: string }

export type AgentConfigResponse = {
  baseUrl: string
  profile: string
  available: boolean
  unavailableReason?: string
}
