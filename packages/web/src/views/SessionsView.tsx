import { errorMessage } from '@workerdeck/protocol'
import { useState } from 'react'
import type { SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import { Button, Dialog, DialogBody, DialogContent, DialogHeader, Empty, Spinner, formatRelativeTime, toast } from '@workerdeck/ui'
import { History, Plus } from 'lucide-react'
import { QuestionsField, RunFormFields, useRunForm, type RunTarget } from '@/components/RunForm.tsx'
import { BrandMark } from '@/components/shell/BrandMark.tsx'
import { client } from '@/lib/client.ts'
import { clientFor } from '@/lib/hosts.ts'

function CreateSessionForm({
  sessions,
  target,
  onCreated,
}: {
  sessions: SessionInfo[]
  target: RunTarget
  onCreated: (id: string) => void
}) {
  const form = useRunForm('session', target)
  const gateway = () => (target.hostId === undefined ? client() : clientFor(target.hostId))
  const [creating, setCreating] = useState(false)
  const [sdkSessions, setSdkSessions] = useState<SdkSessionSummary[] | undefined>()
  const [loadingSdk, setLoadingSdk] = useState(false)
  const { engine } = form

  const create = async (resume?: SdkSessionSummary) => {
    const dir = resume?.cwd ?? form.cwd.trim()
    if (!dir) {
      toast.error('Working directory is required')
      return
    }
    setCreating(true)
    try {
      form.rememberCwd(dir)
      const session = await gateway()!.createSession({
        ...form.sessionFields({
          prompt: resume ? undefined : form.prompt.trim() || undefined,
          resume: resume?.sessionId,
          allowBypass: true,
        }),
        // A resumed session runs where it was stored, not where the form currently points.
        cwd: dir,
      })
      onCreated(session.id)
    } catch (e) {
      toast.error(errorMessage(e, 'Failed to create session'))
    } finally {
      setCreating(false)
    }
  }

  const loadSdkSessions = async () => {
    if (!form.cwd.trim()) {
      toast.error('Set a working directory first - resumable sessions are listed per project')
      return
    }
    setLoadingSdk(true)
    try {
      // Named, so the server lists the chosen profile's engine store rather than claude's.
      setSdkSessions(
        await gateway()!.listSdkSessions({
          dir: form.cwd.trim(),
          limit: 20,
          profile: form.profile || undefined,
        }),
      )
    } catch (e) {
      toast.error(errorMessage(e, 'Failed to list resumable sessions'))
    } finally {
      setLoadingSdk(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <RunFormFields
        form={form}
        sessions={sessions}
        promptLabel="Initial prompt (optional)"
        // Per-profile, because another profile's rows would offer resumes this engine cannot honor.
        onProfileChange={() => setSdkSessions(undefined)}
        extras={<QuestionsField form={form} />}
        actions={
          <Button className="ml-auto" onClick={() => void create()} disabled={creating}>
            {creating ? <Spinner className="size-3.5 text-current" /> : <Plus className="size-4" />}
            Create
          </Button>
        }
      />

      {!engine.capabilities.listSessions ? null : (
        <div className="mt-1 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-label font-medium text-fg-3">Resume a previous session</span>
            <Button variant="ghost" size="xs" onClick={() => void loadSdkSessions()} disabled={loadingSdk}>
              {loadingSdk ? <Spinner className="size-3 text-current" /> : <History className="size-3" />}
              {sdkSessions ? 'Reload' : 'Browse'}
            </Button>
          </div>
          {sdkSessions !== undefined ? (
            sdkSessions.length === 0 ? (
              <div className="py-3 text-center text-body-sm text-fg-4">No stored sessions for this directory.</div>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {sdkSessions.map((s) => (
                  <li key={s.sessionId} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm text-fg-1">{s.customTitle ?? s.summary}</div>
                      <div className="flex gap-2 font-mono text-label text-fg-4">
                        {s.gitBranch ? <span className="truncate">{s.gitBranch}</span> : null}
                        <span className="shrink-0">{formatRelativeTime(s.lastModified)}</span>
                      </div>
                    </div>
                    <Button variant="outline" size="xs" onClick={() => void create(s)} disabled={creating}>
                      Resume
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      )}
    </div>
  )
}

// `target` pins the gateway (and prefills the directory) when a session is started from a project heading.
export function CreateSessionDialog({
  open,
  onOpenChange,
  sessions,
  target = {},
  gatewayName,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionInfo[]
  target?: RunTarget
  gatewayName?: string
  onCreated: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={gatewayName ? `New session on ${gatewayName}` : 'New session'} description="Pick a directory and an engine." />
        <DialogBody>
          <CreateSessionForm key={`${target.hostId ?? ''}:${target.cwd ?? ''}`} sessions={sessions} target={target} onCreated={onCreated} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function SessionsView() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Empty
        icon={<BrandMark />}
        title="No session open"
        description="Pick one on the left, or start a new agent or session from the buttons above it."
      />
    </div>
  )
}
