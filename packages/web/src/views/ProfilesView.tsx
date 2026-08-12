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
    <div className='flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center'>
      <UsersRound className='size-8 text-fg-4' />
      <p className='text-body-sm text-fg-3'>Select a profile on the left to view it.</p>
      <p className='max-w-sm text-label text-fg-4'>
        A profile is what a session runs as: a named Claude Code config directory — its own
        settings, memory, skills and credentials — or a model provider for the model-agnostic
        engine.
      </p>
    </div>
  )
}
