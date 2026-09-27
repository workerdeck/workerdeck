import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { toolInputPreview } from '../../lib/format.ts'
import { permissionPromptModel } from '../../lib/permission-prompt.ts'
import { shellRequestLines } from '../../lib/shell-request.ts'
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

  const model = permissionPromptModel(request)
  const { plan, shell, heading } = model
  const patch = plan || shell ? undefined : previewPatch(request.input)
  const summary = plan || shell ? '' : toolInputPreview(request.input)
  const subject = patch?.path ?? (summary || undefined)

  const reasonInput = denying ? (
    <PromptInput
      value={reason}
      onChange={setReason}
      onSubmit={() => deny(false)}
      onCancel={() => setDenying(false)}
      placeholder={model.denyPlaceholder}
    />
  ) : undefined

  const options = model.choices.map((choice) => ({
    key: choice.key,
    label: choice.option,
    danger: choice.danger,
    detail: choice.key === 'deny' ? reasonInput : undefined,
  }))

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
      ) : shell ? (
        <>
          {shellRequestLines(shell).map((line, index) => (
            <Row key={index} bold>
              {line}
            </Row>
          ))}
          <Blank />
          <Rule dashed />
        </>
      ) : patch ? (
        <>
          <TerminalDiff patch={patch} />
          <Blank />
          <Rule dashed />
        </>
      ) : model.description ? (
        <>
          <Row tone="dim">{model.description}</Row>
          <Blank />
        </>
      ) : null}
      {model.decisionReason ? <Row tone="faint">{model.decisionReason}</Row> : null}
      <Row>{model.question}</Row>
      <Choices
        label={heading}
        options={options}
        focused={focused}
        onFocus={setFocused}
        active={!denying}
        onChoose={(index) => {
          const key = model.choices[index]?.key
          if (key === 'allow') {
            onApprove(request.id)
          } else if (key === 'deny') {
            setDenying(true)
          } else if (key === 'stop') {
            deny(true)
          }
        }}
      />
      <Blank />
      <Hint>
        {denying
          ? 'Enter to send · Shift+Enter for a new line · Esc to go back'
          : 'Enter to select · ↑/↓ to navigate · 1-3 to choose · Esc to cancel'}
      </Hint>
    </div>
  )
}
