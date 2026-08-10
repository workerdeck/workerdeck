import { Button, cn } from '@workerdeck/ui'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { WireHost } from '../../src/bridge-protocol.ts'

const PROBE_LABELS: Record<WireHost['probe'], string> = {
  connected: 'connected',
  pending: 'checking…',
  unauthorized: 'unauthorized',
  unreachable: 'unreachable',
}

/**
 * The gateways screen: view, add, edit, remove. The sessions list is a view over
 * every gateway at once, so this is the only place a gateway is managed — the
 * list itself has no picker to keep in sync.
 */
export function GatewaysScreen({
  hosts,
  sessionCounts,
  onAdd,
  onEdit,
  onRemove,
}: {
  hosts: readonly WireHost[]
  sessionCounts: Record<string, number>
  onAdd: () => void
  onEdit: (hostId: string) => void
  onRemove: (hostId: string) => void
}) {
  return (
    <div className='flex flex-col gap-1 p-2'>
      {hosts.length === 0 ? (
        <p className='px-1 py-2 text-body-sm text-fg-4'>
          No gateways yet. Start one with <code className='font-mono'>npx workerdeck</code> and add
          it here.
        </p>
      ) : null}
      {hosts.map((host) => (
        <div
          key={host.id}
          className='group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-hover'>
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              host.probe === 'connected'
                ? 'bg-success'
                : host.probe === 'pending'
                  ? 'bg-fg-4'
                  : 'bg-danger',
            )}
          />
          <span className='flex min-w-0 flex-1 flex-col'>
            <span className='truncate text-body-sm text-fg-1'>{host.name}</span>
            <span className='truncate text-label text-fg-4'>
              {host.rawUrl} · {PROBE_LABELS[host.probe]}
              {host.probe === 'connected'
                ? ` · ${sessionCounts[host.id] ?? 0} session${sessionCounts[host.id] === 1 ? '' : 's'}`
                : ''}
            </span>
          </span>
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={`Edit ${host.name}`}
            onClick={() => onEdit(host.id)}>
            <Pencil className='size-3' />
          </Button>
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={`Remove ${host.name}`}
            onClick={() => onRemove(host.id)}>
            <Trash2 className='size-3' />
          </Button>
        </div>
      ))}
      <Button variant='ghost' size='sm' className='mt-1 self-start' onClick={onAdd}>
        <Plus className='size-3.5' /> Add gateway
      </Button>
    </div>
  )
}
