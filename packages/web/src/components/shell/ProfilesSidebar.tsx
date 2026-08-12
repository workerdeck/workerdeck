import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Badge, Button, Empty, EmptyKey, EngineIcon } from '@workerdeck/ui'
import { IdCard, Plus } from 'lucide-react'
import { CreateProfileDialog } from '@/components/CreateProfileDialog.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { SidebarRow } from './SidebarRow.tsx'
import { useProfileList } from '@/lib/useProfiles.ts'

/**
 * The profiles the primary gateway declares, as a sidebar.
 *
 * A profile is what a session *runs as* — a Claude config directory, or a
 * provider for the model-agnostic engine — so the engine mark is the fact worth
 * carrying on the row, the same glyph the sessions list uses for the same
 * reason.
 */
export function ProfilesSidebar() {
  const navigate = useNavigate()
  const activeName = useRouterState({
    select: (s) => s.location.pathname.match(/^\/profiles\/(.+)$/)?.[1],
  })
  const { profiles, canManage, refresh } = useProfileList()
  const [creating, setCreating] = useState(false)

  // `+` is offered only where the server actually accepts one — a create form
  // behind a button that 403s is worse than no button.
  const create = canManage ? (
    <Button variant='ghost' size='icon-sm' aria-label='New profile' onClick={() => setCreating(true)}>
      <Plus className='size-4' />
    </Button>
  ) : undefined

  return (
    <>
      <SidebarFrame
        section='profiles'
        title='Profiles'
        badge={
          profiles.length > 0 ? (
            <span className='shrink-0 text-label text-fg-4'>{profiles.length}</span>
          ) : undefined
        }
        actions={create}
        railActions={create}>
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
              onSelect={() =>
                void navigate({ to: '/profiles/$profileName', params: { profileName: profile.name } })
              }
              title={profile.name}
              status={
                // Declared profiles are code and stay read-only; saying so on
                // the row is cheaper than finding out on the detail page.
                profile.managed ? null : (
                  <Badge variant='neutral' className='shrink-0'>
                    declared
                  </Badge>
                )
              }
              description={
                <>
                  {/* On the description line rather than in front of the title:
                      an engine mark identifies, it does not take precedence over
                      the name you are reading. It lines up under the title, the
                      way the VS Code sidebar puts it. */}
                  <EngineIcon
                    engine={profile.engine ?? 'claude'}
                    model={profile.defaults?.model ?? profile.provider?.model}
                    className='size-3 shrink-0 text-fg-3'
                  />
                  <span className='min-w-0 truncate'>
                    {profile.configDir ??
                      (profile.provider
                        ? `${profile.provider.id}${profile.provider.model ? ` · ${profile.provider.model}` : ''}`
                        : // A codex profile has neither a config dir nor a
                          // provider block, and a mark alone on an empty line
                          // reads as a row that failed to load.
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
