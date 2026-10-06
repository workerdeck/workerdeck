import { useState } from 'react'
import { AGENT_SLEEP_AFTER_MS_DEFAULT, errorMessage, type SessionInfo, type SessionRow } from '@workerdeck/protocol'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Input,
  PermissionModeSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  toast,
} from '@workerdeck/ui'
import { UserPlus } from 'lucide-react'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { ProfileSelect } from '@/components/ProfileSelect.tsx'
import { CwdField, EffortField, useRunForm, type RunTarget } from '@/components/RunForm.tsx'
import { client } from '@/lib/client.ts'
import { clientFor } from '@/lib/hosts.ts'

const NO_TEAM = 'none'
const SLEEP_MINUTES = AGENT_SLEEP_AFTER_MS_DEFAULT / 60_000

export interface NewAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionInfo[]
  leads: SessionRow[]
  target?: RunTarget
  gatewayName?: string
  onCreated: (sessionId: string) => void
  onOneOff: (target: RunTarget) => void
}

export function NewAgentDialog({
  open,
  onOpenChange,
  sessions,
  leads,
  target = {},
  gatewayName,
  onCreated,
  onOneOff,
}: NewAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={gatewayName ? `New agent on ${gatewayName}` : 'New agent'}
          description="A named, long-lived session with an avatar and a standing brief that survives every new conversation."
        />
        <DialogBody>
          <NewAgentForm
            key={`${target.hostId ?? ''}:${target.cwd ?? ''}`}
            sessions={sessions}
            leads={leads}
            target={target}
            onCreated={onCreated}
            onCancel={() => onOpenChange(false)}
            onOneOff={onOneOff}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function NewAgentForm({
  sessions,
  leads,
  target,
  onCreated,
  onCancel,
  onOneOff,
}: {
  sessions: SessionInfo[]
  leads: SessionRow[]
  target: RunTarget
  onCreated: (sessionId: string) => void
  onCancel: () => void
  onOneOff: (target: RunTarget) => void
}) {
  const form = useRunForm('session', target)
  const { engine } = form
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [contextReset, setContextReset] = useState(true)
  const [sleeps, setSleeps] = useState(true)
  const [lead, setLead] = useState(NO_TEAM)
  const [creating, setCreating] = useState(false)
  const trimmed = name.trim()

  const create = async () => {
    const fields = form.sessionFields({ prompt: form.prompt.trim() || undefined })
    if (engine.capabilities.hostCwd !== false && !fields.cwd) {
      toast.error('Project directory is required')
      return
    }
    const gateway = target.hostId === undefined ? client() : clientFor(target.hostId)
    if (!gateway) {
      return
    }
    setCreating(true)
    try {
      if (fields.cwd) {
        form.rememberCwd(fields.cwd)
      }
      const created = await gateway.createAgent({
        name: trimmed || undefined,
        config: {
          cwd: fields.cwd,
          profile: fields.profile,
          model: fields.model,
          reasoningEffort: fields.reasoningEffort,
          permissionMode: fields.permissionMode,
          brief: brief.trim() || undefined,
          agentContextReset: contextReset ? undefined : false,
          sleepAfterMs: sleeps ? undefined : 0,
        },
        prompt: fields.prompt,
        lead: lead === NO_TEAM ? undefined : lead,
      })
      if (!created.session) {
        throw new Error('The gateway created the agent without a session')
      }
      onCreated(created.session.id)
    } catch (e) {
      toast.error(errorMessage(e, 'Failed to create the agent'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-label font-medium text-fg-3">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty for a suggested name" spellCheck={false} />
      </label>
      <CwdField form={form} sessions={sessions} label="Project" />
      <div className="flex flex-wrap items-end gap-3">
        <ProfileSelect profiles={form.profiles} value={form.profile} onChange={form.selectProfile} className="min-w-32" />
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-label font-medium text-fg-3">Permission mode</span>
          <PermissionModeSelect variant="form" mode={engine.mode} onModeChange={form.setMode} modes={engine.modes} className="min-w-44" />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-label font-medium text-fg-3">Model</span>
          <ModelPicker value={engine.model} onChange={form.setModel} models={engine.models} className="min-w-40" />
        </label>
        <EffortField form={form} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-label font-medium text-fg-3">Standing brief (optional, survives every new conversation)</span>
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="e.g. You own the iOS client. Keep it in parity with protocol."
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-label font-medium text-fg-3">First prompt (optional)</span>
        <Textarea value={form.prompt} onChange={(e) => form.setPrompt(e.target.value)} rows={2} placeholder="Leave empty to start idle" />
      </label>
      <div className="flex flex-col gap-2">
        <Toggle checked={contextReset} onChange={setContextReset}>
          Manages its own context <span className="text-fg-4">(context_reset)</span>
        </Toggle>
        <Toggle checked={sleeps} onChange={setSleeps}>
          Sleeps when idle after {SLEEP_MINUTES} min
        </Toggle>
        {leads.length ? (
          <label className="flex items-center gap-2 text-body-sm text-fg-2">
            <span>Join a team</span>
            <Select
              items={[
                { value: NO_TEAM, label: 'None' },
                ...leads.map((row) => ({ value: row.info.agent!.id, label: row.info.agent!.name })),
              ]}
              value={lead}
              onValueChange={(value) => setLead(String(value))}
            >
              <SelectTrigger className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEAM}>
                  <SelectItemText>None</SelectItemText>
                </SelectItem>
                {leads.map((row) => (
                  <SelectItem key={row.info.agent!.id} value={row.info.agent!.id}>
                    <SelectItemText>{row.info.agent!.leads ? `${row.info.agent!.name} (team)` : row.info.agent!.name}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2 border-t border-border pt-3">
        <Button
          variant="link"
          size="sm"
          className="px-0 text-fg-3"
          onClick={() => onOneOff({ hostId: target.hostId, cwd: form.cwd.trim() || target.cwd })}
        >
          One-off session instead
        </Button>
        <span className="flex-1" />
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => void create()} disabled={creating}>
          {creating ? <Spinner className="size-3.5 text-current" /> : <UserPlus className="size-4" />}
          {trimmed ? `Create ${trimmed}` : 'Create agent'}
        </Button>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2 text-body-sm text-fg-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-(--color-fg-1)" />
      {children}
    </label>
  )
}
