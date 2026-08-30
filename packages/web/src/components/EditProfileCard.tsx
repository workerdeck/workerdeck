import { useState } from 'react'
import { type PermissionMode, type ProfileInfo, type SessionCapability, type UpdateProfileRequest } from '@workerdeck/protocol'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, PermissionModeSelect, Spinner, toast } from '@workerdeck/ui'
import { Save } from 'lucide-react'
import { client } from '@/lib/client.ts'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { engineFormOptions } from '@/lib/engine.ts'

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

/**
 * Edit a store-managed profile. Name and engine are immutable: a rename would
 * orphan every session and job already pinned to the old one, and an engine
 * switch would leave the profile's other half meaningless.
 */
export function EditProfileCard({ profile, onSaved }: { profile: ProfileInfo; onSaved: (profile: ProfileInfo) => void }) {
  const isProvider = profile.engine === 'provider'
  const [description, setDescription] = useState(profile.description ?? '')
  const [defaultModel, setDefaultModel] = useState(profile.defaults?.model ?? '')
  const [mode, setMode] = useState<PermissionMode | undefined>(profile.defaults?.permissionMode)
  const [model, setModel] = useState(profile.provider?.model ?? '')
  const [models, setModels] = useState((profile.provider?.models ?? []).join(', '))
  const [capabilities, setCapabilities] = useState<SessionCapability[] | undefined>(profile.session?.capabilities)
  const [mcpServers, setMcpServers] = useState((profile.session?.mcpServers ?? []).join(', '))
  const [instructions, setInstructions] = useState(profile.session?.instructions ?? '')
  const [saving, setSaving] = useState(false)

  // The same resolver the create forms use, so "what this profile offers" has
  // one answer: its served catalog, else its declared provider ids, else the
  // static Claude aliases. Its `models` carries the "Profile default" row, whose
  // '' value is exactly what an unset default means here too.
  const form = engineFormOptions(profile, mode ?? 'default', defaultModel)
  // The shared resolver names its empty row "Profile default", which is what a
  // create form means by it. Inside the profile editor that would be circular —
  // here the empty row means *this* setting is unset, and the engine decides.
  const modelRows = form.models.map((row) =>
    row.value === 'default'
      ? {
          ...row,
          displayName: 'Unset',
          description: profile.defaultModel ?? "whatever the engine's own config picks",
        }
      : row,
  )

  const save = async () => {
    const patch: UpdateProfileRequest = {
      description: description.trim() || undefined,
      defaults: {
        model: defaultModel.trim() || undefined,
        permissionMode: mode,
      },
    }
    if (isProvider) {
      patch.provider = {
        ...profile.provider,
        id: profile.provider?.id ?? '',
        model: model.trim() || undefined,
        models: commaList(models).length > 0 ? commaList(models) : undefined,
      }
      // Undeclared and empty are different: undefined inherits whatever the
      // server's engine factory wired, [] would grant nothing at all.
      patch.session = {
        capabilities,
        mcpServers: commaList(mcpServers).length > 0 ? commaList(mcpServers) : undefined,
        instructions: instructions.trim() || undefined,
      }
    }
    setSaving(true)
    try {
      onSaved(await client()!.updateProfile(profile.name, patch))
      toast.success('Profile saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Default model">
            {/* This profile's OWN catalog, the same list its create form
                offers — a free-text field here could name a model this engine
                has never heard of, and the run would fail at spawn rather than
                at the point someone typed it. A provider profile whose ids the
                operator is still declaring below has nothing to list yet, so it
                keeps the text box. */}
            {modelRows.length > 1 ? (
              <ModelPicker value={defaultModel} onChange={setDefaultModel} models={modelRows} />
            ) : (
              <Input
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="unset — request / engine default"
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Default permission mode">
            <PermissionModeSelect
              variant="form"
              mode={mode}
              onModeChange={setMode}
              // The record, not the engine name — the one source of truth for
              // which modes this profile's engine can honor.
              modes={form.modes}
            />
          </Field>
        </div>

        {isProvider ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Default model id">
                <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Models offered (comma-separated)">
                <Input value={models} onChange={(e) => setModels(e.target.value)} className="font-mono" />
              </Field>
            </div>
            <Field label="Capabilities granted">
              <div className="flex flex-wrap items-center gap-3 py-1.5">
                <label className="flex cursor-pointer items-center gap-1.5 text-body-sm text-fg-2">
                  <input
                    type="checkbox"
                    checked={capabilities === undefined}
                    onChange={(e) => setCapabilities(e.target.checked ? undefined : [])}
                    className="size-3.5 accent-(--color-fg-1)"
                  />
                  not declared
                </label>
                {CAPABILITIES.map((capability) => (
                  <label key={capability} className="flex cursor-pointer items-center gap-1.5 text-body-sm text-fg-2">
                    <input
                      type="checkbox"
                      disabled={capabilities === undefined}
                      checked={capabilities?.includes(capability) ?? false}
                      onChange={(e) =>
                        setCapabilities((current) =>
                          e.target.checked ? [...(current ?? []), capability] : (current ?? []).filter((c) => c !== capability),
                        )
                      }
                      className="size-3.5 accent-(--color-fg-1) disabled:opacity-40"
                    />
                    <code className="font-mono text-label">{capability}</code>
                  </label>
                ))}
              </div>
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="MCP servers (names, comma-separated)">
                <Input value={mcpServers} onChange={(e) => setMcpServers(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Instructions">
                <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </Field>
            </div>
          </>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-label text-fg-4">
            Name and engine are fixed — sessions and jobs are pinned to the name, and the engine decides what the rest of these fields mean.
          </p>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner className="size-3.5 text-current" /> : <Save className="size-4" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
