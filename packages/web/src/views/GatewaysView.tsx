import { Plug } from 'lucide-react'

/**
 * What fills the detail pane when no gateway is selected.
 *
 * The list is the sidebar, so this route has nothing to list — VS Code's empty
 * editor group: say where you are, point at the one control that does something.
 */
export function GatewaysView() {
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center'>
      <Plug className='size-8 text-fg-4' />
      <p className='text-body-sm text-fg-3'>Select a gateway on the left to view or edit it.</p>
      <p className='text-label text-fg-4'>
        Or add one with <strong className='text-fg-3'>+</strong> in the sidebar header.
      </p>
    </div>
  )
}
