import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { errorMessage, type ConnectAccountResponse, type ProfileInfo } from '@workerdeck/protocol'
import { ExternalLink } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { Input } from '../ui/Input.tsx'
import { Spinner } from '../ui/Spinner.tsx'

export interface AccountConnectDialogProps {
  client: WorkerDeckClient | undefined
  // Open while set.
  profile: string | undefined
  onClose: () => void
  onConnected?: (profile: ProfileInfo) => void
  // Hosts that cannot follow a plain link (a webview, a native shell) open the sign-in page themselves.
  onOpenUrl?: (url: string) => void
}

export function AccountConnectDialog({ client, profile, onClose, onConnected, onOpenUrl }: AccountConnectDialogProps) {
  return (
    <Dialog open={profile !== undefined && client !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={`Connect a Claude account to ${profile ?? 'profile'}`} />
        <DialogBody>
          {profile && client ? (
            <AccountConnectFlow
              key={profile}
              client={client}
              profile={profile}
              onClose={onClose}
              onConnected={onConnected}
              onOpenUrl={onOpenUrl}
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

interface AccountConnectFlowProps {
  client: WorkerDeckClient
  profile: string
  onClose: () => void
  onConnected?: (profile: ProfileInfo) => void
  onOpenUrl?: (url: string) => void
}

function AccountConnectFlow({ client, profile, onClose, onConnected, onOpenUrl }: AccountConnectFlowProps) {
  const [generation, setGeneration] = useState(0)
  const [attempt, setAttempt] = useState<ConnectAccountResponse>()
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    setAttempt(undefined)
    setOpened(false)
    setCode('')
    setError(undefined)
    void client
      .connectAccount(profile)
      .then((started) => alive && setAttempt(started))
      .catch((e: unknown) => alive && setError(errorMessage(e, 'Could not start the sign-in')))
    return () => {
      alive = false
    }
  }, [client, profile, generation])

  const submit = () => {
    if (!attempt || code.trim() === '') {
      return
    }
    setBusy(true)
    setError(undefined)
    void client
      .completeAccount(profile, { attemptId: attempt.attemptId, code: code.trim() })
      .then((saved) => {
        onConnected?.(saved)
        onClose()
      })
      .catch((e: unknown) => {
        setBusy(false)
        setAttempt(undefined)
        setError(errorMessage(e, 'The account could not be connected'))
      })
  }

  if (!attempt) {
    return error ? (
      <div className="flex flex-col gap-3">
        <p className="text-label text-danger">{error}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => setGeneration((n) => n + 1)}>Start again</Button>
        </div>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-label text-fg-4">
        <Spinner className="size-4" />
        Starting claude setup-token on the gateway
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-label text-fg-3">
        1. Open the sign-in page and sign in with the Claude account this profile belongs to. It shows a code when you are done.
      </p>
      <div>
        <Button
          type="button"
          variant={opened ? 'outline' : 'default'}
          onClick={() => {
            setOpened(true)
            if (onOpenUrl) {
              onOpenUrl(attempt.authorizeUrl)
            } else {
              window.open(attempt.authorizeUrl, '_blank', 'noopener,noreferrer')
            }
          }}
        >
          <ExternalLink className="size-3" />
          Open sign-in page
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-label text-fg-3">
        2. Paste the code
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="code#state"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="font-mono"
        />
      </label>
      {error ? <p className="text-label text-danger">{error}</p> : null}
      <p className="text-label text-fg-4">
        The token is kept on the gateway for this profile only and is never shown again. It can only make model requests, so claude.ai
        connectors stay off; disconnecting deletes it, and you revoke it at claude.ai.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || code.trim() === ''}>
          {busy ? <Spinner className="size-3" /> : null}
          Connect
        </Button>
      </div>
    </form>
  )
}
