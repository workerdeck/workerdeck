import { Button, cn } from '@workerdeck/ui'
import { Pencil, Trash2, UserCog } from 'lucide-react'
import type { WireProfile } from '../../src/bridge-protocol.ts'
import { Empty, Key } from '../ui/Empty.tsx'

export function ProfileList({
  profiles,
  showGateway,
  onEdit,
  onRemove,
}: {
  profiles: readonly WireProfile[]
  showGateway: boolean
  onEdit: (hostId: string, name: string) => void
  onRemove: (hostId: string, name: string) => void
}) {
  if (profiles.length === 0) {
    return (
      <Empty
        icon={<UserCog />}
        title="No profiles yet"
        description={
          <>
            A profile is one credential set — a Claude config dir, a Codex home. Add one with <Key>+</Key> above.
          </>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {profiles.map((profile) => (
        <div
          key={`${profile.hostId}:${profile.name}`}
          className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-hover"
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              profile.available === false ? 'bg-danger' : profile.available ? 'bg-success' : 'bg-fg-4',
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body-sm text-fg-1">{profile.name}</span>
            <span className="truncate text-label text-fg-4">
              {[
                showGateway ? profile.hostName : undefined,
                profile.engine,
                // A profile the gateway declared in its own config cannot be changed from here, and the
                // row says so rather than offering buttons that answer 403.
                profile.managed ? undefined : 'declared',
                profile.available === false ? (profile.unavailableReason ?? 'unavailable') : undefined,
                profile.description ?? profile.configDir,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {profile.managed && profile.canManage ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${profile.name}`}
                onClick={() => onEdit(profile.hostId, profile.name)}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${profile.name}`}
                onClick={() => onRemove(profile.hostId, profile.name)}
              >
                <Trash2 className="size-3" />
              </Button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  )
}
