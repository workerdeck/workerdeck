import { useEffect, useState } from 'react'
import type { SessionRow } from '@workerdeck/protocol'
import { errorMessage } from '@workerdeck/protocol'
import { Button, Dialog, DialogBody, DialogContent, DialogHeader, Spinner, cn, toast } from '@workerdeck/ui'
import { Shuffle } from 'lucide-react'
import { clientFor } from '@/lib/hosts.ts'

const CANDIDATES = 8

type Candidate = { seed: string; src?: string }

function seeds(): Candidate[] {
  return Array.from({ length: CANDIDATES }, () => ({ seed: crypto.randomUUID() }))
}

export function AvatarDialog({ row, onClose, onChanged }: { row?: SessionRow; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open={row !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={`Avatar for ${row?.info.agent?.name ?? 'agent'}`} />
        <DialogBody>{row ? <AvatarPicker key={row.info.id} row={row} onClose={onClose} onChanged={onChanged} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function AvatarPicker({ row, onClose, onChanged }: { row: SessionRow; onClose: () => void; onChanged: () => void }) {
  const agent = row.info.agent!
  const [candidates, setCandidates] = useState<Candidate[]>(seeds)
  const [saving, setSaving] = useState<string>()

  useEffect(() => {
    const client = clientFor(row.hostId)
    if (!client) {
      return
    }
    let alive = true
    const urls: string[] = []
    for (const candidate of candidates) {
      if (candidate.src) {
        continue
      }
      void client
        .agentAvatarPreview(agent.id, candidate.seed)
        .then((blob) => {
          const src = URL.createObjectURL(blob)
          urls.push(src)
          if (alive) {
            setCandidates((held) => held.map((c) => (c.seed === candidate.seed ? { ...c, src } : c)))
          }
        })
        .catch(() => {})
    }
    return () => {
      alive = false
      for (const url of urls) {
        URL.revokeObjectURL(url)
      }
    }
  }, [candidates.map((c) => c.seed).join(','), agent.id, row.hostId])

  const choose = (seed: string) => {
    const client = clientFor(row.hostId)
    if (!client) {
      return
    }
    setSaving(seed)
    void client
      .changeAgentAvatar(agent.id, seed)
      .then(() => {
        onChanged()
        onClose()
      })
      .catch((e: unknown) => {
        setSaving(undefined)
        toast.error(errorMessage(e, 'Could not change the avatar'))
      })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        {candidates.map((candidate) => (
          <button
            key={candidate.seed}
            type="button"
            disabled={saving !== undefined}
            aria-label="Use this avatar"
            onClick={() => choose(candidate.seed)}
            className={cn(
              'flex aspect-square items-center justify-center rounded-md border border-border bg-surface hover:border-accent',
              saving === candidate.seed && 'border-accent',
            )}
          >
            {candidate.src ? (
              <img src={candidate.src} alt="" className="size-14 [image-rendering:pixelated]" draggable={false} />
            ) : (
              <Spinner className="size-4 text-fg-4" />
            )}
          </button>
        ))}
      </div>
      <p className="text-label text-fg-4">Pick one. The agent can also change its own with change_avatar.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={saving !== undefined} onClick={() => setCandidates(seeds())}>
          <Shuffle />
          More
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
