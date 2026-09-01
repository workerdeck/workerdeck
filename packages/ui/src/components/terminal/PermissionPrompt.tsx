import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { toolInputPreview } from '../../lib/format.ts'
import { planFromRequest } from '../../lib/plan-request.ts'
import { TerminalDiff, previewPatch } from './diff.tsx'
import { TerminalMarkdown } from './markdown.tsx'
import { Choices, Hint, PromptInput, PromptTitle, Rule } from './prompt.tsx'
import { Blank, Row } from './row.tsx'

const PLAN_SCROLL = { maxHeight: 'min(24rem, 50vh)', overflowY: 'auto' } as const

export interface TerminalPermissionPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string) => void
  onDeny: (requestId: string, message?: string, interrupt?: boolean) => void
  className?: string
}

export function TerminalPermissionPrompt({ request, onApprove, onDeny, className }: TerminalPermissionPromptProps) {
  const [focused, setFocused] = useState(0)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')

  const deny = (interrupt: boolean) => {
    const message = reason.trim()
    onDeny(request.id, message || undefined, interrupt || undefined)
    setReason('')
    setDenying(false)
  }

  const plan = planFromRequest(request)
  const patch = plan ? undefined : previewPatch(request.input)
  const summary = plan ? '' : toolInputPreview(request.input)
  const heading = plan ? 'Plan ready for review' : (request.displayName ?? request.title ?? 'Permission needed')
  const subject = patch?.path ?? (summary || undefined)

  const reasonInput = denying ? (
    <PromptInput
      value={reason}
      onChange={setReason}
      onSubmit={() => deny(false)}
      onCancel={() => setDenying(false)}
      placeholder={
        plan
          ? 'What should change? (optional) — the agent keeps planning and reads this'
          : 'Reason (optional) — the agent reads this and can try something else'
      }
    />
  ) : undefined

  const options = plan
    ? [
        { key: 'allow', label: 'Approve plan' },
        { key: 'deny', label: 'Keep planning — tell it what to change', detail: reasonInput },
        { key: 'stop', label: 'No, and stop the turn', danger: true },
      ]
    : [
        { key: 'allow', label: 'Yes' },
        { key: 'deny', label: 'No, and tell the agent what to do differently', detail: reasonInput },
        { key: 'stop', label: 'No, and stop the turn', danger: true },
      ]

  return (
    <div
      data-slot="permission-prompt"
      className={className}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          deny(false)
        }
      }}
    >
      <Rule />
      <PromptTitle title={heading} subject={subject} />
      <Blank />
      {plan ? (
        <>
          <div style={PLAN_SCROLL}>
            <TerminalMarkdown>{plan}</TerminalMarkdown>
          </div>
          <Blank />
          <Rule dashed />
        </>
      ) : patch ? (
        <>
          <TerminalDiff patch={patch} />
          <Blank />
          <Rule dashed />
        </>
      ) : request.description ? (
        <>
          <Row tone="dim">{request.description}</Row>
          <Blank />
        </>
      ) : null}
      {request.decisionReason ? <Row tone="faint">{request.decisionReason}</Row> : null}
      <Row>{plan ? 'Ready to implement this plan?' : (request.title ?? `Do you want to proceed?`)}</Row>
      <Choices
        label={heading}
        options={options}
        focused={focused}
        onFocus={setFocused}
        active={!denying}
        onChoose={(index) => {
          if (index === 0) {
            onApprove(request.id)
          } else if (index === 1) {
            setDenying(true)
          } else {
            deny(true)
          }
        }}
      />
      <Blank />
      <Hint>Enter to select · ↑/↓ to navigate · 1–3 to choose · Esc to cancel</Hint>
    </div>
  )
}
