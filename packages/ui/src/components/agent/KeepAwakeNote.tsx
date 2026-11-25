import { Coffee } from 'lucide-react'
import { holdsAwake, wakeHolders, wakeSummary } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'

export interface KeepAwakeNoteProps {
  rows: readonly SessionRow[]
  // Host ids whose gateway reports `GatewayMeta.keepAwake`, 'always' with `alwaysAwake`.
  awake: Readonly<Record<string, boolean | 'always' | undefined>>
}

export function KeepAwakeNote({ rows, awake }: KeepAwakeNoteProps) {
  const hosts = new Map<string, { id: string; name: string; rows: SessionRow[] }>()
  for (const row of rows) {
    if (!awake[row.hostId]) {
      continue
    }
    const host = hosts.get(row.hostId) ?? { id: row.hostId, name: row.hostName, rows: [] }
    host.rows.push(row)
    hosts.set(row.hostId, host)
  }
  const lines = [...hosts.values()].flatMap((host) => {
    const holders = wakeHolders(host.rows.map((row) => row.info))
    const always = awake[host.id] === 'always'
    if (!always && !holdsAwake(holders)) {
      return []
    }
    const names = holders.shells.map((shell) => shell.label).join(', ')
    return [{ name: host.name, text: wakeSummary(holders, hosts.size > 1 ? host.name : undefined, always)!, names }]
  })
  if (!lines.length) {
    return null
  }
  return (
    <div data-slot="keep-awake" className="flex flex-col gap-0.5 px-3 py-1.5 text-label text-fg-4">
      {lines.map((line) => (
        <span
          key={line.name}
          title={line.names ? `${line.text}\nShells: ${line.names}` : line.text}
          className="flex min-w-0 items-center gap-1.5"
        >
          <Coffee className="size-3 shrink-0" />
          <span className="truncate">{line.text}</span>
        </span>
      ))}
    </div>
  )
}
