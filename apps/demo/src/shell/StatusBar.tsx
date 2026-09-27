import type { ReactNode } from 'react'

type StatusBarProps = {
  left?: ReactNode
  right?: ReactNode
}

export function StatusBar({ left, right }: StatusBarProps) {
  return (
    <footer
      data-demo-region="status-bar"
      className="flex h-[28px] shrink-0 items-start justify-between gap-[12px] bg-(--vscode-statusBar-background) px-[4px] pb-[4px] text-[12px] text-(--vscode-statusBar-foreground) select-none"
    >
      <div className="flex h-[24px] min-w-0 items-center">{left}</div>
      <div className="flex h-[24px] min-w-0 items-center">{right}</div>
    </footer>
  )
}
