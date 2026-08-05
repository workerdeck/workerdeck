import WorkerDeckKit
import SwiftUI

/// The plan's rate-limit windows, spelled out: how much of each is used, how it
/// compares to the pace that would spend the window exactly, and when it resets.
///
/// The pace marker is the point of this screen. A bar alone says "17% used",
/// which is only alarming or reassuring once you know how far into the week you
/// are — so every window draws a tick at the elapsed share of its duration. Left
/// of the tick is under budget, right of it is ahead of it.
///
/// The duration is derived from the window key (5h, 7d), because the CLI reports
/// a reset time and a percentage and never a duration; a window whose key doesn't
/// say gets no marker rather than a guessed one.
struct UsageSheet: View {
  /// Ordered windows from `TranscriptViewModel.rateLimitWindows`.
  let rateLimits: [(key: String, info: RateLimitInfo)]
  /// claude.ai plan behind the windows ('max', 'pro', …), when the session has one.
  let subscriptionType: String?
  let engine: ProfileEngine
  let totalCostUsd: Double
  /// When the app last received a window update — the poll is per turn, so a
  /// stale reading is normal and worth saying out loud.
  let updatedAt: Date?

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if rateLimits.isEmpty {
          ContentUnavailableView {
            Label("No plan limits", systemImage: "gauge")
          } description: {
            VStack(spacing: 10) {
              Text(
                engine == .claude
                  ? "This session reports no plan windows — API-key sessions have none, and a "
                    + "subscription session reports them once a turn has run."
                  : "Plan windows are a claude.ai subscription thing; this session runs on a "
                    + "provider engine.")
              Text("This session has cost \(Fmt.cost(totalCostUsd)).")
                .monospacedDigit()
            }
          }
        } else {
          list
        }
      }
      .navigationTitle("Usage")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  private var list: some View {
    List {
      Section {
        // One timeline for the whole card: both halves of every row move with the
        // clock (the countdown down, the pace marker right), and a minute is the
        // finest resolution either of them prints.
        TimelineView(.periodic(from: .now, by: 60)) { context in
          VStack(spacing: 14) {
            ForEach(Array(rateLimits.enumerated()), id: \.element.key) { index, window in
              if index > 0 { Divider() }
              UsageWindowRow(key: window.key, info: window.info, now: context.date)
            }
          }
          .padding(.vertical, 4)
        }
      } header: {
        planHeader
      } footer: {
        if let updatedAt {
          // Rendered off the same clock as the rows, so it ages while the sheet
          // is open instead of freezing at "just now".
          TimelineView(.periodic(from: .now, by: 60)) { context in
            Text("Updated \(Fmt.agoPrecise(updatedAt, now: context.date))")
          }
        }
      }

      Section("This session") {
        LabeledContent("Cost") {
          Text(Fmt.cost(totalCostUsd)).monospacedDigit()
        }
      }
    }
  }

  /// Whose limits these are. The plan capsule is only drawn when the CLI told us
  /// — it reports a tier ('max'), never the multiplier a subscription page shows,
  /// so this says "Max" and stops there rather than inventing "Max 20x".
  private var planHeader: some View {
    HStack(spacing: 8) {
      if engine == .claude {
        // Anthropic's own mark, kept at its own colour — this line names whose
        // limits these are, so a tinted or symbol stand-in would be the wrong
        // claim. `docs/assets/claude-code.svg`, vectored by the asset catalog.
        Image("ClaudeCode")
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(width: 22, height: 22)
          .accessibilityHidden(true)
      }
      Text(engine == .claude ? "Claude Code" : engine.rawValue.capitalized)
        .font(.headline)
        .foregroundStyle(.primary)
      Spacer(minLength: 8)
      if let plan = subscriptionType, !plan.isEmpty {
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
}

/// One window: name, used share, bar with pace marker, reset countdown.
private struct UsageWindowRow: View {
  let key: String
  let info: RateLimitInfo
  /// Passed in rather than read here so every row in the card agrees on "now".
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(Fmt.rateLimitWindowLong(key))
          .font(.body)
        Spacer(minLength: 8)
        Text("\(Fmt.percent(utilization)) used")
          .font(.body.weight(.semibold).monospacedDigit())
      }
      UsageBar(fraction: utilization / 100, pace: pace, tint: usageTint(utilization))
      HStack(spacing: 5) {
        if let resetsAt = info.resetsAt, let text = Fmt.resets(epochSeconds: resetsAt, now: now) {
          Image(systemName: "arrow.counterclockwise")
          Text(text)
        }
        if info.isUsingOverage == true {
          Text("overage").foregroundStyle(.orange)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var utilization: Double { info.utilization ?? 0 }

  /// Share of the window already elapsed — where usage *would* be if it were
  /// spent evenly. Needs both a duration (from the key) and a reset time.
  private var pace: Double? {
    guard let duration = Fmt.rateLimitWindowSeconds(key), let resetsAt = info.resetsAt else {
      return nil
    }
    let remaining = resetsAt - now.timeIntervalSince1970
    guard remaining > 0, remaining < duration else { return nil }
    return (duration - remaining) / duration
  }

  private var accessibilityLabel: String {
    var parts = ["\(Fmt.rateLimitWindowLong(key)), \(Fmt.percent(utilization)) used"]
    if let pace { parts.append("\(Fmt.percent(pace * 100)) of the window elapsed") }
    if let resetsAt = info.resetsAt, let text = Fmt.resets(epochSeconds: resetsAt, now: now) {
      parts.append(text)
    }
    return parts.joined(separator: ", ")
  }
}

/// A linear meter with an optional pace marker standing over it.
///
/// The marker is taller than the bar and drawn in the foreground colour so it
/// reads as a scale mark rather than as more usage.
struct UsageBar: View {
  /// 0–1 used. Clamped here, so callers can hand over raw arithmetic.
  let fraction: Double
  /// 0–1 elapsed, or nil when the window's duration is unknown.
  var pace: Double?
  var tint: Color = .accentColor

  private let barHeight: CGFloat = 9
  private let markerHeight: CGFloat = 15

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.secondary.opacity(0.22))
          .frame(height: barHeight)
        Capsule()
          .fill(tint)
          // A floor, so a barely-touched window still shows a mark instead of
          // reading as missing data.
          .frame(width: max(barHeight, width * clamp(fraction)), height: barHeight)
        if let pace {
          Capsule()
            .fill(Color.primary)
            .frame(width: 3, height: markerHeight)
            .offset(x: min(width - 3, max(0, width * clamp(pace) - 1.5)))
        }
      }
      .frame(height: markerHeight)
    }
    .frame(height: markerHeight)
  }

  private func clamp(_ value: Double) -> Double { min(max(value, 0), 1) }
}
