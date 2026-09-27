import { useState } from 'react'
import { Compass, X } from 'lucide-react'

import { JourneyButton } from './Overlay.tsx'
import { useJourneys, useTourState } from './react.tsx'

export function Launcher() {
  const journeys = useJourneys()
  const state = useTourState()
  const [open, setOpen] = useState(true)
  if (state.journey) {
    return null
  }
  return (
    <div className="fixed right-6 bottom-6 z-50 flex flex-col items-end gap-2">
      {open ? (
        <div className="flex w-[340px] flex-col gap-2 rounded-xl border border-hint/40 bg-[#17171c]/95 p-3 text-[13px] text-[#d4d4d8] shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-2 px-1">
            <div>
              <div className="text-[15px] font-semibold text-white">Explore WorkerDeck</div>
              <p className="m-0 mt-1 text-[#a1a1aa]">
                A live workspace with scripted agents. Hover the highlighted parts of the window, or pick a tour.
              </p>
            </div>
            <button type="button" aria-label="Close" className="text-[#71717a] hover:text-white" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </button>
          </div>
          <div className="flex flex-col">
            {journeys.map((journey) => (
              <JourneyButton key={journey.id} journey={journey} />
            ))}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="flex items-center gap-2 rounded-full bg-hint px-3.5 py-2 text-[13px] font-medium text-[#0b0b12] shadow-xl hover:bg-hint-strong"
        onClick={() => setOpen(!open)}
      >
        <Compass className="size-4" /> Tours
      </button>
    </div>
  )
}
