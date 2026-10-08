import { EditProfileCard } from '@/components/EditProfileCard.tsx'
import { DetailBar, DetailBody, DetailRow } from '@/components/shell/DetailBar.tsx'
import { useProfileList } from '@/hooks/useProfiles.ts'
import { client } from '@/lib/client.ts'
import { useHosts } from '@/lib/hosts.ts'
import { useNavigate, useParams } from '@tanstack/react-router'
import { errorMessage, orderUsageWindows } from '@workerdeck/protocol'
import { useAsync } from '@workerdeck/react'
import { AccountConnectDialog, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner, UsageMeters, toast } from '@workerdeck/ui'
import type { ProfileAccount } from '@workerdeck/protocol'
import { Code, KeyRound, Trash2, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { openInVsCode } from './ProfilesView.tsx'

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <span className="text-fg-4">{empty}</span>
  }
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {items.map((item) => (
        <Badge key={item} variant="neutral">
          {item}
        </Badge>
      ))}
    </span>
  )
}

const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000

function AccountRow({ account }: { account: ProfileAccount | undefined }) {
  if (!account) {
    return <span className="text-fg-4">not connected - the config dir&apos;s own login or the gateway environment</span>
  }
  const expires = new Date(account.expiresAt)
  const soon = expires.getTime() - Date.now() < EXPIRY_WARNING_MS
  return (
    <span className={soon ? 'text-warning' : undefined}>
      connected {new Date(account.connectedAt).toLocaleDateString()}, {soon ? 'expires soon: ' : 'expires '}
      {expires.toLocaleDateString()}
    </span>
  )
}

export function ProfileView() {
  const { profileName } = useParams({ from: '/profiles/$profileName' })
  const navigate = useNavigate()
  const { refresh } = useProfileList()
  // Polled: the plan usage on the record is the newest reading from any session on this account, and those keep spending.
  const { ready } = useHosts()
  const loaded = useAsync(async () => client()?.getProfile(profileName), [profileName, ready], { enabled: ready, pollMs: 60_000 })
  const detail = loaded.data
  const error = loaded.error === undefined ? undefined : errorMessage(loaded.error, 'Failed to load profile')

  const profile = detail?.profile
  const config = detail?.config
  const usageWindows = useMemo(() => orderUsageWindows(profile?.usage), [profile?.usage])
  const [connecting, setConnecting] = useState(false)

  const disconnect = async () => {
    try {
      const saved = await client()!.disconnectAccount(profileName)
      loaded.setData({ ...detail!, profile: saved })
      toast.success('Account disconnected. Revoke the token at claude.ai if you no longer need it.')
    } catch (e) {
      toast.error(errorMessage(e, 'Disconnect failed'))
    }
  }

  const remove = async () => {
    try {
      await client()!.deleteProfile(profileName)
      await refresh()
      toast.success(`Profile '${profileName}' deleted`)
      void navigate({ to: '/profiles' })
    } catch (e) {
      toast.error(errorMessage(e, 'Delete failed'))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailBar
        crumbs={[{ label: 'Profiles', to: '/profiles' }, { label: profileName }]}
        actions={
          <>
            {profile?.configDir ? (
              <Button variant="outline" size="xs" onClick={() => openInVsCode(profile.configDir!)}>
                <Code className="size-3" />
                Open in VSCode
              </Button>
            ) : null}
            {profile?.managed ? (
              <Button variant="outline" size="xs" onClick={() => void remove()}>
                <Trash2 className="size-3" />
                Delete
              </Button>
            ) : null}
          </>
        }
      >
        {profile?.description ? <span className="min-w-0 truncate text-label text-fg-4">{profile.description}</span> : null}
      </DetailBar>

      <DetailBody>
        {error ? <div className="rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger">{error}</div> : null}
        {!detail && !error ? <Spinner className="mx-auto size-5 text-fg-4" /> : null}

        {profile && config ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Worker defaults</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col divide-y divide-border">
                <DetailRow label="Engine">
                  <Badge variant="neutral">{profile.engine ?? 'claude'}</Badge>
                </DetailRow>
                {profile.engine === 'provider' ? (
                  <DetailRow label="Provider">
                    <span className="font-mono text-label">{profile.provider?.id}</span>
                  </DetailRow>
                ) : (
                  <DetailRow label="Config directory">
                    <span className="font-mono text-label">{profile.configDir}</span>
                  </DetailRow>
                )}
                <DetailRow label="Default model">
                  {profile.defaults?.model ?? profile.provider?.model ?? <span className="text-fg-4">request / engine default</span>}
                </DetailRow>
                <DetailRow label="Default permission mode">
                  {profile.defaults?.permissionMode ?? <span className="text-fg-4">request / engine default</span>}
                </DetailRow>
                {profile.engine === 'provider' ? (
                  <>
                    <DetailRow label="Models offered">
                      <Chips items={profile.provider?.models ?? []} empty="the default model only" />
                    </DetailRow>
                    {/* A variable NAME, never a key: credentials are resolved from the server's environment and never cross the wire. */}
                    <DetailRow label="API key variable">
                      {profile.provider?.apiKeyEnv ? (
                        <span className="font-mono text-label">{profile.provider.apiKeyEnv}</span>
                      ) : (
                        <span className="text-fg-4">provider SDK default</span>
                      )}
                    </DetailRow>
                  </>
                ) : null}
              </CardContent>
            </Card>

            {/* Absent means nothing has reported - unknown, never 0% - so the card stays away rather than drawing empty bars. */}
            {usageWindows.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Plan usage</CardTitle>
                </CardHeader>
                <CardContent>
                  <UsageMeters windows={usageWindows} />
                </CardContent>
              </Card>
            ) : null}

            {profile.engine === 'provider' ? (
              <Card>
                <CardHeader>
                  <CardTitle>Session grants</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col divide-y divide-border">
                  <DetailRow label="Capabilities">
                    <Chips items={profile.session?.capabilities ?? []} empty="not declared - whatever the server wired" />
                  </DetailRow>
                  <DetailRow label="MCP servers">
                    <Chips items={profile.session?.mcpServers ?? []} empty="not declared - every connected server" />
                  </DetailRow>
                  <DetailRow label="Instructions">
                    {profile.session?.instructions ? (
                      `${profile.session.instructions.length} characters`
                    ) : (
                      <span className="text-fg-4">none</span>
                    )}
                  </DetailRow>
                </CardContent>
              </Card>
            ) : null}

            {(profile.engine ?? 'claude') === 'claude' && profile.managed ? (
              <Card>
                <CardHeader>
                  <CardTitle>Claude account</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <DetailRow label="Account">
                    <AccountRow account={profile.account} />
                  </DetailRow>
                  <div className="flex justify-end gap-2">
                    {profile.account ? (
                      <Button variant="outline" size="xs" onClick={() => void disconnect()}>
                        <Unplug className="size-3" />
                        Disconnect
                      </Button>
                    ) : null}
                    <Button variant="outline" size="xs" onClick={() => setConnecting(true)}>
                      <KeyRound className="size-3" />
                      {profile.account ? 'Reconnect' : 'Connect account'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {profile.engine === 'provider' ? null : (
              <Card>
                <CardHeader>
                  <CardTitle>Claude Code configuration</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col divide-y divide-border">
                  {config.settings ? (
                    <>
                      <DetailRow label="Model (settings.json)">
                        {config.settings.model ?? <span className="text-fg-4">not set</span>}
                      </DetailRow>
                      <DetailRow label="Default permission mode">
                        {config.settings.defaultPermissionMode ?? <span className="text-fg-4">not set</span>}
                      </DetailRow>
                      <DetailRow label="Permission rules">
                        <span className="font-mono text-label">
                          {config.settings.permissionRules
                            ? `${config.settings.permissionRules.allow} allow · ${config.settings.permissionRules.ask} ask · ${config.settings.permissionRules.deny} deny`
                            : '-'}
                        </span>
                      </DetailRow>
                      <DetailRow label="Env vars (names only)">
                        <Chips items={config.settings.envKeys ?? []} empty="none" />
                      </DetailRow>
                      <DetailRow label="Hooks">
                        <Chips items={config.settings.hooks ?? []} empty="none" />
                      </DetailRow>
                    </>
                  ) : (
                    <DetailRow label="settings.json">
                      <span className="text-fg-4">not found</span>
                    </DetailRow>
                  )}
                  <DetailRow label="User memory (CLAUDE.md / AGENTS.md)">
                    {config.hasUserMemory ? 'present' : <span className="text-fg-4">none</span>}
                  </DetailRow>
                  <DetailRow label="Skills">
                    <Chips items={config.skills} empty="none" />
                  </DetailRow>
                  <DetailRow label="Agents">
                    <Chips items={config.agents} empty="none" />
                  </DetailRow>
                  <DetailRow label="Commands">
                    <Chips items={config.commands} empty="none" />
                  </DetailRow>
                </CardContent>
              </Card>
            )}

            {profile.managed ? (
              <EditProfileCard profile={profile} onSaved={(saved) => loaded.setData({ ...detail!, profile: saved })} />
            ) : null}

            <p className="text-label text-fg-4">
              {profile.managed
                ? 'Stored on the server and editable here. '
                : 'View only - this profile is declared in the server options. '}
              Other profile configuration lives on the server (the <code className="font-mono">profiles</code> option; for Claude profiles,
              the config directory itself, e.g. via VSCode). Provider credentials are resolved from the server&apos;s environment and never
              leave it.
            </p>
          </>
        ) : null}
      </DetailBody>
      <AccountConnectDialog
        client={client()}
        profile={connecting ? profileName : undefined}
        onClose={() => setConnecting(false)}
        onConnected={(saved) => {
          loaded.setData({ ...detail!, profile: saved })
          toast.success(`Account connected to '${profileName}'`)
        }}
      />
    </div>
  )
}
