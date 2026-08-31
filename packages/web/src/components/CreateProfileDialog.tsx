import { useState } from 'react'
import type { CreateProfileRequest, ProfileEngine, SessionCapability } from '@workerdeck/protocol'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Spinner,
  toast,
} from '@workerdeck/ui'
import { Plus } from 'lucide-react'
import { client } from '@/lib/client.ts'

const CAPABILITIES: SessionCapability[] = ['web_search', 'download', 'web_fetch', 'deliver_file']

const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-label font-medium text-fg-3">{label}</span>
      {children}
    </label>
  )
}

// No field here carries a credential: `apiKeyEnv` is a variable name the server resolves, and a config directory is
// a path bounded by the server's `allowedConfigDirRoots`.
function CreateProfileForm({ onCreated }: { onCreated: (name: string) => void }) {
  const [engine, setEngine] = useState<ProfileEngine>('provider')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [capabilities, setCapabilities] = useState<SessionCapability[]>([])
  const [mcpServers, setMcpServers] = useState('')
  const [instructions, setInstructions] = useState('')
  const [saving, setSaving] = useState(false)

  const isProvider = engine === 'provider'

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    const profile: CreateProfileRequest = { name: name.trim(), engine }
    if (description.trim()) {
      profile.description = description.trim()
    }
    if (isProvider) {
      profile.provider = {
        id: providerId.trim(),
        model: model.trim() || undefined,
        models: commaList(models).length > 0 ? commaList(models) : undefined,
        apiKeyEnv: apiKeyEnv.trim() || undefined,
      }
      // Absent means "whatever the server wired", which is not the same as empty.
      const session: NonNullable<CreateProfileRequest['session']> = {}
      if (capabilities.length > 0) {
        session.capabilities = capabilities
      }
      if (commaList(mcpServers).length > 0) {
        session.mcpServers = commaList(mcpServers)
      }
      if (instructions.trim()) {
        session.instructions = instructions.trim()
      }
      if (Object.keys(session).length > 0) {
        profile.session = session
      }
    } else {
      profile.configDir = configDir.trim()
    }
    setSaving(true)
    try {
      await client()!.createProfile(profile)
      toast.success(`Profile '${profile.name}' created`)
      onCreated(profile.name)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Engine">
          <Select
            items={[
              { value: 'provider', label: 'provider' },
              { value: 'claude', label: 'claude' },
            ]}
            value={engine}
            onValueChange={(value) => setEngine(value as ProfileEngine)}
          >
            <SelectTrigger className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="provider">
                <SelectItemText>provider — model-agnostic engine</SelectItemText>
              </SelectItem>
              <SelectItem value="claude">
                <SelectItemText>claude — Agent SDK + config dir</SelectItemText>
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="kimi" />
        </Field>
        <Field label="Description (optional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this profile is for" />
        </Field>
      </div>

      {isProvider ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Provider id">
              <Input
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="anthropic / openai / moonshotai"
                className="font-mono"
              />
            </Field>
            <Field label="Default model">
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="kimi-k3" className="font-mono" />
            </Field>
            <Field label="Models offered (comma-separated)">
              <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="kimi-k3, kimi-k2" className="font-mono" />
            </Field>
            <Field label="API key variable">
              <Input
                value={apiKeyEnv}
                onChange={(e) => setApiKeyEnv(e.target.value)}
                placeholder="MOONSHOT_API_KEY"
                className="font-mono"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Capabilities granted">
              <div className="flex flex-wrap gap-3 py-1.5">
                {CAPABILITIES.map((capability) => (
                  <label key={capability} className="flex cursor-pointer items-center gap-1.5 text-body-sm text-fg-2">
                    <input
                      type="checkbox"
                      checked={capabilities.includes(capability)}
                      onChange={(e) =>
                        setCapabilities((current) =>
                          e.target.checked ? [...current, capability] : current.filter((c) => c !== capability),
                        )
                      }
                      className="size-3.5 accent-(--color-fg-1)"
                    />
                    <code className="font-mono text-label">{capability}</code>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="MCP servers (names, comma-separated)">
              <Input value={mcpServers} onChange={(e) => setMcpServers(e.target.value)} placeholder="deepwiki" className="font-mono" />
            </Field>
          </div>
          <Field label="Instructions (optional)">
            <Input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="prepended to the session's system prompt"
            />
          </Field>
          <p className="text-label text-fg-4">
            Leave capabilities and MCP servers empty to inherit whatever the server&apos;s engine factory wired — that factory is the
            ceiling either way, so a grant here can never exceed it. MCP servers are named, never configured: their transport config (and
            any credentials in it) stays on the server.
          </p>
        </>
      ) : (
        <>
          <Field label="Config directory">
            <Input
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              placeholder="/Users/you/.claude"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <p className="text-label text-fg-4">
            Must resolve inside the server&apos;s <code className="font-mono">allowedConfigDirRoots</code> — a config directory is a
            credential store, so the server bounds which ones a managed profile may point at.
          </p>
        </>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} disabled={saving}>
          {saving ? <Spinner className="size-3.5 text-current" /> : <Plus className="size-4" />}
          Create profile
        </Button>
      </div>
    </div>
  )
}

export function CreateProfileDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (name: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="New profile" description="What a session runs as — a Claude config directory, or a model provider." />
        <DialogBody>
          {/* Remounted per opening so a cancelled draft does not come back. */}
          {open ? <CreateProfileForm onCreated={onCreated} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
