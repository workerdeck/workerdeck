import { initialTranscriptState, type TranscriptState } from './transcript.ts'

export const attachSeedToken = (resyncSeq: number, key: string): string => `${resyncSeq}:${key}`

export type AttachInputs = {
  resyncSeq: number
  key: string
  seededFor: string
  current: TranscriptState
  cacheEnabled: boolean
  skipCache: boolean
  warm: TranscriptState | undefined
}

export type AttachPlan = {
  held: TranscriptState
  seed: boolean
  seedToken: string
  afterSeq?: number
}

export const planAttach = (input: AttachInputs): AttachPlan => {
  const seedToken = attachSeedToken(input.resyncSeq, input.key)
  const warm = input.cacheEnabled && !input.skipCache ? input.warm : undefined
  const seed = input.seededFor !== seedToken
  const held = seed ? (warm ?? initialTranscriptState) : input.current
  // `afterSeq` derives from the state held and never from a second cache read, which a racing write could move.
  return { held, seed, seedToken, ...(held.lastSeq > 0 ? { afterSeq: held.lastSeq } : {}) }
}

export const shouldWriteParting = (input: { cacheEnabled: boolean; skipCache: boolean; parting: TranscriptState }): boolean =>
  input.cacheEnabled && !input.skipCache && input.parting.lastSeq > 0 && input.parting.session !== undefined
