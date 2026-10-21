import { errorMessage } from '@workerdeck/protocol'
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, Button, toast } from '@workerdeck/ui'
import { clientFor } from '@/lib/hosts.ts'

export type DeleteAgentTarget = { hostId: string; agentId: string; name: string; conversation: number }

export function deleteAgentText(name: string): string {
  return `${name} leaves your agents. Its conversations stay under Past agents. Team members are released.`
}

// `sessionId` is the conversation the person was looking at: the gateway refuses the delete if the agent already left it.
export function DeleteAgentDialog({
  target,
  onClose,
  onDeleted,
}: {
  target?: DeleteAgentTarget
  onClose: () => void
  onDeleted?: () => void
}) {
  const confirm = () => {
    const chosen = target
    onClose()
    const client = chosen && clientFor(chosen.hostId)
    if (!chosen || !client) {
      return
    }
    client
      .retireAgent(chosen.agentId, { expectedGeneration: chosen.conversation })
      .then(() => onDeleted?.())
      .catch((e: unknown) => toast.error(errorMessage(e, 'Could not delete the agent')))
  }
  return (
    <AlertDialog open={target !== undefined} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete {target?.name ?? 'this agent'}?</AlertDialogTitle>
        <AlertDialogDescription>{deleteAgentText(target?.name ?? 'The agent')}</AlertDialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button variant="destructive" onClick={confirm}>
            Delete agent
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
