import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { ShieldAlert } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'

export interface PermissionPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string) => void
  onDeny: (requestId: string, message?: string) => void
  className?: string
}

export function PermissionPrompt({ request, onApprove, onDeny, className }: PermissionPromptProps) {
  const [showInput, setShowInput] = useState(false)
  return (
    <div
      data-slot='permission-prompt'
      className={cn('rounded-lg border border-warning/40 bg-warning-bg p-3', className)}>
      <div className='flex items-start gap-2.5'>
        <ShieldAlert className='mt-0.5 size-4 shrink-0 text-warning' />
        <div className='min-w-0 flex-1'>
          <div className='text-body-sm font-medium text-fg-1'>
            {request.title ?? `Claude wants to use ${request.toolName}`}
          </div>
          {request.description ? (
            <div className='mt-0.5 text-label text-fg-3'>{request.description}</div>
          ) : null}
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
        <div className='flex shrink-0 gap-1.5'>
          <Button size='sm' onClick={() => onApprove(request.id)}>
            Allow
          </Button>
          <Button size='sm' variant='outline' onClick={() => onDeny(request.id, 'Denied by user')}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  )
}
