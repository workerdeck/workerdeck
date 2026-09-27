import type { ProfileInfo } from '@workerdeck/protocol'

import type { SessionSeed } from '../stage/gateway.ts'
import type { Director } from './director.ts'

export type Region = string

export type Placement = 'auto' | 'left' | 'right' | 'top' | 'bottom' | 'center'

export type Scene = {
  seeds: SessionSeed[]
  profiles?: ProfileInfo[]
  selected?: string
  expanded?: Record<string, boolean>
}

export type Journey = {
  id: string
  title: string
  summary: string
  regions: Region[]
  scene: () => Scene
  run: (director: Director) => Promise<void>
}

export type Card = {
  title: string
  body: string
  focus: Region[]
  placement: Placement
  next?: string
  waiting?: string
}

export type Hint = { sessionId: string; prompt: string }

export type ViewState = {
  selected: string | undefined
  expanded: Record<string, boolean>
}

export type TourState = {
  journey: Journey | undefined
  epoch: number
  checkpoint: number
  total: number | undefined
  focus: Region[]
  card: Card | undefined
  hint: Hint | undefined
  finished: boolean
}
