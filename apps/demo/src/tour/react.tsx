import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionRow } from '@workerdeck/protocol'

import type { DemoGateway } from '../stage/gateway.ts'
import type { TourController } from './controller.ts'
import type { Journey, TourState, ViewState } from './types.ts'

type TourContextValue = { controller: TourController; journeys: readonly Journey[] }

const TourContext = createContext<TourContextValue | undefined>(undefined)

export function TourProvider({ controller, journeys, children }: TourContextValue & { children: ReactNode }) {
  return <TourContext.Provider value={{ controller, journeys }}>{children}</TourContext.Provider>
}

export function useTourContext(): TourContextValue {
  const value = useContext(TourContext)
  if (!value) {
    throw new Error('useTourContext outside TourProvider')
  }
  return value
}

export function useController(): TourController {
  return useTourContext().controller
}

export function useJourneys(): readonly Journey[] {
  return useTourContext().journeys
}

export function useTourState(): TourState {
  const controller = useController()
  return useSyncExternalStore(controller.subscribe, () => controller.state)
}

export function useView(): ViewState {
  const controller = useController()
  return useSyncExternalStore(controller.subscribe, () => controller.view)
}

export function useGateway(): DemoGateway {
  const controller = useController()
  return useSyncExternalStore(controller.subscribe, () => controller.gateway)
}

export function useRows(gateway: DemoGateway): SessionRow[] {
  return useSyncExternalStore(
    (listener) => gateway.subscribe(listener),
    () => gateway.rows(),
  )
}
