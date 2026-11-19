import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { permissionPromptModel } from '../../lib/permission-prompt.ts'
import { shellProposalInput, shellProposalOf } from '../../lib/shell-request.ts'
import { Choices, Hint, PromptInput, PromptTitle, Rule } from './prompt.tsx'
import { Blank, Row } from './row.tsx'

type Mode = 'list' | 'edit' | 'secret' | 'deny'

const HINTS: Record<Mode, string> = {
  list: 'Enter to select · ↑/↓ to navigate · 1-4 to choose · Esc to cancel',
  edit: 'Enter to keep the edit · Shift+Enter for a new line · Esc to go back',
  secret: 'Enter to run · the value is piped to stdin and never shown to the agent · Esc to go back',
  deny: 'Enter to send · Shift+Enter for a new line · Esc to go back',
}

export interface TerminalShellProposalPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string, updatedInput?: Record<string, unknown>) => void
  onDeny: (requestId: string, message?: string, interrupt?: boolean) => void
  className?: string
}

export function TerminalShellProposalPrompt({ request, onApprove, onDeny, className }: TerminalShellProposalPromptProps) {
  const proposal = shellProposalOf(request)
  const proposed = proposal?.command ?? ''
  const [focused, setFocused] = useState(0)
  const [mode, setMode] = useState<Mode>('list')
  const [command, setCommand] = useState(proposed)
  const [draft, setDraft] = useState(proposed)
  const [secret, setSecret] = useState('')
  const [reason, setReason] = useState('')
  const model = permissionPromptModel(request)

  const run = () => onApprove(request.id, shellProposalInput(proposed, command, secret))
  const deny = (interrupt: boolean) => {
    const message = reason.trim()
    onDeny(request.id, message || undefined, interrupt || undefined)
    setReason('')
    setMode('list')
  }
  const back = () => setMode('list')

  const secretInput =
    mode === 'secret' ? (
      <Row columns={5} glyph="   ›" glyphTone="dim">
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={secret}
          placeholder="secret for stdin (hidden)"
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              run()
            }
            if (event.key === 'Escape') {
              event.stopPropagation()
              back()
            }
          }}
          className="term-input"
        />
      </Row>
    ) : undefined
  const editInput =
    mode === 'edit' ? (
      <PromptInput
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          setCommand(draft.trim() === '' ? proposed : draft)
          back()
        }}
        onCancel={back}
      />
    ) : undefined
  const reasonInput =
    mode === 'deny' ? (
      <PromptInput value={reason} onChange={setReason} onSubmit={() => deny(false)} onCancel={back} placeholder={model.denyPlaceholder} />
    ) : undefined

  const [allow, keep, stop] = model.choices
  const options = [
    { key: 'allow', label: allow.option, detail: secretInput },
    { key: 'edit', label: 'Edit the command first', detail: editInput },
    { key: 'deny', label: keep.option, detail: reasonInput },
    { key: 'stop', label: stop.option, danger: true },
  ]
  const lines = command.split('\n')

  return (
    <div
      data-slot="permission-prompt"
      className={className}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && mode === 'list') {
          event.preventDefault()
          deny(false)
        }
      }}
    >
      <Rule />
      <PromptTitle title={model.heading} />
      <Blank />
      {model.description ? <Row tone="dim">{model.description}</Row> : null}
      <Blank />
      {lines.map((line, index) => (
        <Row key={index} bold>
          {index === 0 ? `$ ${line}` : `  ${line}`}
        </Row>
      ))}
      {command !== proposed ? <Row tone="yellow">edited by you</Row> : null}
      {proposal?.secret ? <Row tone="faint">reads a secret on stdin: you type it after choosing Yes</Row> : null}
      {proposal?.noInput ? <Row tone="faint">takes no input: stdin is empty, so a prompt fails instead of waiting</Row> : null}
      <Blank />
      <Rule dashed />
      <Row>{model.question}</Row>
      <Choices
        label={model.heading}
        options={options}
        focused={focused}
        onFocus={setFocused}
        active={mode === 'list'}
        onChoose={(index) => {
          const key = options[index]?.key
          if (key === 'allow') {
            if (proposal?.secret) {
              setMode('secret')
            } else {
              run()
            }
          } else if (key === 'edit') {
            setDraft(command)
            setMode('edit')
          } else if (key === 'deny') {
            setMode('deny')
          } else if (key === 'stop') {
            deny(true)
          }
        }}
      />
      <Blank />
      <Hint>{HINTS[mode]}</Hint>
    </div>
  )
}
