import { ShellIconButton } from './icons.tsx'
import type { ShellIconName } from './icons.tsx'

const TRAFFIC_LIGHTS = ['#ec6765', '#f2ca44', '#65c466']
const DOCK_ICONS: ShellIconName[] = ['dockLayout', 'dockLeft', 'dockBottom', 'dockRight']

export function TitleBar({ title }: { title: string }) {
  return (
    <header data-demo-region="title-bar" className="grid h-[35px] shrink-0 grid-cols-[1fr_auto_1fr] items-center select-none">
      <div className="flex gap-[8px] px-[12px]">
        {TRAFFIC_LIGHTS.map((color) => (
          <span key={color} className="size-[12px] rounded-full border border-black/40" style={{ background: color }} />
        ))}
      </div>
      <div className="flex items-center gap-[4px]">
        <ShellIconButton icon="arrowLeft" label="Back" />
        <ShellIconButton icon="arrowRight" label="Forward" />
        <div className="ml-[4px] flex h-[24px] w-[38vw] max-w-[500px] items-center overflow-hidden rounded-[6px] border border-[#9d9d9d40] bg-[#ffffff0d] px-[10px] text-[12px] text-[#9d9d9d]">
          <span className="truncate">{title}</span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-[2px] px-[8px]">
        {DOCK_ICONS.map((icon) => (
          <ShellIconButton key={icon} icon={icon} label={icon} />
        ))}
      </div>
    </header>
  )
}
