import type { ReactNode } from 'react'
import type { SessionCapability } from '@workerdeck/protocol'

// The create dialog and the edit card are the same form twice; these three pieces are what they
// share, and keeping them here is what stops the two from drifting the way RunForm's did.

export const CAPABILITIES: SessionCapability[] = ['web_search', 'download', 'web_fetch', 'deliver_file']

// A comma-separated field ("a, b, c") as a list, with blanks dropped.
export function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-label font-medium text-fg-3">{label}</span>
      {children}
    </label>
  )
}
