import { Empty } from '@workerdeck/ui'
import { UsersRound } from 'lucide-react'

/** Opens the profile's config dir in VSCode via the vscode:// URL scheme. */
export function openInVsCode(path: string): void {
  window.location.href = `vscode://file${path}`
}

/**
 * What fills the detail pane when no profile is selected.
 *
 * The list is the sidebar now, so this route has nothing to list — VS Code's
 * empty editor group.
 */
export function ProfilesView() {
  return (
    <div className='flex flex-1 items-center justify-center p-8'>
      <Empty
        icon={<UsersRound />}
        title='No profile selected'
        description='A profile is what a session runs as — its config directory and credentials, or a model provider.'
      />
    </div>
  )
}
