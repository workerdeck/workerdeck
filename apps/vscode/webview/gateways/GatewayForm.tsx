import { useState } from 'react'
import { Button, Input, Spinner } from '@workerdeck/ui'
import type { WebviewToHost } from '../../src/bridge-protocol.ts'

export type GatewayFormValue = { id: string; name: string; baseUrl: string; authKey: string }

export function GatewayForm({
  editing,
  defaults,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  editing: GatewayFormValue | undefined
  defaults?: { name: string; baseUrl: string }
  error: string | undefined
  busy: boolean
  onSubmit: (msg: WebviewToHost) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(editing?.name ?? defaults?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? defaults?.baseUrl ?? '')
  const [authKey, setAuthKey] = useState(editing?.authKey ?? '')

  const submit = () => {
    onSubmit({ kind: 'wd-submit-gateway', id: editing?.id, name, baseUrl, authKey })
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="flex flex-col gap-1 text-body-sm">
        <span className="text-fg-3">Gateway URL</span>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://mac-mini.tailnet.ts.net:8787"
          autoFocus={!editing}
        />
        <span className="text-label text-fg-4">The server root — /v1 is implied.</span>
      </label>
      <label className="flex flex-col gap-1 text-body-sm">
        <span className="text-fg-3">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mac-mini" />
      </label>
      <label className="flex flex-col gap-1 text-body-sm">
        <span className="text-fg-3">Auth key</span>
        <Input
          type="password"
          value={authKey}
          onChange={(e) => setAuthKey(e.target.value)}
          placeholder="empty for a keyless loopback gateway"
        />
        <span className="text-label text-fg-4">The gateway’s --auth-key. Stored in the OS keychain, never in settings.</span>
      </label>
      {error ? <div className="rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger">{error}</div> : null}
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy || !baseUrl.trim() || !name.trim()}>
          {busy ? <Spinner className="size-3" /> : null} {editing ? 'Save' : 'Add gateway'}
        </Button>
      </div>
    </div>
  )
}
