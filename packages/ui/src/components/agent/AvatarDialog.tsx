import { useId, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  FACE_KINDS,
  FACE_PARTS,
  FACE_SWATCHES,
  FACE_TONES,
  errorMessage,
  resolveAgentFace,
  resolveFaceColor,
  rollFace,
  type AgentFace,
  type FacePart,
  type FaceSwatch,
  type FaceTileShape,
  type FaceTone,
} from '@workerdeck/protocol'
import { Shuffle } from 'lucide-react'
import { faceSvg, type FaceState } from '../../lib/face-svg.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { OptionSelect } from '../ui/Select.tsx'

const CANDIDATES = 8
const STATES: readonly FaceState[] = ['idle', 'working', 'attention', 'asleep', 'starting', 'failed', 'closed']

type Slot = FacePart | 'tile' | 'backdrop'

// `project` is the swatch the face's project colour resolves to, for the preview.
export type AvatarDialogAgent = { id: string; name: string; face?: AgentFace; project: FaceSwatch }

export interface AvatarDialogProps {
  client: WorkerDeckClient | undefined
  // Open while set.
  agent: AvatarDialogAgent | undefined
  onClose: () => void
  onChanged?: () => void
}

export function AvatarDialog({ client, agent, onClose, onChanged }: AvatarDialogProps) {
  return (
    <Dialog open={agent !== undefined && client !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader title={`Avatar for ${agent?.name ?? 'agent'}`} />
        <DialogBody>
          {agent && client ? <FaceEditor key={agent.id} client={client} agent={agent} onClose={onClose} onChanged={onChanged} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export interface FaceViewProps {
  face: AgentFace | undefined
  project: FaceSwatch
  state?: FaceState
  size: number
  phase?: string
}

export function FaceView({ face, project, state = 'idle', size, phase }: FaceViewProps) {
  const id = `wdf${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <span
      className="inline-flex shrink-0"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: faceSvg({ face, project, state, size, id, phase }) }}
    />
  )
}

function candidates(project: FaceSwatch): AgentFace[] {
  return Array.from({ length: CANDIDATES }, () => rollFace(crypto.randomUUID(), project))
}

const SWATCH_OPTIONS = [{ value: 'project', label: 'Project' }, ...FACE_SWATCHES.map((s) => ({ value: s, label: s }))]
const TONE_OPTIONS = [{ value: 'default', label: 'auto' }, ...FACE_TONES.map((t) => ({ value: t, label: t }))]
const LABELS: Record<Slot, string> = { backdrop: 'Backdrop', tile: 'Head', antenna: 'Antenna', visor: 'Visor', eyes: 'Eyes', mouth: 'Mouth' }
const DEFAULT_TONE: Record<Slot, FaceTone> = { backdrop: 'wash', tile: 'base', antenna: 'glow', visor: 'screen', eyes: 'glow', mouth: 'glow' }
const SLOTS: readonly Slot[] = ['backdrop', 'tile', ...FACE_PARTS]

function splitColor(ref: string | undefined): { swatch: string; tone: string } {
  const [swatch, tone] = (ref ?? 'project').split('/')
  return { swatch: swatch || 'project', tone: tone ?? 'default' }
}

function joinColor(swatch: string, tone: string): string | undefined {
  if (swatch === 'project' && tone === 'default') {
    return undefined
  }
  return tone === 'default' ? swatch : `${swatch}/${tone}`
}

interface FaceEditorProps {
  client: WorkerDeckClient
  agent: AvatarDialogAgent
  onClose: () => void
  onChanged?: () => void
}

function FaceEditor({ client, agent, onClose, onChanged }: FaceEditorProps) {
  const [face, setFace] = useState<AgentFace>(() => agent.face ?? rollFace(agent.id, agent.project))
  const [rolls, setRolls] = useState(() => candidates(agent.project))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const resolved = resolveAgentFace(face)

  const colorOf = (slot: Slot): string | undefined =>
    slot === 'backdrop' ? resolved.backdrop : slot === 'tile' ? resolved.tile.color : resolved[slot].color
  const kindOf = (slot: Slot): string | undefined => (slot === 'backdrop' ? undefined : slot === 'tile' ? resolved.tile.shape : resolved[slot].kind)

  const setColor = (slot: Slot, color: string | undefined) => {
    const paint = color === undefined ? {} : { color }
    setFace((held) => {
      if (slot === 'backdrop') {
        const { backdrop: _drop, ...rest } = held
        return color === undefined ? rest : { ...rest, backdrop: { color } }
      }
      if (slot === 'tile') {
        return { ...held, tile: { shape: resolved.tile.shape, ...paint } }
      }
      return { ...held, [slot]: { kind: resolved[slot].kind, ...paint } }
    })
  }
  const setKind = (slot: Slot, kind: string) => {
    const paint = (color: string | undefined) => (color === undefined ? {} : { color })
    setFace((held) =>
      slot === 'tile'
        ? { ...held, tile: { shape: kind as FaceTileShape, ...paint(resolved.tile.color) } }
        : { ...held, [slot]: { kind, ...paint(colorOf(slot)) } },
    )
  }
  const save = () => {
    setSaving(true)
    setError(undefined)
    void client
      .changeAgentAvatar(agent.id, { face })
      .then(() => {
        onChanged?.()
        onClose()
      })
      .catch((e: unknown) => {
        setSaving(false)
        setError(errorMessage(e, 'Could not change the avatar'))
      })
  }

  const slotRow = (slot: Slot) => {
    const { swatch, tone } = splitColor(colorOf(slot))
    const shown = resolveFaceColor(colorOf(slot), agent.project, DEFAULT_TONE[slot])
    const kinds: readonly string[] | undefined = slot === 'backdrop' ? undefined : FACE_KINDS[slot]
    const kind = kindOf(slot)
    return (
      <div key={slot} className="contents">
        <span className="text-body-sm text-fg-3">{LABELS[slot]}</span>
        {kinds && kind ? (
          <OptionSelect
            label={`${LABELS[slot]} kind`}
            value={kind}
            options={kinds.map((k) => ({ value: k, label: k }))}
            onChange={(k) => setKind(slot, k)}
            className="h-7"
          />
        ) : (
          <span />
        )}
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="size-4 shrink-0 rounded-[4px]" style={{ background: `var(--sw-${shown.swatch}-${shown.tone})` }} />
          <OptionSelect
            label={`${LABELS[slot]} colour`}
            value={swatch}
            options={SWATCH_OPTIONS}
            onChange={(s) => setColor(slot, joinColor(s, tone))}
            className="h-7 min-w-0 flex-1"
          />
          <OptionSelect
            label={`${LABELS[slot]} tone`}
            value={tone}
            options={TONE_OPTIONS}
            onChange={(t) => setColor(slot, joinColor(swatch, t))}
            className="h-7 min-w-0 flex-1"
          />
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FaceView face={face} project={agent.project} size={72} phase={agent.id} />
        <div className="flex flex-wrap gap-2">
          {STATES.map((state) => (
            <span key={state} className="flex flex-col items-center gap-1">
              <FaceView face={face} project={agent.project} state={state} size={32} phase={agent.id} />
              <span className="text-[0.625rem] text-fg-4">{state}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-fg-4">Start from a roll</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {rolls.map((roll, i) => (
            <button
              key={i}
              type="button"
              aria-label="Start from this roll"
              onClick={() => setFace(roll)}
              className="flex rounded-[6px] p-0.5 outline-none hover:ring-1 hover:ring-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FaceView face={roll} project={agent.project} size={32} />
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setRolls(candidates(agent.project))}>
            <Shuffle />
            More
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">{SLOTS.map(slotRow)}</div>
      {error ? <p className="text-label text-danger">{error}</p> : null}
      <p className="text-label text-fg-4">The agent can also change its own with change_avatar.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}
