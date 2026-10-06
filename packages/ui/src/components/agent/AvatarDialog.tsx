import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { errorMessage } from '@workerdeck/protocol'
import { Shuffle } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { Spinner } from '../ui/Spinner.tsx'

const CANDIDATES = 8

type Candidate = { seed: string; src?: string }

export type AvatarDialogAgent = { id: string; name: string }

export interface AvatarDialogProps {
  client: WorkerDeckClient | undefined
  // Open while set.
  agent: AvatarDialogAgent | undefined
  onClose: () => void
  onChanged?: () => void
}

function seeds(): Candidate[] {
  return Array.from({ length: CANDIDATES }, () => ({ seed: crypto.randomUUID() }))
}

export function AvatarDialog({ client, agent, onClose, onChanged }: AvatarDialogProps) {
  return (
    <Dialog open={agent !== undefined && client !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={`Avatar for ${agent?.name ?? 'agent'}`} />
        <DialogBody>
          {agent && client ? <AvatarPicker key={agent.id} client={client} agentId={agent.id} onClose={onClose} onChanged={onChanged} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

interface AvatarPickerProps {
  client: WorkerDeckClient
  agentId: string
  onClose: () => void
  onChanged?: () => void
}

function AvatarPicker({ client, agentId, onClose, onChanged }: AvatarPickerProps) {
  const [candidates, setCandidates] = useState<Candidate[]>(seeds)
  const [saving, setSaving] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    const urls: string[] = []
    for (const candidate of candidates) {
      if (candidate.src) {
        continue
      }
      void client
        .agentAvatarPreview(agentId, candidate.seed)
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
  }, [candidates.map((c) => c.seed).join(','), agentId, client])

  const choose = (seed: string) => {
    setSaving(seed)
    setError(undefined)
    void client
      .changeAgentAvatar(agentId, seed)
      .then(() => {
        onChanged?.()
        onClose()
      })
      .catch((e: unknown) => {
        setSaving(undefined)
        setError(errorMessage(e, 'Could not change the avatar'))
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
              <img src={candidate.src} alt="" className="size-4/5 max-w-14 [image-rendering:pixelated]" draggable={false} />
            ) : (
              <Spinner className="size-4 text-fg-4" />
            )}
          </button>
        ))}
      </div>
      {error ? <p className="text-label text-danger">{error}</p> : null}
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
