import type { ComponentType, ReactNode } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { cn } from '../../lib/utils.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { TerminalPermissionPrompt } from '../terminal/PermissionPrompt.tsx'
import { TerminalQuestionPrompt } from '../terminal/QuestionPrompt.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import type { TerminalAffordances } from '../terminal/affordances.tsx'

// Deliberately the built-in prompts' own callback shapes, so `PermissionPrompt` and
// `TerminalPermissionPrompt` stay drop-in fallbacks for an input a host declines to draw.
export interface ApprovalPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string, updatedInput?: Record<string, unknown>) => void
  onDeny: (requestId: string, message?: string, interrupt?: boolean) => void
}

type ApprovalPromptsProps = {
  requests: readonly PermissionRequest[]
  terminal: boolean
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  hostPrompts?: Record<string, ComponentType<ApprovalPromptProps>>
  onApprove: ApprovalPromptProps['onApprove']
  onDeny: ApprovalPromptProps['onDeny']
}

export function ApprovalPrompts({
  requests,
  terminal,
  fontSize,
  lineHeight,
  affordances,
  hostPrompts,
  onApprove,
  onDeny,
}: ApprovalPromptsProps) {
  const dismissQuestion = (id: string) => onDeny(id, 'Question dismissed by user')
  return (
    <div className={cn(terminal ? 'pb-2' : 'px-3 pb-2')}>
      <PromptSurface terminal={terminal} fontSize={fontSize} lineHeight={lineHeight} affordances={affordances}>
        {requests.map((request) => {
          // Before the variant split: a host's entry is the renderer for its tool in
          // both themes, and it overrides the built-in entries rather than racing them.
          const HostPrompt = hostPrompts?.[request.toolName]
          if (HostPrompt) {
            return <HostPrompt key={request.id} request={request} onApprove={onApprove} onDeny={onDeny} />
          }
          const isQuestion = request.toolName === 'AskUserQuestion' && parseUserQuestions(request.input).length > 0
          if (terminal) {
            return isQuestion ? (
              <TerminalQuestionPrompt key={request.id} request={request} onAnswer={onApprove} onDismiss={dismissQuestion} />
            ) : (
              <TerminalPermissionPrompt key={request.id} request={request} onApprove={onApprove} onDeny={onDeny} />
            )
          }
          return isQuestion ? (
            <QuestionPrompt key={request.id} request={request} onAnswer={onApprove} onDismiss={dismissQuestion} />
          ) : (
            <PermissionPrompt key={request.id} request={request} onApprove={onApprove} onDeny={onDeny} />
          )
        })}
      </PromptSurface>
    </div>
  )
}

type PromptSurfaceProps = {
  terminal: boolean
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  children: ReactNode
}

function PromptSurface({ terminal, fontSize, lineHeight, affordances, children }: PromptSurfaceProps) {
  if (!terminal) {
    return <div className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] flex-col gap-2">{children}</div>
  }
  return (
    <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={affordances} bleed="1ch" className="term-transcript">
      {children}
    </TerminalSurface>
  )
}
