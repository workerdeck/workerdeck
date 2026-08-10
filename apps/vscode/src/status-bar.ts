// The agent's status bar, rendered as VS Code's own — the window status bar is
// where an IDE user already looks for "what is running", and the webview panel
// sits inside that window, so drawing a second bar inside it was one bar too
// many. The panel's React bar is suppressed (`statusSurface='external'`) and its
// readings arrive here over `wd-vitals`.
//
// Three items, not one: the bar answers three different questions (is it alive,
// how full is the window, how much plan is left) and each has its own section
// view to focus. One item would mean one click target for three destinations.
import * as vscode from 'vscode'
import type { ContextUsage, RateLimitInfo, SessionStatus } from '@workerdeck/protocol'
import type { SessionVitals } from '@workerdeck/ui'
import { formatCost, formatCountdown, formatTokens } from '@workerdeck/ui/format'

/** What the status item shows, before VS Code types get involved — pure, so the
 * mapping is readable in one place and testable without a window. */
export type StatusPresentation = {
  icon: string
  label: string
  /** Drives the item background. `none` leaves it in the bar's own colour. */
  severity: 'none' | 'warning' | 'error'
}

const STATUS_META: Record<SessionStatus, StatusPresentation> = {
  starting: { icon: 'loading~spin', label: 'Starting', severity: 'none' },
  running: { icon: 'loading~spin', label: 'Running', severity: 'none' },
  awaiting_approval: { icon: 'warning', label: 'Needs approval', severity: 'warning' },
  idle: { icon: 'check', label: 'Idle', severity: 'none' },
  parked: { icon: 'debug-pause', label: 'Parked', severity: 'none' },
  failed: { icon: 'error', label: 'Failed', severity: 'error' },
  closed: { icon: 'circle-slash', label: 'Closed', severity: 'none' },
}

/**
 * The status slot, connection first. A session status held over a dead socket is
 * the last thing we heard, not the current state — so a lost link takes the slot
 * rather than letting "Running" imply a turn is still streaming. Same rule the
 * panel's own bar follows.
 */
export function statusPresentation(vitals: SessionVitals | undefined): StatusPresentation {
  if (!vitals) return { icon: 'hubot', label: 'Connecting…', severity: 'none' }
  if (vitals.connection === 'offline') {
    return { icon: 'debug-disconnect', label: 'Offline', severity: 'error' }
  }
  if (vitals.connection === 'reconnecting') {
    return { icon: 'sync~spin', label: 'Reconnecting…', severity: 'warning' }
  }
  return STATUS_META[vitals.status] ?? { icon: 'hubot', label: vitals.status, severity: 'none' }
}

/** 0–100 → the colour a meter wears. Mirrors the panel's 80/95 thresholds. */
export function meterSeverity(pct: number | undefined): 'none' | 'warning' | 'error' {
  if (pct === undefined) return 'none'
  if (pct >= 95) return 'error'
  if (pct >= 80) return 'warning'
  return 'none'
}

/** The rate-limit window that gets the one visible slot: whichever is fullest,
 * since the binding constraint is the one worth glancing at. */
export function tightestWindow(
  rateLimits: Record<string, RateLimitInfo> | undefined,
): { key: string; info: RateLimitInfo } | undefined {
  const entries = Object.entries(rateLimits ?? {})
  if (entries.length === 0) return undefined
  let best: { key: string; info: RateLimitInfo } | undefined
  for (const [key, info] of entries) {
    // A rejected window outranks any utilization: it is the one actually blocking.
    const rank = info.status === 'rejected' ? Number.POSITIVE_INFINITY : (info.utilization ?? -1)
    const bestRank =
      best === undefined
        ? Number.NEGATIVE_INFINITY
        : best.info.status === 'rejected'
          ? Number.POSITIVE_INFINITY
          : (best.info.utilization ?? -1)
    if (rank > bestRank) best = { key, info }
  }
  return best
}

function windowLabel(key: string): string {
  if (key === 'five_hour') return 'Session'
  if (key === 'seven_day') return 'Weekly'
  return key.replaceAll('_', ' ')
}

function severityBackground(severity: 'none' | 'warning' | 'error'): vscode.ThemeColor | undefined {
  if (severity === 'warning') return new vscode.ThemeColor('statusBarItem.warningBackground')
  if (severity === 'error') return new vscode.ThemeColor('statusBarItem.errorBackground')
  return undefined
}

function contextTooltip(usage: ContextUsage): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**Context** — ${usage.percentage.toFixed(0)}% of the window\n\n`)
  for (const category of usage.categories) {
    md.appendMarkdown(`- ${category.name}: \`${formatTokens(category.tokens)}\`\n`)
  }
  md.appendMarkdown(
    `\n**Total** \`${formatTokens(usage.totalTokens)}\` / \`${formatTokens(usage.maxTokens)}\``,
  )
  return md
}

function usageTooltip(rateLimits: Record<string, RateLimitInfo>, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown('**Plan usage**\n\n')
  for (const [key, info] of Object.entries(rateLimits)) {
    const pct = info.utilization !== undefined ? `${info.utilization.toFixed(1)}%` : '—'
    md.appendMarkdown(`- ${windowLabel(key)}: \`${pct}\``)
    if (info.resetsAt !== undefined) {
      md.appendMarkdown(` · resets in ${formatCountdown(info.resetsAt * 1000, now)}`)
    }
    if (info.status === 'rejected') md.appendMarkdown(' · **limit reached**')
    else if (info.isUsingOverage) md.appendMarkdown(' · using overage')
    md.appendMarkdown('\n')
  }
  return md
}

/** How often the countdowns in the usage tooltip are re-rendered. The panel's
 * bar ticks at the same rate; a minute-resolution countdown needs no finer. */
const TICK_MS = 30_000

export type StatusBarSubject = {
  title: string | undefined
  hostName: string
  cost: number | undefined
}

/**
 * Owns the three items. Fed by `update()` — from the panel's vitals relay, from
 * a selection change, and from the sessions poll (which is what renames the
 * item when a session is retitled elsewhere).
 */
export class SessionStatusBar implements vscode.Disposable {
  readonly #status: vscode.StatusBarItem
  readonly #context: vscode.StatusBarItem
  readonly #usage: vscode.StatusBarItem
  #subject: StatusBarSubject | undefined
  #vitals: SessionVitals | undefined
  #timer: ReturnType<typeof setInterval> | undefined

  constructor() {
    // Descending priority within Left alignment lays them out status → context
    // → usage, reading order. 50 is where the single item used to sit, so the
    // group keeps its place relative to other extensions' items.
    this.#status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    this.#context = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49)
    this.#usage = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48)
    // Each gauge leads to the view that answers *its* question — the same
    // targets the panel's bar routed to before it moved out here.
    this.#status.command = 'workerdeck.sessionInfo.focus'
    this.#context.command = 'workerdeck.context.focus'
    this.#usage.command = 'workerdeck.usage.focus'
  }

  /** `subject: undefined` = no session selected; everything hides. */
  update(subject: StatusBarSubject | undefined, vitals: SessionVitals | undefined): void {
    this.#subject = subject
    this.#vitals = vitals
    this.#render()
  }

  #render(): void {
    const subject = this.#subject
    if (!subject) {
      this.#status.hide()
      this.#context.hide()
      this.#usage.hide()
      this.#stopTicking()
      return
    }
    const vitals = this.#vitals
    const now = Date.now()
    const name = subject.title ?? 'Session'

    const presentation = statusPresentation(vitals)
    this.#status.text = `$(${presentation.icon}) ${presentation.label}`
    this.#status.backgroundColor = severityBackground(presentation.severity)
    const tip = new vscode.MarkdownString()
    tip.appendMarkdown(`**${name}** on ${subject.hostName}\n\n`)
    tip.appendMarkdown(`Status: ${presentation.label}\n\n`)
    if (vitals?.model) tip.appendMarkdown(`Model: \`${vitals.model}\`\n\n`)
    if (subject.cost !== undefined) tip.appendMarkdown(`Cost: ${formatCost(subject.cost)}`)
    this.#status.tooltip = tip
    this.#status.show()

    // Capability gating, same rule as the panel: an engine that reports no
    // context window gets no context item, rather than an empty one.
    const usage = vitals?.capabilities?.contextUsage ? vitals.contextUsage : undefined
    if (usage) {
      this.#context.text = `$(dashboard) ${formatTokens(usage.totalTokens)}`
      this.#context.backgroundColor = severityBackground(meterSeverity(usage.percentage))
      this.#context.tooltip = contextTooltip(usage)
      this.#context.show()
    } else {
      this.#context.hide()
    }

    const rateLimits = vitals?.rateLimits
    const tightest = tightestWindow(rateLimits)
    if (rateLimits && tightest) {
      const pct = tightest.info.utilization
      // No made-up 0%: the CLI omits utilization on some updates, and an
      // invented number here would read as a real one.
      const reading = pct !== undefined ? `${pct.toFixed(0)}%` : '—'
      this.#usage.text = `$(pulse) ${windowLabel(tightest.key)} ${reading}`
      this.#usage.backgroundColor = severityBackground(
        tightest.info.status === 'rejected' ? 'error' : meterSeverity(pct),
      )
      this.#usage.tooltip = usageTooltip(rateLimits, now)
      this.#usage.show()
      this.#startTicking()
    } else {
      this.#usage.hide()
      this.#stopTicking()
    }
  }

  // The countdowns are the only thing here that goes stale without new events,
  // so the timer runs only while a window is on screen.
  #startTicking(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.#render(), TICK_MS)
  }

  #stopTicking(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  dispose(): void {
    this.#stopTicking()
    this.#status.dispose()
    this.#context.dispose()
    this.#usage.dispose()
  }
}
