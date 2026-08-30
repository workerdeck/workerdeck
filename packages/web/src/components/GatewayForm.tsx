import { useState, type ReactNode } from 'react'
import { apiUrl } from '@workerdeck/client'
import { Button, Dialog, DialogBody, DialogContent, DialogHeader, Input, toast } from '@workerdeck/ui'
import { keyFor, newHostId, removeHost, saveHost, type GatewayHost } from '@/lib/hosts.ts'

/**
 * The gateway's three fields, shared by the create modal and the edit page.
 *
 * One component rather than two copies because the fields are the *record* —
 * name, address, key is what a gateway is here — and the only difference
 * between adding and editing one is the frame around them. The two had already
 * drifted once in this app's history (the session and job forms); this starts
 * merged.
 */
export function GatewayFields({
  host,
  submitLabel = 'Save',
  onSaved,
  actions,
}: {
  host: GatewayHost
  submitLabel?: string
  onSaved: (host: GatewayHost) => void
  /** Extra buttons left of Save — Cancel in a modal, Remove on the page. */
  actions?: ReactNode
}) {
  const [name, setName] = useState(host.name)
  const [baseUrl, setBaseUrl] = useState(host.baseUrl)
  const [key, setKey] = useState(() => keyFor(host.id))

  const submit = () => {
    // Validated the same way every other client validates it, so the same
    // address saved on the phone and here is the same gateway.
    if (apiUrl({ baseUrl }) === undefined) {
      toast.error('That address is not a URL')
      return
    }
    if (!name.trim()) {
      toast.error('Give the gateway a name')
      return
    }
    const saved = { id: host.id, name: name.trim(), baseUrl: baseUrl.trim() }
    saveHost(saved, key)
    onSaved(saved)
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-label text-fg-3">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mac mini" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-label text-fg-3">Address</span>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://toby.ts.net:8787"
          spellCheck={false}
          className="font-mono"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-label text-fg-3">Auth key</span>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Leave empty for an unauthenticated gateway"
          spellCheck={false}
        />
        {/* Said plainly rather than buried in docs: a browser has no keychain,
            and the operator should know where this ends up. */}
        <span className="text-label text-fg-4">
          Stored in this browser’s local storage, and sent on the WebSocket URL when attaching. Use a gateway you control, over a network
          you trust.
        </span>
      </label>
      <div className="mt-1 flex justify-end gap-2">
        {actions}
        <Button onClick={submit}>{submitLabel}</Button>
      </div>
    </div>
  )
}

/** Adding a gateway, as a modal — the shape every `+` in this app opens. */
export function CreateGatewayDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (host: GatewayHost) => void
}) {
  // A fresh id per opening, so cancelling and reopening does not reuse (and
  // then overwrite) the entry an earlier attempt half-created.
  const [draft, setDraft] = useState(() => newDraft())
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(newDraft())
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader title="Add gateway" description="A workerdeck gateway you run — typically over Tailscale." />
        <DialogBody>
          <GatewayFields
            host={draft}
            submitLabel="Add gateway"
            onSaved={onCreated}
            actions={
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            }
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function newDraft(): GatewayHost {
  return { id: newHostId(), name: '', baseUrl: '' }
}

/** Removing one. Confirmed, because the key goes with it and this browser has
 * no other copy. */
export function ConfirmRemoveGateway({ host, onClose, onRemoved }: { host: GatewayHost; onClose: () => void; onRemoved: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader
          title={`Remove ${host.name}?`}
          description="Its auth key is deleted from this browser. The gateway itself keeps running."
        />
        <DialogBody>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                removeHost(host.id)
                onRemoved()
              }}
            >
              Remove
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
