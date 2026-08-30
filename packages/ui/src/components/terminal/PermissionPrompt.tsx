import { useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import { toolInputPreview } from '../../lib/format.ts'
import { TerminalDiff, previewPatch } from './diff.tsx'
import { Choices, Hint, PromptInput, PromptTitle, Rule } from './prompt.tsx'
import { Blank, Row } from './row.tsx'

/**
 * The approval, as the CLI draws it. Two rules taken from the CLI:
 *
 * - A file edit renders as a diff, not its JSON payload — without line
 *   numbers, necessarily: this client has never read the file (see
 *   {@link previewPatch}).
 * - The heading is the engine's own sentence (`displayName` over `title`),
 *   never "wants to use {tool}" composed here — for codex an approval is an
 *   escalation after a sandbox refusal, and the runner already wrote the
 *   sentence that says so.
 */
export interface TerminalPermissionPromptProps {
  request: PermissionRequest
  onApprove: (requestId: string) => void
  /** `message` is fed back to the agent, which can then try something else;
   * `interrupt` also stops the turn. */
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

  const patch = previewPatch(request.input)
  const summary = toolInputPreview(request.input)
  const heading = request.displayName ?? request.title ?? 'Permission needed'
  // For a Bash approval the input preview is the command itself.
  const subject = patch?.path ?? (summary || undefined)

  // "Deny" opens the reason field rather than acting; an empty field still denies.
  const options = [
    { key: 'allow', label: 'Yes' },
    {
      key: 'deny',
      label: 'No, and tell the agent what to do differently',
      detail: denying ? (
        <PromptInput
          value={reason}
          onChange={setReason}
          onSubmit={() => deny(false)}
          onCancel={() => setDenying(false)}
          placeholder="Reason (optional) — the agent reads this and can try something else"
        />
      ) : undefined,
    },
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
      {patch ? (
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
      <Row>{request.title ?? `Do you want to proceed?`}</Row>
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
