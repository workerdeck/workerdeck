import SwiftUI
import WorkerDeckCore

// The two meter sheets the status line opens: what fills the context window, and the plan windows plus cost.
enum CoreMeterSheet: String, Identifiable {
  case context
  case usage

  var id: String { rawValue }
}

// The core's reading of how alarming a number is; a ring is neutral below it.
func severityTint(_ severity: Severity) -> Color {
  switch severity {
  case .error: .red
  case .warning: .orange
  case .none: .secondary
  }
}

// The status line's meters: the context ring, then one ring per plan window (session, weekly, then per model; three
// at most), or the session's cost when no window reports. Each opens its own sheet. Everything comes from the core's
// `SessionUsageView`; nothing here decides what is stale or alarming.
struct CoreUsageHud: View {
  let usage: SessionUsageView
  let open: (CoreMeterSheet) -> Void

  var body: some View {
    HStack(spacing: 12) {
      if let context = usage.context {
        Button { open(.context) } label: {
          RadialGauge(
            fraction: context.percentage / 100, tint: severityTint(context.severity),
            label: "\(min(99, max(0, Int(context.percentage.rounded()))))")
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Context \(Fmt.percent(context.percentage)) used")
        .accessibilityIdentifier("Context ring")
      }
      Button { open(.usage) } label: { usageLabel }
        .buttonStyle(.plain)
        .accessibilityIdentifier("Plan usage")
    }
    .fixedSize()
  }

  @ViewBuilder
  private var usageLabel: some View {
    let windows = Array(usage.windows.prefix(3))
    if !windows.isEmpty {
      HStack(spacing: 4) {
        ForEach(windows, id: \.key) { window in
          RadialGauge(
            fraction: window.utilization / 100, tint: usageTint(window.utilization), label: Self.initial(window.key)
          )
          .opacity(window.stale ? 0.45 : 1)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        windows.map { "\(Fmt.rateLimitWindow($0.key)) \(Fmt.percent($0.utilization))" }.joined(separator: ", "))
    } else if let cost = usage.cost.displayUsd, cost > 0 {
      Text(Fmt.cost(cost))
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .accessibilityLabel("Session cost \(Fmt.cost(cost))")
    } else {
      Image(systemName: "gauge").foregroundStyle(.secondary).accessibilityLabel("Usage")
    }
  }

  // 'five_hour' is S, 'seven_day' W, a per-model weekly its model's initial.
  static func initial(_ key: String) -> String {
    if key == "five_hour" { return "S" }
    if key == "seven_day" { return "W" }
    guard key.hasPrefix("seven_day_"), let first = key.dropFirst("seven_day_".count).first else { return "?" }
    return String(first).uppercased()
  }
}

// What is in the model's context window right now, category by category.
struct CoreContextSheet: View {
  let context: ContextView?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if let context {
          List {
            Section {
              LabeledContent("Used") {
                Text("\(Fmt.tokens(Int(context.totalTokens))) / \(Fmt.tokens(Int(context.maxTokens)))")
                  .monospacedDigit()
              }
              HStack(spacing: 6) {
                ProgressView(value: min(max(context.percentage, 0), 100), total: 100)
                  .tint(usageTint(context.percentage))
                Text(Fmt.percent(context.percentage)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
              }
            } footer: {
              if let model = context.model { Text(model) }
            }
            // Codex reports occupancy with no breakdown: no "Breakdown" header over nothing.
            if !context.categories.isEmpty {
              Section("Breakdown") {
                ForEach(Array(context.categories.enumerated()), id: \.offset) { _, slice in
                  slice.row(max: max(context.maxTokens, 1))
                }
              }
            }
          }
        } else {
          ContentUnavailableView {
            Label("No reading yet", systemImage: "chart.pie")
          } description: {
            Text("The context window is measured after a turn completes.")
          }
        }
      }
      .navigationTitle("Context")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
    }
  }
}

extension ContextSlice {
  // The wire `color` is often a CLI theme token rather than a color; it is honoured only when it parses.
  fileprivate func row(max: Int64) -> some View {
    let tint = Color(cliToken: color) ?? .accentColor
    return VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Circle().fill(tint).frame(width: 7, height: 7)
        Text(name).font(.caption)
        Spacer(minLength: 0)
        Text(Fmt.tokens(Int(tokens))).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      }
      ProgressView(value: Double(tokens), total: Double(max)).tint(tint)
    }
    .padding(.vertical, 2)
  }
}

// The plan's windows spelled out (used share, a pace marker at the elapsed share of the window, reset and freshness),
// then what the session cost and the evidence for it, the profile's spend, and the pricing note.
struct CoreUsageSheet: View {
  let usage: SessionUsageView
  @Environment(\.dismiss) private var dismiss

  private var claude: Bool { usage.engine == "claude" }
  private var engineName: String { claude ? "Claude Code" : usage.engine.capitalized }

  var body: some View {
    NavigationStack {
      List {
        Section {
          if usage.windows.isEmpty {
            Text(
              claude
                ? "No plan windows reported. API-key profiles have none, and a subscription account reports them once any of its sessions has run a turn."
                : "Plan windows are a claude.ai subscription thing; this session runs on the \(usage.engine) engine."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
          } else {
            TimelineView(.periodic(from: .now, by: 60)) { context in
              VStack(spacing: 14) {
                ForEach(Array(usage.windows.enumerated()), id: \.element.key) { index, window in
                  if index > 0 { Divider() }
                  CoreUsageWindowCard(window: window, now: context.date)
                }
              }
              .padding(.vertical, 4)
            }
          }
        } header: {
          header
        }
        costSection
        if let spend = usage.spend {
          Section("This profile") {
            LabeledContent("Last 7 days") { Text(Fmt.cost(spend.weekUsd)).monospacedDigit() }
            LabeledContent("Last 30 days") { Text(Fmt.cost(spend.monthUsd)).monospacedDigit() }
            if let ratio = spend.ratio, let share = spend.weeklyShareUsd, let monthly = spend.monthlyUsd {
              Text(
                "\(ratio >= 10 ? "\(Int(ratio.rounded()))x" : String(format: "%.1fx", ratio)) the \(Fmt.cost(share)) weekly share of your \(Fmt.cost(monthly)) a month. A subscription is a flat fee, so this is leverage, not a bill."
              )
              .font(.caption)
              .foregroundStyle(.secondary)
            }
          }
        }
        Section {
        } footer: {
          Text(usage.pricingNote)
        }
      }
      .navigationTitle("Usage")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
    }
  }

  // Whose limits these are. The plan capsule only when the engine said: it reports a tier ('max'), never a multiplier.
  private var header: some View {
    HStack(spacing: 8) {
      if claude {
        Image("ClaudeCode").resizable().aspectRatio(contentMode: .fit).frame(width: 22, height: 22)
          .accessibilityHidden(true)
      }
      Text(engineName).font(.headline).foregroundStyle(.primary)
      Spacer(minLength: 8)
      if let plan = usage.subscriptionType, !plan.isEmpty {
        Text(plan.capitalized)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(Color.secondary.opacity(0.16), in: Capsule())
      }
    }
    .textCase(nil)
    .padding(.bottom, 4)
  }

  private var costSection: some View {
    let cost = usage.cost
    return Section("This session") {
      LabeledContent("Cost") { Text(cost.displayUsd.map(Fmt.cost) ?? "none").monospacedDigit() }
      if !cost.rows.isEmpty {
        Group {
          LabeledContent("input", value: Fmt.cost(cost.input))
          LabeledContent("output", value: Fmt.cost(cost.output))
          LabeledContent("cache write", value: Fmt.cost(cost.cacheWrite))
          LabeledContent("cache read", value: Fmt.cost(cost.cacheRead))
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        ForEach(cost.rows, id: \.model) { row in
          LabeledContent(row.model) {
            Text("\(Fmt.tokens(Int(row.tokens))) · \(row.costUsd.map(Fmt.cost) ?? "no rate")").monospacedDigit()
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
      }
      if cost.showUnpricedWarning {
        Text(
          "\(Int((cost.unpricedShare * 100).rounded()))% of these tokens ran on a model with no bundled rate, so the total is an understatement rather than an estimate."
        )
        .font(.caption)
        .foregroundStyle(.orange)
      }
      if !cost.unknownBasisModels.isEmpty {
        Text(
          "\(engineName) matched no rate table of its own to \(cost.unknownBasisModels.joined(separator: ", ")), so the figure it reports for those tokens is a guess rather than a rate."
        )
        .font(.caption)
        .foregroundStyle(.orange)
      }
      if cost.gapUsd != nil, let reported = cost.reportedUsd {
        Text("\(engineName) reports \(Fmt.cost(reported)) for the same tokens.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct CoreUsageWindowCard: View {
  let window: UsageWindowView
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(Fmt.rateLimitWindowLong(window.key))
        Spacer(minLength: 8)
        Text("\(Fmt.percent(window.utilization)) used")
          .font(.body.weight(.semibold).monospacedDigit())
          .foregroundStyle(window.stale ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
      }
      CorePaceBar(fraction: window.utilization / 100, pace: pace, tint: usageTint(window.utilization))
        .opacity(window.stale ? 0.4 : 1)
      HStack(spacing: 5) {
        if let resetsAt = window.resetsAt, let text = Fmt.resets(epochSeconds: resetsAt, now: now) {
          Image(systemName: "arrow.counterclockwise")
          Text(text)
        }
        if window.overage { Text("overage").foregroundStyle(.orange) }
        if window.inferredReset {
          Text("window reset · nothing reported since")
        } else if let at = window.updatedAt {
          Text((window.stale ? "last reported " : "") + Fmt.agoPrecise(Date(timeIntervalSince1970: at / 1000), now: now))
            .foregroundStyle(window.stale ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  // The elapsed share of the window: where usage would be if it were spent evenly. Needs a duration and a reset.
  private var pace: Double? {
    guard let duration = Fmt.rateLimitWindowSeconds(window.key), let resetsAt = window.resetsAt else { return nil }
    let remaining = resetsAt - now.timeIntervalSince1970
    guard remaining > 0, remaining < duration else { return nil }
    return (duration - remaining) / duration
  }
}

// A linear meter with an optional pace marker standing over it, taller than the bar so it reads as a scale mark.
private struct CorePaceBar: View {
  let fraction: Double
  var pace: Double?
  var tint: Color

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      ZStack(alignment: .leading) {
        Capsule().fill(Color.secondary.opacity(0.22)).frame(height: 9)
        Capsule().fill(tint).frame(width: max(9, width * clamp(fraction)), height: 9)
        if let pace {
          Capsule().fill(Color.primary).frame(width: 3, height: 15)
            .offset(x: min(width - 3, max(0, width * clamp(pace) - 1.5)))
        }
      }
      .frame(height: 15)
    }
    .frame(height: 15)
  }

  private func clamp(_ value: Double) -> Double { min(max(value, 0), 1) }
}
