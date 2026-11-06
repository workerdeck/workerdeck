import { useState } from 'react'
import {
  GOAL_TEXT_MAX,
  goalBudgetChange,
  readGoalInput,
  type GoalCapabilities,
  type GoalInput,
  type SessionGoal,
} from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { Input } from '../ui/Input.tsx'
import { Textarea } from '../ui/Textarea.tsx'

export interface GoalDialogProps {
  open: boolean
  capabilities: GoalCapabilities | undefined
  goal?: SessionGoal | null
  name?: string
  onClose: () => void
  onSave: (goal: GoalInput) => void
}

export function GoalDialog({ open, capabilities, goal, name, onClose, onSave }: GoalDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={goal ? 'Replace goal' : 'Set goal'} description={name} />
        <DialogBody>
          {open ? <GoalForm capabilities={capabilities} goal={goal ?? undefined} onClose={onClose} onSave={onSave} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function GoalForm({
  capabilities,
  goal,
  onClose,
  onSave,
}: {
  capabilities: GoalCapabilities | undefined
  goal?: SessionGoal
  onClose: () => void
  onSave: (goal: GoalInput) => void
}) {
  const [text, setText] = useState(goal?.text ?? '')
  const [budget, setBudget] = useState(goal?.tokenBudget === undefined ? '' : String(goal.tokenBudget))
  const [error, setError] = useState<string>()
  const budgeted = capabilities?.budget === true
  const submit = () => {
    const tokenBudget = budgeted ? goalBudgetChange(budget, goal?.tokenBudget) : undefined
    const input = readGoalInput({ text, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, capabilities)
    if (typeof input === 'string') {
      setError(input.replace(/^goal\.(text|tokenBudget) /, (_, field: string) => (field === 'text' ? 'The goal ' : 'The token budget ')))
      return
    }
    onSave(input)
    onClose()
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Textarea
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="When is the work done? e.g. all tests in packages/core pass"
        aria-label="Goal"
        maxLength={GOAL_TEXT_MAX}
        spellCheck={false}
      />
      {budgeted ? (
        <label className="flex flex-col gap-1 text-label text-fg-3">
          Token budget
          <Input
            inputMode="numeric"
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value.replace(/[^\d]/g, ''))
              setError(undefined)
            }}
            placeholder="No budget"
          />
        </label>
      ) : null}
      {error ? <p className="text-label text-danger">{error}</p> : null}
      <p className="text-label text-fg-4">
        The agent keeps working, turn after turn, until the goal is met.
        {budgeted ? ' The engine stops at the token budget.' : ' Each turn ends with a check against it.'}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!text.trim()}>
          {goal ? 'Replace goal' : 'Set goal'}
        </Button>
      </div>
    </form>
  )
}
