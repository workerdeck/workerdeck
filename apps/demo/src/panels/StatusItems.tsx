import type { ReactNode } from 'react'
import {
  Activity,
  Bell,
  BellDot,
  Check,
  CircleSlash,
  CircleX,
  Gauge,
  GitBranch,
  Network,
  Pause,
  Shield,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { SessionVitals } from '@workerdeck/ui'
import {
  formatTokens,
  meterSeverity,
  modelLabel,
  statusPresentation,
  usageWindow,
  windowLabel,
  type StatusSeverity,
} from '@workerdeck/ui/format'
import { cn } from '@workerdeck/ui'

import { useGateway, useRows } from '../tour/react.tsx'

const STATUS_ICONS: Record<string, LucideIcon> = {
  check: Check,
  warning: TriangleAlert,
  error: CircleX,
  'debug-pause': Pause,
  'circle-slash': CircleSlash,
}

const SEVERITY: Record<StatusSeverity, string> = {
  none: '',
  warning: 'bg-[#8a5a00] text-white',
  error: 'bg-[#a1260d] text-white',
}

export function NativeStatusItems() {
  return (
    <>
      <span className="flex h-[24px] items-center rounded-[4px] pr-[6px] pl-[4px]">
        <svg viewBox="0 0 16 16" className="size-[16px]" fill="currentColor" aria-hidden>
          <path d="M6.2 3.2 1.4 8l4.8 4.8.9-.9L3.2 8l3.9-3.9-.9-.9Zm3.6 0-.9.9L12.8 8l-3.9 3.9.9.9L14.6 8 9.8 3.2Z" />
        </svg>
      </span>
      <Item icon={GitBranch}>main</Item>
      <Item icon={CircleX}>0</Item>
    </>
  )
}

export function WorkerDeckStatusItems({ vitals }: { vitals: SessionVitals | undefined }) {
  const gateway = useGateway()
  const rows = useRows(gateway)
  const waiting = rows.filter((row) => row.state === 'attention').length
  const unread = rows.filter((row) => row.unseen > 0).length
  const subagents = rows.reduce((sum, row) => sum + (row.info.subagents?.filter((agent) => agent.status === 'running').length ?? 0), 0)
  const presentation = statusPresentation(vitals)
  const running = vitals?.status === 'running' || vitals?.status === 'starting'
  const context = vitals?.capabilities?.contextUsage ? vitals.contextUsage : undefined
  const mode = vitals?.permissionMode
  const modeLabel = vitals?.permissionModes.find((choice) => choice.value === mode)?.label ?? mode
  return (
    <>
      {subagents > 0 ? (
        <Item region="subagents" icon={Network} className="text-[#3794ff]">
          {subagents}
        </Item>
      ) : null}
      {unread + waiting > 0 ? (
        <Item region="unread" icon={waiting > 0 ? BellDot : Bell} severity={waiting > 0 ? 'warning' : 'none'}>
          {unread + waiting}
        </Item>
      ) : null}
      {vitals ? (
        <Item
          region="status"
          icon={STATUS_ICONS[presentation.icon]}
          spin={presentation.icon.endsWith('~spin')}
          severity={presentation.severity}
          className={running ? 'text-[#3794ff]' : undefined}
        >
          {presentation.label}
        </Item>
      ) : null}
      {context ? (
        <Item region="context" icon={Gauge} severity={meterSeverity(context.percentage)}>
          {formatTokens(context.totalTokens)}
        </Item>
      ) : null}
      {(['session', 'weekly'] as const).map((lane) => {
        const window = usageWindow(vitals?.rateLimits, lane)
        const pct = window?.info.utilization
        return window ? (
          <Item key={lane} region={`usage-${lane}`} icon={Activity} severity={meterSeverity(pct)}>
            {`${windowLabel(window.key)} ${pct === undefined ? '-' : `${pct.toFixed(0)}%`}`}
          </Item>
        ) : null
      })}
      {vitals?.models.length ? (
        <Item region="model" icon={Sparkles}>
          {modelLabel(vitals)}
        </Item>
      ) : null}
      {mode && (vitals?.permissionModes.length ?? 0) > 1 ? (
        <Item region="mode" icon={Shield} severity={mode === 'bypassPermissions' ? 'warning' : 'none'}>
          {modeLabel}
        </Item>
      ) : null}
    </>
  )
}

type ItemProps = {
  icon?: LucideIcon
  spin?: boolean
  region?: string
  severity?: StatusSeverity
  className?: string
  children: ReactNode
}

function Item({ icon: Icon, spin, region, severity = 'none', className, children }: ItemProps) {
  return (
    <span
      data-demo-region={region ? `status:${region}` : undefined}
      className={cn('flex h-[24px] items-center gap-[4px] rounded-[4px] px-[5px] whitespace-nowrap', SEVERITY[severity], className)}
    >
      {spin ? (
        <span className="m-[2px] size-[12px] animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      ) : Icon ? (
        <Icon className="size-[16px]" strokeWidth={1.5} />
      ) : null}
      {children}
    </span>
  )
}
