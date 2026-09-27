import { ShellIcon } from './icons.tsx'
import type { ShellIconName } from './icons.tsx'

const ACTIVITIES: { icon: ShellIconName; label: string }[] = [
  { icon: 'explorer', label: 'Explorer' },
  { icon: 'remote', label: 'Remote Explorer' },
  { icon: 'search', label: 'Search' },
  { icon: 'run', label: 'Run and Debug' },
  { icon: 'extensions', label: 'Extensions' },
  { icon: 'scm', label: 'Source Control' },
]

export function ActivityBar() {
  return (
    <nav data-demo-region="activity-bar" className="flex w-[36px] shrink-0 flex-col gap-[4px] py-[4px] pl-[4px]">
      {ACTIVITIES.map(({ icon, label }, index) => (
        <button
          key={icon}
          type="button"
          aria-label={label}
          title={label}
          className={
            index === 0
              ? 'flex size-[28px] items-center justify-center rounded-[4px] bg-[#ffffff22]'
              : 'flex size-[28px] items-center justify-center rounded-[4px] opacity-70 hover:opacity-100'
          }
        >
          <ShellIcon icon={icon} />
        </button>
      ))}
    </nav>
  )
}
