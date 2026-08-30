import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Badge, Button, Empty, EmptyKey, EngineIcon } from '@workerdeck/ui'
import { IdCard, Plus } from 'lucide-react'
import { CreateProfileDialog } from '@/components/CreateProfileDialog.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { SidebarRow } from './SidebarRow.tsx'
import { useProfileList } from '@/hooks/useProfiles.ts'

/**
 * The profiles the primary gateway declares. A profile is what a session *runs
 * as*, so the engine mark is the fact worth carrying on the row.
 */
export function ProfilesSidebar() {
  const navigate = useNavigate()
  const activeName = useRouterState({
    select: (s) => s.location.pathname.match(/^\/profiles\/(.+)$/)?.[1],
  })
  const { profiles, canManage, refresh } = useProfileList()
  const [creating, setCreating] = useState(false)

  // `+` only where the server accepts one: a create form behind a 403 is worse than no button.
  const create = canManage ? (
    <Button variant="ghost" size="icon-sm" aria-label="New profile" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
    </Button>
  ) : undefined

  return (
    <>
      <SidebarFrame
        section="profiles"
        title="Profiles"
        badge={profiles.length > 0 ? <span className="shrink-0 text-label text-fg-4">{profiles.length}</span> : undefined}
        actions={create}
        railActions={create}
      >
        <SidebarBody>
          {profiles.length === 0 ? (
            <Empty
              icon={<IdCard />}
              title={canManage ? 'No profiles yet' : 'No profiles'}
              description={
                canManage ? (
                  <>
                    Add one with <EmptyKey>+</EmptyKey> above.
                  </>
                ) : (
                  'This gateway declares none, and this login may not add them.'
                )
              }
            />
          ) : null}
          {profiles.map((profile) => (
            <SidebarRow
              key={profile.name}
              active={profile.name === activeName}
              onSelect={() => void navigate({ to: '/profiles/$profileName', params: { profileName: profile.name } })}
              title={profile.name}
              status={
                // Declared profiles are code and stay read-only.
                profile.managed ? null : (
                  <Badge variant="neutral" className="shrink-0">
                    declared
                  </Badge>
                )
              }
              description={
                <>
                  <EngineIcon
                    engine={profile.engine ?? 'claude'}
                    model={profile.defaults?.model ?? profile.provider?.model}
                    className="size-3 shrink-0 text-fg-3"
                  />
                  <span className="min-w-0 truncate">
                    {profile.configDir ??
                      (profile.provider
                        ? `${profile.provider.id}${profile.provider.model ? ` · ${profile.provider.model}` : ''}`
                        : // A codex profile has neither a config dir nor a provider block, and a
                          // mark alone on an empty line reads as a row that failed to load.
                          (profile.engine ?? 'claude'))}
                  </span>
                </>
              }
            />
          ))}
        </SidebarBody>
      </SidebarFrame>

      <CreateProfileDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(name) => {
          setCreating(false)
          void refresh()
          void navigate({ to: '/profiles/$profileName', params: { profileName: name } })
        }}
      />
    </>
  )
}
