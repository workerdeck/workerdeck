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
  windowLabel,
} from '@workerdeck/ui/format'
import type { StatusSeverity } from '@workerdeck/ui/format'

// The status *presentation* rules — which icon and severity a status wears,
// where the 80/95 meter thresholds sit, which rate-limit window is the binding
// one, and the lenient model match — moved to `@workerdeck/ui/format`. Every
// surface that draws a session's readings has to agree on them, and this bar is
// only one of them. Re-exported because the QuickPick commands read them too.
export { currentModel, meterSeverity, modelLabel, statusPresentation, tightestWindow }
export type { StatusPresentation } from '@workerdeck/ui/format'

function severityBackground(severity: StatusSeverity): vscode.ThemeColor | undefined {
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

/** The three badges, each its own boolean setting — checkboxes in the Settings
 * UI, which an array-of-enum or an object map would not be. Read per render
 * rather than cached: `activate` re-renders the bar on a config change, and the
 * live read is what makes that one line. */
export type StatusBadge = 'status' | 'context' | 'usage' | 'model' | 'mode'

export function badgeEnabled(badge: StatusBadge): boolean {
  return vscode.workspace.getConfiguration('workerdeck.statusBar').get<boolean>(badge, true)
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
  readonly #usage: vscode.StatusBarItem
  readonly #model: vscode.StatusBarItem
  readonly #mode: vscode.StatusBarItem
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
    // The two controls, after the gauges. A status bar item has one command and
    // no dropdown of its own — the native pattern (language mode, encoding) is
    // command → QuickPick, which is what these open.
    this.#model = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47)
    this.#mode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46)
    // Each gauge leads to the view that answers *its* question — the same
    // targets the panel's bar routed to before it moved out here.
    this.#status.command = 'workerdeck.sessionInfo.focus'
    this.#context.command = 'workerdeck.context.focus'
    this.#usage.command = 'workerdeck.usage.focus'
    this.#model.command = 'workerdeck.selectModel'
    this.#mode.command = 'workerdeck.selectPermissionMode'
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
      for (const item of [this.#status, this.#context, this.#usage, this.#model, this.#mode]) {
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
      const tip = new vscode.MarkdownString()
      tip.appendMarkdown(`**${name}** on ${subject.hostName}\n\n`)
      tip.appendMarkdown(`Status: ${presentation.label}\n\n`)
      if (vitals?.model) tip.appendMarkdown(`Model: \`${vitals.model}\`\n\n`)
      if (subject.cost !== undefined) tip.appendMarkdown(`Cost: ${formatCost(subject.cost)}`)
      this.#status.tooltip = tip
      this.#status.show()
    } else {
      this.#status.hide()
    }

    // Capability gating, same rule as the panel: an engine that reports no
    // context window gets no context item, rather than an empty one.
    const usage =
      badgeEnabled('context') && vitals?.capabilities?.contextUsage
        ? vitals.contextUsage
        : undefined
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
    if (badgeEnabled('usage') && rateLimits && tightest) {
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

    // The two pickers. Each is shown only where switching is actually possible:
    // an item that opens an empty QuickPick is worse than no item.
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
      this.#mode.backgroundColor = severityBackground(
        mode === 'bypassPermissions' ? 'warning' : 'none',
      )
      this.#mode.tooltip = 'WorkerDeck: switch permission mode'
      this.#mode.show()
    } else {
      this.#mode.hide()
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
    for (const item of [this.#status, this.#context, this.#usage, this.#model, this.#mode]) {
      item.dispose()
    }
  }
}

