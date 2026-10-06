import type { ProfileEngine } from '@workerdeck/protocol'

export type AvatarImage = { png: Uint8Array; etag: string; durations?: number[] }

// `roll` returns an opaque recipe the gateway persists on the agent and hands back to `still`/`busy`.
export type AvatarProvider = {
  roll(seed: string, engine: ProfileEngine | undefined, projectKey: string | undefined): Promise<unknown>
  still(recipe: unknown): Promise<AvatarImage>
  busy(recipe: unknown): Promise<AvatarImage | undefined>
}
