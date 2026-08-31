import { Empty } from '@workerdeck/ui'
import { UsersRound } from 'lucide-react'

export const openInVsCode = (path: string): void => {
  window.location.href = `vscode://file${path}`
}

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
