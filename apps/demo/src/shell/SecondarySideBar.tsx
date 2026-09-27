import type { ReactNode } from 'react'
import { ShellIconButton } from './icons.tsx'
import { SectionHeader } from './SideBar.tsx'

export type ShellSection = { id: string; title: string; content: ReactNode; actions?: ReactNode; expanded: boolean; grow?: boolean }

type SecondarySideBarProps = {
  tabs: { id: string; label: string }[]
  activeTab: string
  onTab?: (id: string) => void
  sections: ShellSection[]
  onToggleSection?: (id: string) => void
}

function sectionClass(section: ShellSection): string {
  if (!section.expanded) {
    return 'flex shrink-0 flex-col'
  }
  return section.grow ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 shrink flex-col'
}

export function SecondarySideBar({ tabs, activeTab, onTab, sections, onToggleSection }: SecondarySideBarProps) {
  return (
    <aside
      data-demo-region="secondary-sidebar"
      className="flex w-[292px] shrink-0 flex-col overflow-hidden rounded-[8px] border border-[#252526] bg-(--vscode-sideBar-background)"
    >
      <div className="flex h-[32px] shrink-0 items-center gap-[8px] pr-[4px] pl-[6px]">
        <div data-demo-region="secondary-tabs" role="tablist" className="flex min-w-0 flex-1 items-center gap-[4px]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab}
              onClick={() => onTab?.(tab.id)}
              className={
                tab.id === activeTab
                  ? 'h-[24px] rounded-[4px] bg-(--vscode-list-inactiveSelectionBackground) px-[8px] text-[13px] leading-[24px] text-(--vscode-foreground)'
                  : 'h-[24px] rounded-[4px] px-[8px] text-[13px] leading-[24px] text-[#9d9d9d] hover:text-(--vscode-foreground)'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-[2px]">
          <ShellIconButton icon="more" label="Views and More Actions" />
          <span className="mx-[4px] h-[16px] w-px bg-[#cccccc80]" />
          <ShellIconButton icon="maximize" label="Maximize Secondary Side Bar" />
          <ShellIconButton icon="close" label="Hide Secondary Side Bar" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-[4px]">
        {sections.map((section, index) => (
          <section key={section.id} data-demo-region={`section:${section.id}`} className={sectionClass(section)}>
            <SectionHeader
              title={section.title}
              expanded={section.expanded}
              actions={section.actions}
              first={index === 0}
              onToggle={() => onToggleSection?.(section.id)}
            />
            {section.expanded && <div className="wd-webview min-h-0 flex-1 overflow-y-auto">{section.content}</div>}
          </section>
        ))}
      </div>
    </aside>
  )
}
