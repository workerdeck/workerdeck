import { useMemo, useState } from 'react'
import { TooltipProvider, type SessionVitals } from '@workerdeck/ui'

import { homeScene, JOURNEYS } from './journeys/index.ts'
import { AgentView } from './panels/AgentView.tsx'
import { ContextView, UsageView } from './panels/SectionViews.tsx'
import { SessionsView } from './panels/SessionsView.tsx'
import { NativeStatusItems, WorkerDeckStatusItems } from './panels/StatusItems.tsx'
import { Workbench, type ShellSection } from './shell/index.ts'
import { TourController } from './tour/controller.ts'
import { Launcher } from './tour/Launcher.tsx'
import { TourOverlay } from './tour/Overlay.tsx'
import { TourProvider, useController, useTourState, useView } from './tour/react.tsx'

export function App() {
  const controller = useMemo(() => new TourController({ home: homeScene, speed: speedFromUrl() }), [])
  return (
    <TourProvider controller={controller} journeys={JOURNEYS}>
      <TooltipProvider>
        <div className="flex h-full items-center justify-center p-4">
          <div className="aspect-[16/10] max-h-full w-full max-w-[1440px] overflow-hidden rounded-xl shadow-[0_30px_80px_rgb(0_0_0_/_0.6)] ring-1 ring-white/10">
            <Deck />
          </div>
        </div>
        <TourOverlay />
        <Launcher />
      </TooltipProvider>
    </TourProvider>
  )
}

function Deck() {
  const controller = useController()
  const { epoch } = useTourState()
  const view = useView()
  const [vitals, setVitals] = useState<SessionVitals | undefined>(undefined)
  const sections: ShellSection[] = [
    { id: 'sessions', title: 'Sessions', content: <SessionsView />, expanded: view.expanded.sessions ?? true, grow: true },
    { id: 'usage', title: 'Usage', content: <UsageView vitals={vitals} />, expanded: view.expanded.usage ?? false },
    { id: 'context', title: 'Context', content: <ContextView vitals={vitals} />, expanded: view.expanded.context ?? false },
  ]
  return (
    <Workbench
      key={epoch}
      title="acme-web"
      panel={<AgentView onVitals={setVitals} />}
      secondaryTabs={[{ id: 'workerdeck', label: 'WorkerDeck' }]}
      activeSecondaryTab="workerdeck"
      sections={sections}
      onToggleSection={(id) => controller.toggle(id)}
      statusBar={{
        left: (
          <>
            <NativeStatusItems />
            <WorkerDeckStatusItems vitals={vitals} />
          </>
        ),
      }}
    />
  )
}

function speedFromUrl(): number {
  const value = Number(new URLSearchParams(location.search).get('speed'))
  return Number.isFinite(value) && value > 0 ? value : 1
}
