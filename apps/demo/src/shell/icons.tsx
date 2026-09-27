import add from './assets/add.svg'
import arrowLeft from './assets/arrow-left.svg'
import arrowRight from './assets/arrow-right.svg'
import chevronDown from './assets/chevron-down.svg'
import chevronRight from './assets/chevron-right.svg'
import close from './assets/close.svg'
import dockBottom from './assets/dock-bottom.svg'
import dockLayout from './assets/dock-layout.svg'
import dockLeft from './assets/dock-left.svg'
import dockRight from './assets/dock-right.svg'
import explorer from './assets/explorer.svg'
import extensions from './assets/extensions.svg'
import filter from './assets/filter.svg'
import maximize from './assets/maximize.svg'
import more from './assets/more.svg'
import refresh from './assets/refresh.svg'
import remote from './assets/remote.svg'
import run from './assets/run.svg'
import scm from './assets/scm.svg'
import search from './assets/search.svg'

export const shellIcons = {
  add,
  arrowLeft,
  arrowRight,
  chevronDown,
  chevronRight,
  close,
  dockBottom,
  dockLayout,
  dockLeft,
  dockRight,
  explorer,
  extensions,
  filter,
  maximize,
  more,
  refresh,
  remote,
  run,
  scm,
  search,
}

export type ShellIconName = keyof typeof shellIcons

type ShellIconButtonProps = {
  icon: ShellIconName
  label: string
  onClick?: () => void
}

export function ShellIcon({ icon }: { icon: ShellIconName }) {
  return <img alt="" src={shellIcons[icon]} className="block size-[16px] shrink-0" draggable={false} />
}

export function ShellIconButton({ icon, label, onClick }: ShellIconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex shrink-0 items-center rounded-[4px] p-[3px] hover:bg-(--vscode-toolbar-hoverBackground)"
    >
      <ShellIcon icon={icon} />
    </button>
  )
}
