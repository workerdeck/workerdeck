import { useNavigate } from '@tanstack/react-router'
import { Badge, Button, toast } from '@workerdeck/ui'
import { Code, Eye, FolderCog, Trash2, UserRound } from 'lucide-react'
import { CreateProfileCard } from '@/components/CreateProfileCard.tsx'
import { client } from '@/lib/client.ts'
import { useProfileList } from '@/lib/useProfiles.ts'

/** Opens the profile's config dir in VSCode via the vscode:// URL scheme. */
export function openInVsCode(path: string): void {
  window.location.href = `vscode://file${path}`
}

/** Read-only: profiles are declared in server options at startup (or auto-created
 * from the operator's own ~/.claude); the dashboard lists and picks, never edits.
 * A profile also selects the engine — Claude Code via the Agent SDK, or the
 * model-agnostic provider engine. */
export function ProfilesView() {
  const { profiles, canManage, refresh } = useProfileList()
  const navigate = useNavigate()

  const remove = (name: string) => {
    void client
      .deleteProfile(name)
      .then(() => refresh())
      .then(() => toast.success(`Profile '${name}' deleted`))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Delete failed'))
  }

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header>
          <h1 className='text-display-sm font-semibold tracking-tight text-text'>Profiles</h1>
          <p className='mt-0.5 text-body-sm text-muted-foreground'>
            What a session runs as: a named Claude Code config directory — its own settings,
            memory, skills, and credentials — or a model provider for the model-agnostic engine.
          </p>
        </header>

        {profiles.length === 0 ? (
          <div className='flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-4 py-8 text-center'>
            <FolderCog className='size-6 text-fg-4' />
            <p className='text-body-sm text-fg-2'>The server declares no profiles.</p>
            <p className='text-label text-fg-4'>
              Pass <code className='font-mono'>profiles: [{'{ name, configDir, … }'}]</code> to{' '}
              <code className='font-mono'>createWorkerServer</code> — without the option, a{' '}
              <code className='font-mono'>default</code> profile is auto-created from{' '}
              <code className='font-mono'>~/.claude</code> when it exists.
            </p>
          </div>
        ) : (
          <ul className='divide-y divide-border rounded-md border border-border bg-surface'>
            {profiles.map((p) => (
              <li key={p.name} className='flex items-center gap-3 px-3 py-2.5'>
                <UserRound className='size-4 shrink-0 text-fg-3' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='truncate text-body-sm font-medium text-fg-1'>{p.name}</span>
                    {p.description ? (
                      <span className='truncate text-body-sm text-fg-3'>{p.description}</span>
                    ) : null}
                  </div>
                  <div className='mt-0.5 truncate font-mono text-label text-fg-4'>
                    {p.configDir ?? (p.provider ? `${p.provider.id}${p.provider.model ? ` · ${p.provider.model}` : ''}` : '')}
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  <Badge variant='neutral'>{p.engine ?? 'claude'}</Badge>
                  {p.defaults?.model ? <Badge variant='neutral'>{p.defaults.model}</Badge> : null}
                  {p.defaults?.permissionMode ? (
                    <Badge variant='neutral'>{p.defaults.permissionMode}</Badge>
                  ) : null}
                  {/* Provider profiles have no config dir to open. */}
                  {p.configDir ? (
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label={`Open ${p.name} in VSCode`}
                      title='Open config dir in VSCode'
                      onClick={() => openInVsCode(p.configDir!)}>
                      <Code className='size-4' />
                    </Button>
                  ) : null}
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={`View ${p.name}`}
                    title='View profile'
                    onClick={() =>
                      void navigate({ to: '/profiles/$profileName', params: { profileName: p.name } })
                    }>
                    <Eye className='size-4' />
                  </Button>
                  {/* Only store-backed profiles can be removed — declared ones
                      live in the server's options. */}
                  {p.managed ? (
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label={`Delete ${p.name}`}
                      title='Delete profile'
                      onClick={() => remove(p.name)}>
                      <Trash2 className='size-4' />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canManage ? <CreateProfileCard onCreated={refresh} /> : null}

        <p className='text-label text-fg-4'>
          Session and job creates run under the selected profile; when the server declares more
          than one, picking a profile is required.{' '}
          {canManage
            ? 'Profiles created here are stored by the server; the ones declared in its options are code and stay read-only.'
            : 'Profiles are declared in server configuration and read-only here.'}
        </p>
      </div>
    </div>
  )
}
