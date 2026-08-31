import type { SessionRow } from '@workerdeck/protocol'
import { SessionItem, cn } from '@workerdeck/ui'
import { MoreHorizontal } from 'lucide-react'

export function SessionCard({
  row,
  showProject = true,
  showGateway,
  projectIcons,
  selected,
  activeSubagentId,
  onSelect,
  onSelectSubagent,
  onRevealStep,
  onRename,
  onMenu,
}: {
  row: SessionRow
  showProject?: boolean
  showGateway?: boolean
  projectIcons?: Record<string, string>
  selected: boolean
  activeSubagentId?: string
  onSelect: () => void
  onSelectSubagent: (toolUseId: string) => void
  onRevealStep: (toolUseId: string) => void
  onRename: (title: string) => void
  onMenu: () => void
}) {
  return (
    <SessionItem
      row={row}
      active={selected}
      activeStepKey={activeSubagentId}
      showProject={showProject}
      showGateway={showGateway}
      projectIcons={projectIcons}
      onSelect={onSelect}
      onSelectSubagent={onSelectSubagent}
      onRevealStep={onRevealStep}
      onRename={onRename}
      actions={<CardMenu onOpen={onMenu} />}
    />
  )
}

function CardMenu({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Session actions"
      title="Session actions"
      onClick={(e) => {
        // The whole card is a button; this one does not mean "select".
        e.stopPropagation()
        onOpen()
      }}
      className={cn('flex shrink-0 items-center rounded-[4px] p-0.5 outline-none', 'text-fg-4 hover:bg-row-hover hover:text-fg-1')}
    >
      <MoreHorizontal className="size-4" />
    </button>
  )
}
