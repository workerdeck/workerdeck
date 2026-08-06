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
  Badge,
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

  // The project name, like the iOS app's navigation title — the full path is a
  // line of monospace nobody reads, and it is one tap away in Session info.
  const project = info?.cwd?.split('/').filter(Boolean).pop()

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
            {info?.title ?? project ?? sessionId.slice(0, 8)}
          </span>
          {/* Which engine is answering — the one session-level fact that changes
              what every other control means. */}
          {info?.engine && info.engine !== 'claude' ? (
            <Badge variant='neutral' className='shrink-0'>
              {info.engine}
            </Badge>
          ) : null}
          {info?.cwd ? (
            <span className='min-w-0 truncate font-mono text-label text-fg-4' title={info.cwd}>
              {info.cwd}
            </span>
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
                The run is terminated on the server. You can pick it up later from “Resume a
                previous session” — the transcript is kept by the engine, not by the gateway.
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
