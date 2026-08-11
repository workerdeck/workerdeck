import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SdkSessionSummary, SessionInfo, SessionRow } from '@workerdeck/protocol'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  SessionBrowser,
  Spinner,
  formatRelativeTime,
  toast,
} from '@workerdeck/ui'
import { History, Plus, RefreshCw } from 'lucide-react'
import { RunFormFields, useRunForm } from '@/components/RunForm.tsx'
import { client } from '@/lib/client.ts'
import { useSessionRows, useSessions } from '@/lib/useSessions.ts'
import { useViewConfig } from '@/lib/useViewConfig.ts'

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
      const session = await client.createSession({
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
        await client.listSdkSessions({
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

export function SessionsView() {
  const navigate = useNavigate()
  const { sessions, error, refresh } = useSessions()
  const rows = useSessionRows(sessions)
  const [config, setConfig] = useViewConfig()
  const [creating, setCreating] = useState(false)

  const open = (id: string) =>
    void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } })

  const rename = (row: SessionRow, title: string) => {
    // A gateway edit, never a local override: the phone and the extension read
    // the same `meta.title`, so a name set here has to reach them.
    void client
      .updateSession(row.info.id, { title: title || null })
      .then(() => refresh())
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Rename failed'))
  }

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header className='flex items-end justify-between gap-3'>
          <div>
            <h1 className='text-display-sm font-semibold tracking-tight text-text'>Sessions</h1>
            <p className='mt-0.5 text-body-sm text-muted-foreground'>
              Live Agent SDK sessions on this worker.
            </p>
          </div>
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Refresh'
              onClick={() => void refresh()}>
              <RefreshCw className='size-4' />
            </Button>
            {/* The only way to create. The form used to sit under the list,
                which meant scrolling past everything to start something. */}
            <Button onClick={() => setCreating(true)}>
              <Plus className='size-4' />
              New session
            </Button>
          </div>
        </header>

        {error ? (
          <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
            Can’t reach the worker server: {error}. Start it with{' '}
            <code className='font-mono'>pnpm server</code>.
          </div>
        ) : null}

        <SessionBrowser
          rows={rows}
          config={config}
          onConfigChange={setConfig}
          onSelect={(row) => open(row.info.id)}
          onRename={rename}
          onDelete={(row) => {
            void client
              .deleteSession(row.info.id)
              .then(() => refresh())
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Delete failed'))
          }}
          emptyState={
            <div className='px-2.5 py-8 text-center text-body-sm text-fg-4'>
              No live sessions yet. Start one with <strong className='text-fg-2'>New session</strong>.
            </div>
          }
        />

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent size='lg'>
            <DialogHeader title='New session' description='Pick a directory and an engine.' />
            <DialogBody>
              <CreateSessionForm
                sessions={sessions}
                onCreated={(id) => {
                  setCreating(false)
                  open(id)
                }}
              />
            </DialogBody>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
