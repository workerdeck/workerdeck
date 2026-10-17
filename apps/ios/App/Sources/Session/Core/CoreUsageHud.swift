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

// A bar's fill and a plan window's ring, on the core's earlier 70/90 ramp: the accent until it turns.
func barTint(_ severity: Severity) -> Color {
  switch severity {
  case .error: .red
  case .warning: .orange
  case .none: .accentColor
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
          RadialGauge(fraction: context.fill, tint: severityTint(context.severity), label: context.ringLabel)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(context.accessibilityLabel)
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
          RadialGauge(fraction: window.fill, tint: barTint(window.barSeverity), label: window.initial)
          .opacity(window.stale ? 0.45 : 1)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(usage.hudLabel)
    } else if let cost = usage.hudCostText {
      Text(cost)
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .accessibilityLabel("Session cost \(cost)")
    } else {
      Image(systemName: "gauge").foregroundStyle(.secondary).accessibilityLabel("Usage")
    }
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
                Text(context.usedText).monospacedDigit()
              }
              HStack(spacing: 6) {
                ProgressView(value: context.fill).tint(barTint(context.barSeverity))
                Text(context.percentText).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
              }
            } footer: {
              if let model = context.model { Text(model) }
            }
            // Codex reports occupancy with no breakdown: no "Breakdown" header over nothing.
            if !context.categories.isEmpty {
              Section("Breakdown") {
                ForEach(Array(context.categories.enumerated()), id: \.offset) { _, slice in
                  slice.row
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
  fileprivate var row: some View {
    let tint = Color(cliToken: color) ?? .accentColor
    return VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Circle().fill(tint).frame(width: 7, height: 7)
        Text(name).font(.caption)
        Spacer(minLength: 0)
        Text(tokensText).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      }
      ProgressView(value: fill).tint(tint)
    }
    .padding(.vertical, 2)
  }
}

// The plan's windows spelled out (used share, a pace marker at the elapsed share of the window, reset and freshness),
// then what the session cost and the evidence for it, the profile's spend, and the pricing note.
struct CoreUsageSheet: View {
  let usage: SessionUsageView
  // A fresh reading at a given time: resets and freshness lines move with the clock, not with the session.
  var reading: (Date) -> SessionUsageView? = { _ in nil }
  @Environment(\.dismiss) private var dismiss

  private var claude: Bool { usage.engine == "claude" }

  var body: some View {
    NavigationStack {
      List {
        Section {
          if usage.windows.isEmpty {
            Text(usage.windowsEmptyText)
            .font(.callout)
            .foregroundStyle(.secondary)
          } else {
            TimelineView(.periodic(from: .now, by: 60)) { context in
              let windows = reading(context.date)?.windows ?? usage.windows
              VStack(spacing: 14) {
                ForEach(Array(windows.enumerated()), id: \.element.key) { index, window in
                  if index > 0 { Divider() }
                  CoreUsageWindowCard(window: window)
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
            LabeledContent("Last 7 days") { Text(spend.weekText).monospacedDigit() }
            LabeledContent("Last 30 days") { Text(spend.monthText).monospacedDigit() }
            if let ratio = spend.ratioText {
              Text(ratio)
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
      Text(usage.engineName).font(.headline).foregroundStyle(.primary)
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
      LabeledContent("Cost") { Text(cost.displayText).monospacedDigit() }
      if !cost.rows.isEmpty {
        Group {
          LabeledContent("input", value: cost.inputText)
          LabeledContent("output", value: cost.outputText)
          LabeledContent("cache write", value: cost.cacheWriteText)
          LabeledContent("cache read", value: cost.cacheReadText)
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        ForEach(cost.rows, id: \.model) { row in
          LabeledContent(row.model) {
            Text(row.text).monospacedDigit()
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
      }
      if let text = cost.unpricedText {
        Text(text).font(.caption).foregroundStyle(.orange)
      }
      if let text = cost.unknownBasisText {
        Text(text).font(.caption).foregroundStyle(.orange)
      }
      if let text = cost.gapText {
        Text(text).font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

private struct CoreUsageWindowCard: View {
  let window: UsageWindowView

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(window.longLabel)
        Spacer(minLength: 8)
        Text(window.usedText)
          .font(.body.weight(.semibold).monospacedDigit())
          .foregroundStyle(window.stale ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
      }
      CorePaceBar(fraction: window.fill, pace: window.pace, tint: barTint(window.barSeverity))
        .opacity(window.stale ? 0.4 : 1)
      HStack(spacing: 5) {
        if let text = window.resetText {
          Image(systemName: "arrow.counterclockwise")
          Text(text)
        }
        if window.overage { Text("overage").foregroundStyle(.orange) }
        if let fresh = window.freshText {
          Text(fresh)
            .foregroundStyle(window.stale ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
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
