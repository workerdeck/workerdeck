import type { Journey, Scene } from '../tour/types.ts'
import { homeSeeds, PROFILES } from './fixtures.ts'
import { sessionsJourney } from './sessions.ts'

export const JOURNEYS: readonly Journey[] = [sessionsJourney]

export function homeScene(): Scene {
  return { seeds: homeSeeds(), profiles: PROFILES, selected: 'landing' }
}
