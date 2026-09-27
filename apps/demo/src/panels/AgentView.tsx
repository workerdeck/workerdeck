import { SessionPanel, type SessionVitals } from '@workerdeck/ui'

import { useGateway, useView } from '../tour/react.tsx'

export function AgentView({ onVitals }: { onVitals: (vitals: SessionVitals) => void }) {
  const gateway = useGateway()
  const view = useView()
  return (
    <SessionPanel
      key={view.selected}
      client={gateway.client}
      sessionId={view.selected}
      className="h-full"
      transcriptVariant="terminal"
      stickyPrompt
      scrubber
      panelSurface="external"
      controlsSurface="external"
      statusSurface="external"
      focusComposerOnClick
      cacheTranscript={false}
      onVitals={onVitals}
    />
  )
}
