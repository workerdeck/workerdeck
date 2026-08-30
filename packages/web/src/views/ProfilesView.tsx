import { Empty } from '@workerdeck/ui'
import { UsersRound } from 'lucide-react'

/** Opens the profile's config dir in VSCode via the vscode:// URL scheme. */
export function openInVsCode(path: string): void {
  window.location.href = `vscode://file${path}`
}

/** What fills the detail pane when no profile is selected — the list is the sidebar. */
export function ProfilesView() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Empty
        icon={<UsersRound />}
        title="No profile selected"
        description="A profile is what a session runs as — its config directory and credentials, or a model provider."
      />
    </div>
  )
}
