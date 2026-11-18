import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { SquareTerminal } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { cn } from '../../lib/utils.ts'
import { permissionPromptModel } from '../../lib/permission-prompt.ts'
import { shellProposalInput, shellProposalOf } from '../../lib/shell-request.ts'

export interface ShellProposalPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string, updatedInput?: Record<string, unknown>) => void
  onDeny: (requestId: string, message?: string, interrupt?: boolean) => void
  className?: string
}

export function ShellProposalPrompt({ request, onApprove, onDeny, className }: ShellProposalPromptProps) {
  const proposal = shellProposalOf(request)
  const proposed = proposal?.command ?? ''
  const [command, setCommand] = useState(proposed)
  const [secret, setSecret] = useState('')
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const model = permissionPromptModel(request)
  const [allow, keep, stop] = model.choices
  const empty = command.trim() === ''

  const run = () => {
    if (!empty) {
      onApprove(request.id, shellProposalInput(proposed, command, secret))
    }
  }
  const deny = (interrupt: boolean) => {
    const message = reason.trim()
    onDeny(request.id, message || undefined, interrupt || undefined)
    setReason('')
    setDenying(false)
  }

  return (
    <div data-slot="permission-prompt" className={cn('rounded-lg border border-warning/40 bg-warning-bg p-3', className)}>
      <div className="flex items-start gap-2.5">
        <SquareTerminal className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-body-sm font-medium text-fg-1">{model.heading}</div>
          {model.description ? <div className="mt-0.5 text-label text-fg-3">{model.description}</div> : null}
          <Textarea
            data-slot="shell-proposal-command"
            aria-label="Command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            rows={Math.min(8, command.split('\n').length)}
            spellCheck={false}
            className="mt-1.5 min-h-0 bg-code-bg font-mono text-body-sm text-fg-1"
          />
          {command !== proposed ? (
            <button type="button" className="mt-1 text-label text-fg-3 underline-offset-2 hover:underline" onClick={() => setCommand(proposed)}>
              Edited by you - reset to the agent's command
            </button>
          ) : null}
          {proposal?.secret ? (
            <div className="mt-2">
              <Input
                data-slot="shell-proposal-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    run()
                  }
                }}
                placeholder="Secret for stdin (hidden)"
                className="h-7"
              />
              <div className="mt-0.5 text-label text-fg-4">Piped to the command's stdin; never shown to the agent or kept in the transcript.</div>
            </div>
          ) : null}
          <div className="mt-1.5 text-label text-fg-4">{model.question}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Button size="sm" disabled={empty} onClick={run}>
            {allow.button}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDenying((v) => !v)}>
            {keep.button}
          </Button>
          <Button size="sm" variant="outline" onClick={() => deny(true)}>
            {stop.button}
          </Button>
        </div>
      </div>
      {denying ? (
        <div className="mt-2.5 flex items-center gap-2 border-t border-warning/30 pt-2.5">
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                deny(false)
              }
              if (e.key === 'Escape') {
                setDenying(false)
              }
            }}
            placeholder={model.denyPlaceholder}
            className="h-7 flex-1"
          />
          <Button size="sm" variant="outline" onClick={() => setDenying(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" onClick={() => deny(false)}>
            {keep.button}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
