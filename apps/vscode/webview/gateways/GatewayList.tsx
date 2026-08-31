import { Button, cn } from '@workerdeck/ui'
import { Pencil, Plug, Trash2 } from 'lucide-react'
import type { WireHost } from '../../src/bridge-protocol.ts'
import { Empty, Key } from '../ui/Empty.tsx'

const PROBE_LABELS: Record<WireHost['probe'], string> = {
  connected: 'connected',
  pending: 'checking…',
  unauthorized: 'unauthorized',
  unreachable: 'unreachable',
}

export function GatewayList({
  hosts,
  sessionCounts,
  onEdit,
  onRemove,
}: {
  hosts: readonly WireHost[]
  sessionCounts: Record<string, number>
  onEdit: (hostId: string) => void
  onRemove: (hostId: string) => void
}) {
  if (hosts.length === 0) {
    return (
      <Empty
        icon={<Plug />}
        title="No gateways yet"
        description={
          <>
            Start one with <code className="font-mono">npx workerdeck</code>, then add it with <Key>+</Key> above.
          </>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {hosts.map((host) => (
        <div key={host.id} className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-hover">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              host.probe === 'connected' ? 'bg-success' : host.probe === 'pending' ? 'bg-fg-4' : 'bg-danger',
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body-sm text-fg-1">{host.name}</span>
            <span className="truncate text-label text-fg-4">
              {host.rawUrl} · {PROBE_LABELS[host.probe]}
              {host.probe === 'connected' ? ` · ${sessionCounts[host.id] ?? 0} session${sessionCounts[host.id] === 1 ? '' : 's'}` : ''}
            </span>
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${host.name}`} onClick={() => onEdit(host.id)}>
            <Pencil className="size-3" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${host.name}`} onClick={() => onRemove(host.id)}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}
