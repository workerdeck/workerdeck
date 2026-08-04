import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { SessionInfo } from '@workerdeck/protocol'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  CopyButton,
  SessionPanel,
  toast,
} from '@workerdeck/ui'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { client } from '@/lib/client.ts'

export function SessionView() {
  const { sessionId } = useParams({ from: '/sessions/$sessionId' })
  const navigate = useNavigate()
  const [info, setInfo] = useState<SessionInfo | undefined>()

  useEffect(() => {
    let cancelled = false
    client
      .getSession(sessionId)
      .then((s) => {
        if (!cancelled) setInfo(s)
      })
      .catch(() => {
        toast.error('Session not found')
        void navigate({ to: '/sessions' })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, navigate])

  const close = async () => {
    try {
      await client.deleteSession(sessionId)
    } catch {
      // already gone
    }
    void navigate({ to: '/sessions' })
  }

  return (
    <SessionPanel
      key={sessionId}
      client={client}
      sessionId={sessionId}
      header={
        <div className='flex items-center gap-2 border-b border-border bg-surface px-3 py-2'>
          <Link to='/sessions' aria-label='Back to sessions'>
            <Button variant='ghost' size='icon-sm'>
              <ArrowLeft className='size-4' />
            </Button>
          </Link>
          <span className='truncate text-body-sm font-medium text-fg-1'>
            {info?.title ?? sessionId.slice(0, 8)}
          </span>
          {info?.cwd ? (
            <span className='truncate font-mono text-label text-fg-4'>{info.cwd}</span>
          ) : null}
          <span className='flex-1' />
          <CopyButton value={sessionId} aria-label='Copy session id' />
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant='ghost' size='icon-sm' aria-label='Close session'>
                  <Trash2 className='size-4 text-fg-3' />
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogTitle>Close this session?</AlertDialogTitle>
              <AlertDialogDescription>
                The Claude Code subprocess is terminated. You can resume it later from
                “Resume a previous session” (the transcript is kept on disk by the SDK).
              </AlertDialogDescription>
              <div className='mt-4 flex justify-end gap-2'>
                <AlertDialogClose render={<Button variant='outline'>Cancel</Button>} />
                <Button variant='destructive' onClick={() => void close()}>
                  Close session
                </Button>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      }
    />
  )
}
