import { useState } from 'react'
import type { SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Empty,
  EmptyKey,
  Spinner,
  formatRelativeTime,
  toast,
} from '@workerdeck/ui'
import { History, Plus } from 'lucide-react'
import { RunFormFields, useRunForm } from '@/components/RunForm.tsx'
import { BrandMark } from '@/components/shell/BrandMark.tsx'
import { client } from '@/lib/client.ts'

function CreateSessionForm({
  sessions,
  onCreated,
}: {
  sessions: SessionInfo[]
  onCreated: (id: string) => void
}) {
  const form = useRunForm('session')
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
      const session = await client()!.createSession({
        ...form.sessionFields({
          prompt: resume ? undefined : form.prompt.trim() || undefined,
          resume: resume?.sessionId,
          // An interactive session pre-authorizes the switch because the
          // operator is present — the CLI refuses it mid-session otherwise.
          allowBypass: true,
        }),
        // A resumed session runs where it was stored, not where the form points.
        cwd: dir,
      })
      onCreated(session.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create session')
    } finally {
      setCreating(false)
    }
  }

  const loadSdkSessions = async () => {
    if (!form.cwd.trim()) {
      toast.error('Set a working directory first — resumable sessions are listed per project')
      return
    }
    setLoadingSdk(true)
    try {
      // Named so the server lists the CHOSEN profile's engine store (codex
      // threads vs Agent SDK sessions) rather than the legacy claude default.
      setSdkSessions(
        await client()!.listSdkSessions({
          dir: form.cwd.trim(),
          limit: 20,
          profile: form.profile || undefined,
        }),
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to list resumable sessions')
    } finally {
      setLoadingSdk(false)
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      <RunFormFields
        form={form}
        sessions={sessions}
        promptLabel='Initial prompt (optional)'
        // The list is per-profile (per-engine store) — another profile's rows
        // would offer resumes this engine can't honor.
        onProfileChange={() => setSdkSessions(undefined)}
        actions={
          <Button className='ml-auto' onClick={() => void create()} disabled={creating}>
            {creating ? <Spinner className='size-3.5 text-current' /> : <Plus className='size-4' />}
            Create
          </Button>
        }
      />

      {/* Resume is a peer of create, not a footnote: same directory, same
          profile, diverging only at the last step. The engine needs a browsable
          session store for it to mean anything. */}
      {!engine.capabilities.listSessions ? null : (
        <div className='mt-1 border-t border-border pt-3'>
          <div className='flex items-center justify-between'>
            <span className='text-label font-medium text-fg-3'>Resume a previous session</span>
            <Button
              variant='ghost'
              size='xs'
              onClick={() => void loadSdkSessions()}
              disabled={loadingSdk}>
              {loadingSdk ? (
                <Spinner className='size-3 text-current' />
              ) : (
                <History className='size-3' />
              )}
              {sdkSessions ? 'Reload' : 'Browse'}
            </Button>
          </div>
          {sdkSessions !== undefined ? (
            sdkSessions.length === 0 ? (
              <div className='py-3 text-center text-body-sm text-fg-4'>
                No stored sessions for this directory.
              </div>
            ) : (
              <ul className='mt-2 flex flex-col gap-1'>
                {sdkSessions.map((s) => (
                  <li
                    key={s.sessionId}
                    className='flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover'>
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-body-sm text-fg-1'>
                        {s.customTitle ?? s.summary}
                      </div>
                      <div className='flex gap-2 font-mono text-label text-fg-4'>
                        {s.gitBranch ? <span className='truncate'>{s.gitBranch}</span> : null}
                        <span className='shrink-0'>{formatRelativeTime(s.lastModified)}</span>
                      </div>
                    </div>
                    <Button
                      variant='outline'
                      size='xs'
                      onClick={() => void create(s)}
                      disabled={creating}>
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

/**
 * The create-session dialog, owned by whoever raises it.
 *
 * Extracted because the `+` that opens it now lives in the sessions sidebar
 * (which is shell, not route) while the form itself belongs beside the rest of
 * the session-creation code.
 */
export function CreateSessionDialog({
  open,
  onOpenChange,
  sessions,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionInfo[]
  onCreated: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='lg'>
        <DialogHeader title='New session' description='Pick a directory and an engine.' />
        <DialogBody>
          <CreateSessionForm sessions={sessions} onCreated={onCreated} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What fills the editor area when no session is open.
 *
 * The list itself is the sidebar now, so this route has nothing to list — it is
 * VS Code's empty editor group: says where you are and points at the one control
 * that does something.
 */
export function SessionsView() {
  return (
    <div className='flex flex-1 items-center justify-center p-8'>
      <Empty
        icon={<BrandMark />}
        title='No session open'
        description={
          <>
            Pick one on the left, or start a new one with <EmptyKey>+</EmptyKey> above.
          </>
        }
      />
    </div>
  )
}
