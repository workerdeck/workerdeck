import { useState } from 'react'
import type { SkillInfo } from '@workerdeck/protocol'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogRow } from '../ui/Dialog.tsx'

export interface SkillsDialogProps {
  skills: SkillInfo[] | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Insert a skill's opening message into the composer, if the host offers
   * that. Omit and the dialog is read-only. */
  onUse?: (skill: SkillInfo) => void
  className?: string
}

/** Where the skill came from. The engine's set is open, so an unrecognised
 * scope renders as itself rather than being forced into a bucket. */
const SCOPE_LABEL: Record<string, string> = {
  user: 'Personal',
  repo: 'This project',
  system: 'System',
  admin: 'Managed',
}

/**
 * The skills this session's engine found, grouped by scope.
 *
 * A skill is **not** a command — the model decides to use one by reading its
 * description, and there is no wire syntax that invokes it. So "Use this skill"
 * only drafts a message into the composer for the operator to edit and send.
 */
export function SkillsDialog({ skills, open, onOpenChange, onUse, className }: SkillsDialogProps) {
  const [selected, setSelected] = useState<string | undefined>()
  const skill = skills?.find((s) => s.name === selected)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSelected(undefined)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className={className}>
        <DialogHeader
          title={skill ? (skill.displayName ?? skill.name) : 'Skills'}
          description={
            skill
              ? skill.name !== (skill.displayName ?? skill.name)
                ? skill.name
                : undefined
              : 'Capabilities the agent can choose to use. Not commands — the model picks them from their descriptions.'
          }
          actions={
            skill ? (
              <Button variant="ghost" size="xs" onClick={() => setSelected(undefined)}>
                <ChevronLeft className="size-3.5" />
                Back
              </Button>
            ) : undefined
          }
        />
        <DialogBody>
          {skill ? (
            <SkillView skill={skill} onUse={onUse} onUsed={() => onOpenChange(false)} />
          ) : (
            <SkillList skills={skills} onSelect={setSelected} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

const SkillList = ({ skills, onSelect }: { skills: SkillInfo[] | undefined; onSelect: (name: string) => void }) => {
  if (!skills) {
    // Not "none" — codex can only list skills over a live child, which it does
    // not spawn until the session has something to do.
    return <p className="py-6 text-center text-body-sm text-fg-4">Skills are listed once the session connects — send a message first.</p>
  }
  if (skills.length === 0) {
    return <p className="py-6 text-center text-body-sm text-fg-4">This session found no skills.</p>
  }
  const scopes = [...new Set(skills.map((s) => s.scope ?? 'other'))]
  return (
    <div className="flex flex-col gap-4">
      {scopes.map((scope) => (
        <div key={scope}>
          <h3 className="text-label font-medium text-fg-3">{SCOPE_LABEL[scope] ?? scope}</h3>
          <ul className="mt-1 flex flex-col">
            {skills
              .filter((s) => (s.scope ?? 'other') === scope)
              .map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.name)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm text-fg-1">{s.displayName ?? s.name}</span>
                      {(s.shortDescription ?? s.description) ? (
                        <span className="block truncate text-label text-fg-4">{s.shortDescription ?? s.description}</span>
                      ) : null}
                    </span>
                    {/* Listed but switched off — a different answer from absent. */}
                    {!s.enabled ? (
                      <Badge variant="neutral" className="mt-0.5 shrink-0">
                        off
                      </Badge>
                    ) : null}
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

const SkillView = ({ skill, onUse, onUsed }: { skill: SkillInfo; onUse?: (skill: SkillInfo) => void; onUsed: () => void }) => {
  return (
    <div className="flex flex-col gap-4">
      <div>
        {skill.scope ? <DialogRow label="Scope">{SCOPE_LABEL[skill.scope] ?? skill.scope}</DialogRow> : null}
        <DialogRow label="Status">
          <Badge variant={skill.enabled ? 'success' : 'neutral'} dot>
            {skill.enabled ? 'enabled' : 'disabled'}
          </Badge>
        </DialogRow>
      </div>
      {skill.description ? (
        <div>
          <h3 className="text-label font-medium text-fg-3">Description</h3>
          {/* Verbatim: this is the text the MODEL selects on. */}
          <p className="mt-1 text-body-sm whitespace-pre-wrap text-fg-2">{skill.description}</p>
        </div>
      ) : (
        <p className="text-body-sm text-fg-4">This skill carries no description.</p>
      )}
      {onUse && skill.enabled ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onUse(skill)
              onUsed()
            }}
          >
            Use this skill
          </Button>
          <p className="mt-1.5 text-label text-fg-4">
            Writes an opening message into the composer for you to edit — it isn’t sent, and there is no command that runs a skill directly.
          </p>
        </div>
      ) : null}
    </div>
  )
}
