import { rateLimitWindows } from '@workerdeck/react'
import { ContextPanel, UsageMeters, type SessionVitals } from '@workerdeck/ui'

export function UsageView({ vitals }: { vitals: SessionVitals | undefined }) {
  const windows = rateLimitWindows({ rateLimits: vitals?.rateLimits })
  if (windows.length === 0) {
    return <div className="p-2 text-body-sm text-fg-4">No plan-usage reading yet.</div>
  }
  return (
    <div className="p-2">
      <UsageMeters windows={windows} className="gap-4" />
    </div>
  )
}

export function ContextView({ vitals }: { vitals: SessionVitals | undefined }) {
  return (
    <div className="p-2">
      <ContextPanel usage={vitals?.contextUsage} engine={vitals?.engine ?? 'claude'} />
    </div>
  )
}
