import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { PROVIDER_PERMISSION_MODES } from '@workerdeck/protocol'
import { useClaudeSession, useToolCallHost } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { Composer } from './Composer.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionModeSelect } from './PermissionModeSelect.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'

export interface SessionPanelProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  /** Optional slot rendered at the top, above the status bar. */
  header?: ReactNode
  className?: string
}

/**
 * The all-in-one embeddable session surface: status bar, streaming transcript,
 * permission prompts, composer. Attaches via useClaudeSession; remount (key) to switch
 * sessions.
 */
export function SessionPanel({ client, sessionId, header, className }: SessionPanelProps) {
  // Rejected commands (the CLI refusing a permission-mode switch, say) render INSIDE
  // the panel rather than through `toast`. The panel does not mount a `Toaster`, and
  // an embedder that doesn't either would drop the only signal that a command failed
  // — the select would just "not stick". An error channel a host can lose by omission
  // is not an error channel.
  const [protocolError, setProtocolError] = useState<string | undefined>(undefined)
  const { state, connected, handle, send, approve, deny, interrupt, setModel, setPermissionMode } =
    useClaudeSession(client, sessionId, { onProtocolError: setProtocolError })
  // Callers are told to remount on a session switch, but a changed prop must not leave
  // the previous session's failure on screen.
  useEffect(() => setProtocolError(undefined), [sessionId])
  // Host server-bridged tool calls (provider-engine sessions) in this tab, on the
  // SAME handle the panel attached with — the bridge asks the first attached
  // client. Free for Claude sessions: the guest loads lazily on the first call,
  // which for them never comes.
  useToolCallHost(handle)
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'

  // "/model" is handled panel-side (see handleSend) — surface it in the autocomplete
  // even though the CLI's command list doesn't include it.
  const commands = useMemo(() => {
    if (!state.commands) return undefined
    if (state.commands.some((c) => c.name === 'model')) return state.commands
    return [
      { name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' },
      ...state.commands,
    ]
  }, [state.commands])

  // "/model <id>" switches the model directly instead of going to the CLI.
  const handleSend = (text: string) => {
    const modelCommand = /^\/model\s+(\S+)$/.exec(text)
    if (modelCommand) {
      setModel(modelCommand[1])
      return
    }
    send(text)
  }

  return (
    <div
      data-slot='session-panel'
      className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}>
      {header}
      <StatusBar state={state} connected={connected} />
      {protocolError ? (
        <div className='px-3 pt-2'>
          <div
            role='alert'
            className='mx-auto flex w-full max-w-3xl items-start gap-2 rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-body-sm text-danger'>
            <span className='min-w-0 flex-1 break-words'>{protocolError}</span>
            <button
              type='button'
              onClick={() => setProtocolError(undefined)}
              aria-label='Dismiss error'
              className='shrink-0 opacity-70 transition-opacity hover:opacity-100'>
              ✕
            </button>
          </div>
        </div>
      ) : null}
      <Transcript
        state={state}
        fileUrl={sessionId ? (path) => client.sessionFileUrl(sessionId, path) : undefined}
        attachmentUrl={sessionId ? (id) => client.attachmentUrl(sessionId, id) : undefined}
      />
      {state.pendingApprovals.length > 0 ? (
        <div className='px-3 pb-2'>
          <div className='mx-auto flex w-full max-w-3xl flex-col gap-2'>
            {state.pendingApprovals.map((request) =>
              request.toolName === 'AskUserQuestion' &&
              parseUserQuestions(request.input).length > 0 ? (
                <QuestionPrompt
                  key={request.id}
                  request={request}
                  onAnswer={approve}
                  onDismiss={deny}
                />
              ) : (
                <PermissionPrompt
                  key={request.id}
                  request={request}
                  onApprove={approve}
                  onDeny={deny}
                />
              ),
            )}
          </div>
        </div>
      ) : null}
      <Composer
        onSend={handleSend}
        onInterrupt={interrupt}
        busy={busy}
        disabled={ended || !sessionId}
        commands={commands}
        toolbar={
          <>
            {state.models?.length ? (
              <ModelSelect
                models={state.models}
                model={state.model}
                onModelChange={setModel}
                disabled={ended}
              />
            ) : null}
            {state.permissionMode ? (
              <PermissionModeSelect
                mode={state.permissionMode}
                onModeChange={setPermissionMode}
                // A provider session rejects the CLI-only modes with a
                // protocol_error — don't offer what can only fail.
                modes={state.engine === 'provider' ? PROVIDER_PERMISSION_MODES : undefined}
                disabled={ended}
              />
            ) : null}
          </>
        }
      />
    </div>
  )
}
