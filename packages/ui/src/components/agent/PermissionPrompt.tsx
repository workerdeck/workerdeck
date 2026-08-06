import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { Hand } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { cn } from '../../lib/utils.ts'
import { toolInputPreview } from '../../lib/format.ts'
import { toolIcon } from '../../lib/tool-icon.ts'

export interface PermissionPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string) => void
  /** `message` is fed back to the agent, which can then try something else;
   * `interrupt` also stops the turn. */
  onDeny: (requestId: string, message?: string, interrupt?: boolean) => void
  className?: string
}

/**
 * Generic allow/deny prompt for a pending permission request.
 *
 * Three outcomes, not two: denying usually means "not that, try something else",
 * so plain Deny lets the turn continue (with an optional reason the agent reads)
 * while "Deny & stop" also interrupts.
 *
 * The heading is whatever the engine authored — `title`, else `displayName`.
 * Composing "wants to use {tool}" instead would be wrong for codex, where an
 * approval is usually an *escalation after a sandbox refusal* and the runner has
 * already written the sentence that says so.
 */
export function PermissionPrompt({ request, onApprove, onDeny, className }: PermissionPromptProps) {
  const [showInput, setShowInput] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')

  const deny = (interrupt: boolean) => {
    const message = reason.trim()
    onDeny(request.id, message || undefined, interrupt || undefined)
    setReason('')
    setDenying(false)
  }

  const summary = toolInputPreview(request.input)
  const ToolIcon = toolIcon(request.toolName)

  return (
    <div
      data-slot='permission-prompt'
      className={cn('rounded-lg border border-warning/40 bg-warning-bg p-3', className)}>
      <div className='flex items-start gap-2.5'>
        <Hand className='mt-0.5 size-4 shrink-0 text-warning' />
        <div className='min-w-0 flex-1'>
          <div className='text-body-sm font-medium text-fg-1'>
            {request.title ?? request.displayName ?? 'Permission needed'}
          </div>
          {request.description ? (
            <div className='mt-0.5 text-label text-fg-3'>{request.description}</div>
          ) : null}
          {request.decisionReason ? (
            <div className='mt-0.5 text-label text-fg-4'>{request.decisionReason}</div>
          ) : null}
          <div className='mt-1.5 flex min-w-0 items-center gap-2'>
            <ToolIcon className='size-3 shrink-0 text-fg-3' />
            <span className='shrink-0 font-mono text-label font-medium text-fg-2'>
              {request.toolName}
            </span>
            {summary ? (
              <span className='min-w-0 truncate font-mono text-label text-fg-4'>{summary}</span>
            ) : null}
          </div>
          <button
            type='button'
            className='mt-1 font-mono text-label text-fg-3 underline-offset-2 hover:underline'
            onClick={() => setShowInput((v) => !v)}>
            {showInput ? 'Hide' : 'Show'} {request.toolName} input
          </button>
          {showInput ? (
            <pre className='mt-1.5 max-h-48 overflow-auto rounded-md bg-code-bg px-2.5 py-1.5 font-mono text-label whitespace-pre-wrap text-fg-2'>
              {JSON.stringify(request.input, null, 2)}
            </pre>
          ) : null}
        </div>
        <div className='flex shrink-0 flex-wrap justify-end gap-1.5'>
          <Button size='sm' onClick={() => onApprove(request.id)}>
            Allow
          </Button>
          <Button size='sm' variant='outline' onClick={() => setDenying((v) => !v)}>
            Deny
          </Button>
          <Button size='sm' variant='outline' onClick={() => deny(true)}>
            Deny &amp; stop
          </Button>
        </div>
      </div>
      {denying ? (
        <div className='mt-2.5 flex items-center gap-2 border-t border-warning/30 pt-2.5'>
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') deny(false)
              if (e.key === 'Escape') setDenying(false)
            }}
            placeholder='Reason (optional) — the agent reads this and can try something else'
            className='h-7 flex-1'
          />
          <Button size='sm' variant='outline' onClick={() => setDenying(false)}>
            Cancel
          </Button>
          <Button size='sm' variant='destructive' onClick={() => deny(false)}>
            Deny
          </Button>
        </div>
      ) : null}
    </div>
  )
}
