import type { SessionRow, SubagentDisplay } from '@workerdeck/protocol'
import { SessionItem, cn, type SelectModifiers } from '@workerdeck/ui'
import { AppWindow, MoreHorizontal } from 'lucide-react'

export function SessionCard({
  row,
  showProject = true,
  showGateway,
  subagents,
  projectIcons,
  selected,
  inEditor = false,
  activeSubagentId,
  onSelect,
  onSelectSubagent,
  onRename,
  onMenu,
}: {
  row: SessionRow
  showProject?: boolean
  showGateway?: boolean
  subagents?: SubagentDisplay
  projectIcons?: Record<string, string>
  selected: boolean
  inEditor?: boolean
  activeSubagentId?: string
  onSelect: (modifiers: SelectModifiers) => void
  onSelectSubagent: (toolUseId: string) => void
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
      subagents={subagents}
      projectIcons={projectIcons}
      onSelect={onSelect}
      onSelectSubagent={onSelectSubagent}
      onRename={onRename}
      actions={
        <>
          {inEditor ? <AppWindow className="size-3.5 shrink-0 text-fg-4" aria-label="Open in an editor tab" /> : null}
          <CardMenu onOpen={onMenu} />
        </>
      }
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
