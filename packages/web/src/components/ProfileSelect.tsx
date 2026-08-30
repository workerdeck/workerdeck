import type { ProfileInfo } from '@workerdeck/protocol'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '@workerdeck/ui'

/** Profile picker for the create forms. Renders nothing when the server declares no
 * profiles; with exactly one it still shows (informational) but the choice is moot. */
export function ProfileSelect({
  profiles,
  value,
  onChange,
  className,
}: {
  profiles: ProfileInfo[]
  value: string
  onChange: (name: string) => void
  className?: string
}) {
  if (profiles.length === 0) {
    return null
  }
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-label font-medium text-fg-3">Profile</span>
      <Select
        items={profiles.map((p) => ({ value: p.name, label: p.name }))}
        value={value}
        onValueChange={(name) => onChange(name as string)}
      >
        <SelectTrigger className={className}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            // Greyed, never hidden: availability is display-only (the probe can
            // be stale in both directions), so the row stays selectable and the
            // reason travels as its tooltip.
            <SelectItem key={p.name} value={p.name}>
              <SelectItemText>
                <span className={p.available === false ? 'text-fg-4' : undefined} title={p.unavailableReason}>
                  {p.description ? `${p.name} — ${p.description}` : p.name}
                  {p.available === false ? ' (unavailable)' : ''}
                </span>
              </SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}
