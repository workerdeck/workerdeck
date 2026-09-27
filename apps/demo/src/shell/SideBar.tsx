import type { ReactNode } from 'react'
import { ShellIcon, ShellIconButton } from './icons.tsx'

type SectionHeaderProps = {
  title: string
  expanded: boolean
  actions?: ReactNode
  first?: boolean
  onToggle?: () => void
}

const EXPLORER_SECTIONS = ['Workspace', 'Outline', 'Timeline']

export function SectionHeader({ title, expanded, actions, first, onToggle }: SectionHeaderProps) {
  return (
    <div
      className={
        first
          ? 'flex h-[28px] shrink-0 items-center gap-[8px] rounded-[4px] pr-[2px] pl-[4px]'
          : 'flex h-[28px] shrink-0 items-center gap-[8px] border-t border-(--vscode-sideBarSectionHeader-border) pr-[2px] pl-[4px]'
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-[2px] self-stretch text-left text-[12px] font-semibold text-(--vscode-foreground)"
      >
        <ShellIcon icon={expanded ? 'chevronDown' : 'chevronRight'} />
        <span className="truncate">{title}</span>
      </button>
      <div className="flex shrink-0 items-center justify-end gap-[2px]">
        {actions}
        <ShellIconButton icon="more" label="More Actions" />
      </div>
    </div>
  )
}

export function SideBar({ children }: { children?: ReactNode }) {
  return (
    <aside data-demo-region="explorer" className="flex w-[300px] shrink-0 flex-col overflow-hidden bg-(--vscode-sideBar-background)">
      <div className="flex h-[32px] shrink-0 items-center gap-[8px] px-[4px] pl-[12px]">
        <span className="flex-1 truncate text-[12px] text-(--vscode-sideBarTitle-foreground)">Explorer</span>
        <ShellIconButton icon="more" label="More Actions" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[4px]">
        {children ??
          EXPLORER_SECTIONS.map((title, index) => <SectionHeader key={title} title={title} expanded={false} first={index === 0} />)}
      </div>
    </aside>
  )
}
