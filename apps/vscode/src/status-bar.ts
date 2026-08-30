// The agent's status bar, rendered as VS Code's own: the window status bar is
// where an IDE user already looks for "what is running", so the panel's React bar
// is suppressed (`statusSurface='external'`) and its readings arrive here over
// `wd-vitals`. Separate items, not one, because each has its own section view to
// focus and one item would mean one click target for many destinations.
//
// `UnreadStatusItem` and `SubagentStatusItem` live here because this is where the
// window bar is owned, not because they share the others' lifecycle: everything
// else on this bar is about the session on screen and hides when there is none.
import * as vscode from 'vscode'
import type { ContextUsage, RateLimitInfo } from '@workerdeck/protocol'
import type { SessionVitals } from '@workerdeck/ui'
import {
  currentModel,
  formatCost,
  formatCountdown,
  formatTokens,
  meterSeverity,
  modelLabel,
  statusPresentation,
  tightestWindow,
  usageWindow,
  windowLabel,
} from '@workerdeck/ui/format'
import type { StatusSeverity, UsageLane } from '@workerdeck/ui/format'

// The status *presentation* rules live in `@workerdeck/ui/format`, since every
// surface that draws a session's readings has to agree on them. Re-exported
// because the QuickPick commands read them too.
export { currentModel, meterSeverity, modelLabel, statusPresentation, tightestWindow }
export type { StatusPresentation } from '@workerdeck/ui/format'

/** The badges, each its own boolean setting — checkboxes in the Settings UI, which
 * an array-of-enum or an object map would not be. Read per render rather than
 * cached: `activate` re-renders the bar on a config change. */
export type StatusBadge = 'unread' | 'subagents' | 'status' | 'context' | 'sessionUsage' | 'weeklyUsage' | 'modelUsage' | 'model' | 'mode'

/** How often the countdowns in the usage tooltip are re-rendered. */
const TICK_MS = 30_000

/** The three usage badges, in bar order, paired with the lane each reads.
 * Iterated rather than unrolled so the item, the setting and the lane cannot drift. */
const USAGE_BADGES: readonly { badge: StatusBadge; lane: UsageLane }[] = [
  { badge: 'sessionUsage', lane: 'session' },
  { badge: 'weeklyUsage', lane: 'weekly' },
  { badge: 'modelUsage', lane: 'model' },
]

/** Not every badge defaults on: three usage numbers in the bar by default is a
 * status bar nobody reads. */
const BADGE_DEFAULT: Partial<Record<StatusBadge, boolean>> = { modelUsage: false }

const severityBackground = (severity: StatusSeverity): vscode.ThemeColor | undefined => {
  if (severity === 'warning') {
    return new vscode.ThemeColor('statusBarItem.warningBackground')
  }
  if (severity === 'error') {
    return new vscode.ThemeColor('statusBarItem.errorBackground')
  }
  return undefined
}

/**
 * A working session's badge, coloured on the **foreground**.
 * `StatusBarItem.backgroundColor` accepts exactly `statusBarItem.errorBackground`
 * and `statusBarItem.warningBackground` and silently ignores anything else — and
 * both are alarm colours, which is the wrong thing to say about a session doing its
 * job. `charts.blue` is a theme token, so it tracks the user's theme.
 */
const statusForeground = (status: string | undefined): vscode.ThemeColor | undefined => {
  return status === 'running' || status === 'starting' ? new vscode.ThemeColor('charts.blue') : undefined
}

const contextTooltip = (usage: ContextUsage): vscode.MarkdownString => {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**Context** — ${usage.percentage.toFixed(0)}% of the window\n\n`)
  for (const category of usage.categories) {
    md.appendMarkdown(`- ${category.name}: \`${formatTokens(category.tokens)}\`\n`)
  }
  md.appendMarkdown(`\n**Total** \`${formatTokens(usage.totalTokens)}\` / \`${formatTokens(usage.maxTokens)}\``)
  return md
}

const usageTooltip = (rateLimits: Record<string, RateLimitInfo>, now: number): vscode.MarkdownString => {
  const md = new vscode.MarkdownString()
  md.appendMarkdown('**Plan usage**\n\n')
  for (const [key, info] of Object.entries(rateLimits)) {
    const pct = info.utilization !== undefined ? `${info.utilization.toFixed(1)}%` : '—'
    md.appendMarkdown(`- ${windowLabel(key)}: \`${pct}\``)
    if (info.resetsAt !== undefined) {
      md.appendMarkdown(` · resets in ${formatCountdown(info.resetsAt * 1000, now)}`)
    }
    if (info.status === 'rejected') {
      md.appendMarkdown(' · **limit reached**')
    } else if (info.isUsingOverage) {
      md.appendMarkdown(' · using overage')
    }
    md.appendMarkdown('\n')
  }
  return md
}

export const badgeEnabled = (badge: StatusBadge): boolean => {
  return vscode.workspace.getConfiguration('workerdeck.statusBar').get<boolean>(badge, BADGE_DEFAULT[badge] ?? true)
}

/**
 * The unread count: transcript rows produced since this window last had each
 * session on screen, summed over **only the sessions the Sessions view's filter is
 * showing** — a number announcing work in a session the filter or the workspace
 * scope hides sends you looking for something that isn't there. Sessions waiting on
 * a human lead the tooltip and colour the item without replacing the count.
 */
export class UnreadStatusItem implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem
  #rows = 0
  #waiting = 0

  constructor() {
    // 51 — one above the session group (50…44), so it sits leftmost in the Left cluster.
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51)
    this.#item.command = 'workerdeck.sessions.focus'
  }

  update(rows: number, waiting: number): void {
    this.#rows = rows
    this.#waiting = waiting
    this.render()
  }

  /** Re-render against unchanged readings — for a settings change. */
  render(): void {
    const rows = this.#rows
    const waiting = this.#waiting
    if (!badgeEnabled('unread') || rows <= 0) {
      this.#item.hide()
      return
    }
    this.#item.text = `$(${waiting > 0 ? 'bell-dot' : 'bell'}) ${rows}`
    this.#item.backgroundColor = severityBackground(waiting > 0 ? 'warning' : 'none')
    const tip = new vscode.MarkdownString()
    if (waiting > 0) {
      tip.appendMarkdown(`**${waiting} session${waiting === 1 ? '' : 's'} awaiting approval**\n\n`)
    }
    tip.appendMarkdown(`${rows} new row${rows === 1 ? '' : 's'} since you last looked\n\n`)
    tip.appendMarkdown('Click to open the Sessions view.')
    this.#item.tooltip = tip
    this.#item.show()
  }

  dispose(): void {
    this.#item.dispose()
  }
}

/**
 * How many sub-agents are running right now, across the sessions the Sessions
 * view's filter is showing. Its own item rather than part of `SessionStatusBar`
 * because, like unread, it is about *every* session and is most worth showing when
 * no panel is open. Foreground-coloured, for the reason `statusForeground` gives.
 */
export class SubagentStatusItem implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem
  #running = 0
  #sessions = 0

  constructor() {
    // 52 — outside the session group and above unread; this signal is the rarer one.
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 52)
    this.#item.command = 'workerdeck.sessions.focus'
    this.#item.color = new vscode.ThemeColor('charts.blue')
  }

  /** @param running total sub-agents in flight. @param sessions how many sessions
   * they are spread across — "6 agents" in one session and in four are different days. */
  update(running: number, sessions: number): void {
    this.#running = running
    this.#sessions = sessions
    this.render()
  }

  /** Re-render against unchanged readings — for a settings change. */
  render(): void {
    const running = this.#running
    // Zero hides rather than showing `0`: a permanent zero is a thing people learn to stop seeing.
    if (!badgeEnabled('subagents') || running <= 0) {
      this.#item.hide()
      return
    }
    this.#item.text = `$(type-hierarchy-sub) ${running}`
    const tip = new vscode.MarkdownString()
    tip.appendMarkdown(`**${running} sub-agent${running === 1 ? '' : 's'} running**`)
    if (this.#sessions > 1) {
      tip.appendMarkdown(` across ${this.#sessions} sessions`)
    }
    tip.appendMarkdown('\n\nClick to open the Sessions view, where each session lists its own.')
    this.#item.tooltip = tip
    this.#item.show()
  }

  dispose(): void {
    this.#item.dispose()
  }
}

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
  /** One per {@link USAGE_BADGES} entry, same order. */
  readonly #usage: readonly vscode.StatusBarItem[]
  readonly #model: vscode.StatusBarItem
  readonly #mode: vscode.StatusBarItem
  #subject: StatusBarSubject | undefined
  #vitals: SessionVitals | undefined
  #timer: ReturnType<typeof setInterval> | undefined

  constructor() {
    // Descending priority within Left alignment lays them out in reading order.
    this.#status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    this.#context = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49)
    this.#usage = USAGE_BADGES.map((_, index) => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48 - index))
    // The two controls, after the gauges. A status bar item has one command and no
    // dropdown of its own, so command → QuickPick is the only shape VS Code offers.
    this.#model = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45)
    this.#mode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 44)
    // Each gauge leads to the view that answers *its* question.
    this.#status.command = 'workerdeck.sessionInfo.focus'
    this.#context.command = 'workerdeck.context.focus'
    for (const item of this.#usage) {
      item.command = 'workerdeck.usage.focus'
    }
    this.#model.command = 'workerdeck.selectModel'
    this.#mode.command = 'workerdeck.selectPermissionMode'
  }

  /** Every item, for the two places that touch all of them. */
  get #items(): vscode.StatusBarItem[] {
    return [this.#status, this.#context, ...this.#usage, this.#model, this.#mode]
  }

  /** `subject: undefined` = no session selected; everything hides. */
  update(subject: StatusBarSubject | undefined, vitals: SessionVitals | undefined): void {
    this.#subject = subject
    this.#vitals = vitals
    this.#render()
  }

  /** Re-render against unchanged readings — for a settings change. */
  refresh(): void {
    this.#render()
  }

  #render(): void {
    const subject = this.#subject
    if (!subject) {
      for (const item of this.#items) {
        item.hide()
      }
      this.#stopTicking()
      return
    }
    const vitals = this.#vitals
    const now = Date.now()
    const name = subject.title ?? 'Session'

    if (badgeEnabled('status')) {
      const presentation = statusPresentation(vitals)
      this.#status.text = `$(${presentation.icon}) ${presentation.label}`
      this.#status.backgroundColor = severityBackground(presentation.severity)
      // Only when the badge is otherwise plain: an alarm background sets its own foreground.
      this.#status.color = presentation.severity === 'none' ? statusForeground(vitals?.status) : undefined
      const tip = new vscode.MarkdownString()
      tip.appendMarkdown(`**${name}** on ${subject.hostName}\n\n`)
      tip.appendMarkdown(`Status: ${presentation.label}\n\n`)
      if (vitals?.model) {
        tip.appendMarkdown(`Model: \`${vitals.model}\`\n\n`)
      }
      if (subject.cost !== undefined) {
        tip.appendMarkdown(`Cost: ${formatCost(subject.cost)}`)
      }
      this.#status.tooltip = tip
      this.#status.show()
    } else {
      this.#status.hide()
    }

    // Capability gating, same rule as the panel: no context window reported, no item.
    const usage = badgeEnabled('context') && vitals?.capabilities?.contextUsage ? vitals.contextUsage : undefined
    if (usage) {
      this.#context.text = `$(dashboard) ${formatTokens(usage.totalTokens)}`
      this.#context.backgroundColor = severityBackground(meterSeverity(usage.percentage))
      this.#context.tooltip = contextTooltip(usage)
      this.#context.show()
    } else {
      this.#context.hide()
    }

    // A lane the account has no window for hides rather than showing a dash.
    const rateLimits = vitals?.rateLimits
    let anyUsage = false
    for (const [index, { badge, lane }] of USAGE_BADGES.entries()) {
      const item = this.#usage[index]!
      const window = badgeEnabled(badge) ? usageWindow(rateLimits, lane) : undefined
      if (!window) {
        item.hide()
        continue
      }
      const pct = window.info.utilization
      // No made-up 0%: the CLI omits utilization on some updates.
      const reading = pct !== undefined ? `${pct.toFixed(0)}%` : '—'
      item.text = `$(pulse) ${windowLabel(window.key)} ${reading}`
      item.backgroundColor = severityBackground(window.info.status === 'rejected' ? 'error' : meterSeverity(pct))
      // One tooltip for all three: "and the others?" is asked of whichever you point at.
      item.tooltip = usageTooltip(rateLimits ?? {}, now)
      item.show()
      anyUsage = true
    }
    if (anyUsage) {
      this.#startTicking()
    } else {
      this.#stopTicking()
    }

    // Each picker is shown only where switching is possible: an empty QuickPick is worse than no item.
    if (badgeEnabled('model') && vitals?.models.length) {
      this.#model.text = `$(sparkle) ${modelLabel(vitals)}`
      this.#model.tooltip = 'WorkerDeck: switch model'
      this.#model.show()
    } else {
      this.#model.hide()
    }

    const mode = vitals?.permissionMode
    if (badgeEnabled('mode') && mode && vitals.permissionModes.length > 1) {
      const meta = vitals.permissionModes.find((m) => m.value === mode)
      this.#mode.text = `$(shield) ${meta?.label ?? mode}`
      this.#mode.backgroundColor = severityBackground(mode === 'bypassPermissions' ? 'warning' : 'none')
      this.#mode.tooltip = 'WorkerDeck: switch permission mode'
      this.#mode.show()
    } else {
      this.#mode.hide()
    }
  }

  // The countdowns are the only thing that goes stale without new events.
  #startTicking(): void {
    if (this.#timer) {
      return
    }
    this.#timer = setInterval(() => this.#render(), TICK_MS)
  }

  #stopTicking(): void {
    if (!this.#timer) {
      return
    }
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  dispose(): void {
    this.#stopTicking()
    for (const item of this.#items) {
      item.dispose()
    }
  }
}
