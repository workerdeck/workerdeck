import type { JSX, ReactNode } from 'react'
import { cn } from '@workerdeck/ui'
import { ActivityBar } from './ActivityBar.tsx'
import { SecondarySideBar } from './SecondarySideBar.tsx'
import type { ShellSection } from './SecondarySideBar.tsx'
import { SideBar } from './SideBar.tsx'
import { StatusBar } from './StatusBar.tsx'
import { TitleBar } from './TitleBar.tsx'

export type WorkbenchProps = {
  title: string
  explorer?: ReactNode
  editor?: ReactNode
  panel?: ReactNode
  panelTitle?: ReactNode
  secondaryTabs: { id: string; label: string }[]
  activeSecondaryTab: string
  onSecondaryTab?: (id: string) => void
  sections: ShellSection[]
  onToggleSection?: (id: string) => void
  statusBar?: { left?: ReactNode; right?: ReactNode }
  className?: string
}

const PANE = 'flex min-h-0 flex-col overflow-hidden rounded-[8px] border border-[#252526]'

const PANEL_TABS = ['Problems', 'Output', 'Debug Console', 'Terminal', 'Ports']

export function Workbench(props: WorkbenchProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden bg-(--vscode-titleBar-activeBackground) text-(--vscode-foreground)',
        props.className,
      )}
    >
      <TitleBar title={props.title} />
      <div className="flex min-h-0 flex-1 gap-[4px] px-[4px] pb-[4px]">
        <div className={cn(PANE, 'flex-row bg-(--vscode-sideBar-background)')}>
          <ActivityBar />
          <SideBar>{props.explorer}</SideBar>
        </div>
        <main className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <section data-demo-region="editor" className={cn(PANE, 'flex-[40_1_0%] bg-(--vscode-editor-background)')}>
            {props.editor}
          </section>
          <section data-demo-region="agent-panel" className={cn(PANE, 'flex-[60_1_0%] bg-(--vscode-panel-background)')}>
            <div className="flex h-[32px] shrink-0 items-center gap-[2px] pr-[4px] pl-[2px]">
              {[...PANEL_TABS, props.panelTitle ?? 'Agent'].map((tab, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-[24px] rounded-[4px] px-[8px] text-[13px] leading-[24px]',
                    index === PANEL_TABS.length
                      ? 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground)'
                      : 'text-[#9d9d9d]',
                  )}
                >
                  {tab}
                </span>
              ))}
            </div>
            <div className="wd-webview flex min-h-0 flex-1 flex-col">{props.panel}</div>
          </section>
        </main>
        <SecondarySideBar
          tabs={props.secondaryTabs}
          activeTab={props.activeSecondaryTab}
          onTab={props.onSecondaryTab}
          sections={props.sections}
          onToggleSection={props.onToggleSection}
        />
      </div>
      <StatusBar left={props.statusBar?.left} right={props.statusBar?.right} />
    </div>
  )
}
