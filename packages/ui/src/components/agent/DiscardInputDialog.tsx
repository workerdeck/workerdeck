import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { ConfirmDiscard, DiscardConfirmText } from '../../lib/conversations.ts'
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '../ui/AlertDialog.tsx'
import { Button } from '../ui/Button.tsx'

export type DiscardConfirmation = { confirm: ConfirmDiscard; dialog: ReactNode }

export function DiscardInputDialog({ text, onAnswer }: { text?: DiscardConfirmText; onAnswer: (confirmed: boolean) => void }) {
  return (
    <AlertDialog open={text !== undefined} onOpenChange={(next) => !next && onAnswer(false)}>
      <AlertDialogContent>
        <AlertDialogTitle>{text?.title}</AlertDialogTitle>
        <AlertDialogDescription>{text?.detail}</AlertDialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button variant="destructive" onClick={() => onAnswer(true)}>
            {text?.confirm}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// One open question at a time: asking again (input that arrived meanwhile) answers the previous ask with a no.
export function useDiscardConfirmation(): DiscardConfirmation {
  const [text, setText] = useState<DiscardConfirmText | undefined>(undefined)
  const answer = useRef<((confirmed: boolean) => void) | undefined>(undefined)
  const settle = useCallback((confirmed: boolean) => {
    const resolve = answer.current
    answer.current = undefined
    setText(undefined)
    resolve?.(confirmed)
  }, [])
  const confirm = useCallback<ConfirmDiscard>(
    (next) =>
      new Promise<boolean>((resolve) => {
        answer.current?.(false)
        answer.current = resolve
        setText(next)
      }),
    [],
  )
  return { confirm, dialog: <DiscardInputDialog text={text} onAnswer={settle} /> }
}
