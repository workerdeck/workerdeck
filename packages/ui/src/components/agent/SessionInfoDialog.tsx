import type { WorkerDeckClient } from '@workerdeck/client'
import { useAsync, type TranscriptState } from '@workerdeck/react'
import { Download } from 'lucide-react'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogRow } from '../ui/Dialog.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { formatBytes, formatCost, formatRelativeTime } from '../../lib/format.ts'
import { permissionModeMeta } from './PermissionModeSelect.tsx'

export interface SessionInfoDialogProps {
  state: TranscriptState
  client: WorkerDeckClient
  sessionId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}

export interface SessionInfoPanelProps {
  state: TranscriptState
  client: WorkerDeckClient
  sessionId: string | undefined
  active?: boolean
}

export function SessionInfoDialog({ state, client, sessionId, open, onOpenChange }: SessionInfoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Session info" description={state.session?.title} />
        <DialogBody>
          <SessionInfoPanel state={state} client={client} sessionId={sessionId} active={open} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function SessionInfoPanel({ state, client, sessionId, active = true }: SessionInfoPanelProps) {
  const session = state.session
  const mode = state.permissionMode ? permissionModeMeta(state.permissionMode) : undefined
  return (
    <div className="flex flex-col divide-y divide-border">
      <div className="pb-2">
        <DialogRow label="Engine">{state.engine ?? 'claude'}</DialogRow>
        {session?.profile ? <DialogRow label="Profile">{session.profile}</DialogRow> : null}
        {state.model ? (
          <DialogRow label="Model" mono>
            {state.model}
          </DialogRow>
        ) : null}
        {mode ? <DialogRow label="Permission mode">{mode.label}</DialogRow> : null}
        {session?.apiKeySource ? <DialogRow label="Credentials">{session.apiKeySource}</DialogRow> : null}
      </div>
      <div className="py-2">
        {state.cwd ? <CopyRow label="Working directory" value={state.cwd} /> : null}
        {state.sdkSessionId ? <CopyRow label="Engine session id" value={state.sdkSessionId} /> : null}
        {session ? <CopyRow label="Gateway session id" value={session.id} /> : null}
      </div>
      <div className="py-2">
        {session?.createdAt ? <DialogRow label="Started">{formatRelativeTime(session.createdAt)}</DialogRow> : null}
        {session?.numTurns !== undefined ? <DialogRow label="Turns">{session.numTurns}</DialogRow> : null}
        <DialogRow label="Cost" mono>
          {formatCost(state.costUsd ?? (state.totalCostUsd || undefined))}
        </DialogRow>
      </div>
      {state.capabilities.vfs ? <SessionFiles client={client} sessionId={sessionId} active={active} /> : null}
    </div>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-label text-fg-3">{label}</div>
        <div className="mt-0.5 font-mono text-label break-all text-fg-1">{value}</div>
      </div>
      <CopyButton value={value} aria-label={`Copy ${label.toLowerCase()}`} />
    </div>
  )
}

function SessionFiles({ client, sessionId, active }: { client: WorkerDeckClient; sessionId: string | undefined; active: boolean }) {
  const { data: files, loading } = useAsync(() => client.listSessionFiles(sessionId!), [client, sessionId], {
    enabled: active && !!sessionId,
  })

  return (
    <div className="pt-3">
      <h3 className="text-label font-medium text-fg-3">Files</h3>
      {loading ? (
        <div className="py-3 text-center">
          <Spinner className="size-4 text-fg-4" />
        </div>
      ) : !files?.length ? (
        <p className="py-2 text-body-sm text-fg-4">Nothing delivered yet.</p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {files.map((file) => (
            <li key={file.path}>
              <a
                href={sessionId ? client.sessionFileUrl(sessionId, file.path) : undefined}
                className="flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-surface-hover"
              >
                <Download className="size-3.5 shrink-0 text-fg-4" />
                <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-1">{file.path}</span>
                <span className="shrink-0 text-label text-fg-4">{formatBytes(file.bytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
