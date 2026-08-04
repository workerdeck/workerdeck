import WorkerDeckKit
import SwiftUI

/// How the app is doing at reaching the gateway. Not the session's status — the
/// two are orthogonal, and merging them in the status bar is deliberate: while the
/// socket is down the session status the app holds is *stale*, so claiming "idle"
/// would be a claim it cannot back.
enum ConnectionState: Equatable {
  case live
  /// The socket dropped and the handle is backing off. Usually momentary.
  case reconnecting
  /// It has been failing long enough to call it. The handle never stops trying.
  case offline

  var label: String {
    switch self {
    case .live: return "Live"
    case .reconnecting: return "Reconnecting…"
    case .offline: return "Offline"
    }
  }

  var symbol: String {
    switch self {
    case .live: return "wifi"
    case .reconnecting: return "arrow.triangle.2.circlepath"
    case .offline: return "wifi.slash"
    }
  }

  var tint: Color {
    switch self {
    case .live: return .secondary
    case .reconnecting: return .orange
    case .offline: return .red
    }
  }
}

/// The session's mini status bar: a glass strip that floats above the composer,
/// where a thumb can reach it.
///
/// It carries the four things worth a glance mid-run — how the session is doing,
/// which model is answering, which permission mode is in force, and how much
/// budget is left — and two of them double as the controls that change them. What
/// it can't fit (window names, reset countdowns, cost breakdown) is one tap away
/// in `SessionDetailSheet`, which the usage cluster opens.
///
/// Everything after the status is conditional. Context usage doesn't exist until
/// the first turn completes, and rate limits only exist for subscription sessions
/// — both are simply absent rather than shown at zero.
struct SessionStatusBar: View {
  let status: SessionStatus
  let pendingCount: Int
  let connection: ConnectionState
  let contextUsage: ContextUsage?
  /// Ordered slots from `TranscriptViewModel.hudRateLimits`.
  let rateLimits: [(key: String, info: RateLimitInfo)]
  /// Cumulative session cost, shown in place of the rings when no window reports.
  let totalCostUsd: Double
  let model: String?
  let models: [ModelOption]
  /// Nil until the engine reports it, which is one event later than this view's
  /// first draw.
  let permissionMode: PermissionMode?
  /// Only the modes this session's engine implements — the caller filters.
  let permissionModes: [PermissionMode]
  let onSelectModel: (String?) -> Void
  let onSelectPermissionMode: (PermissionMode) -> Void
  let onOpenDetails: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      statusSlot
      modelChip
      permissionChip
      Spacer(minLength: 4)
      usageCluster
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .glassPanel(cornerRadius: 18)
  }

  /// One slot, two meanings: connection trouble wins it, because a session status
  /// shown over a dead socket is a stale reading presented as a live one.
  @ViewBuilder
  private var statusSlot: some View {
    if connection == .live {
      HStack(spacing: 5) {
        StatusBadge(status: status, pendingCount: pendingCount, compact: true)
        if status.isBusy {
          ProgressView().controlSize(.mini)
        }
      }
      .fixedSize()
    } else {
      HStack(spacing: 4) {
        Image(systemName: connection.symbol)
        Text(connection.label)
          .fontWeight(.medium)
      }
      .font(.caption2)
      .foregroundStyle(connection.tint)
      .fixedSize()
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(connection.label). Session status unavailable.")
    }
  }

  // MARK: - Controls

  /// The model in force, and the menu that changes it. Shown even when the server
  /// sent no options — the menu still offers the server default, and the label is
  /// worth reading on its own.
  private var modelChip: some View {
    Menu {
      ForEach(models) { option in
        Button {
          onSelectModel(option.value)
        } label: {
          CheckedLabel(option.displayName, isChecked: option.value == model)
        }
      }
      if !models.isEmpty { Divider() }
      Button {
        onSelectModel(nil)
      } label: {
        CheckedLabel("Server default", isChecked: model == nil)
      }
    } label: {
      ChipLabel(text: modelLabel)
    }
    // The one flexible chip: a model id is the longest thing on the bar, and the
    // least costly to clip.
    .layoutPriority(-1)
    .accessibilityLabel("Model \(modelLabel)")
  }

  private var permissionChip: some View {
    Menu {
      ForEach(permissionModes, id: \.self) { mode in
        Button {
          onSelectPermissionMode(mode)
        } label: {
          CheckedLabel(mode.label, isChecked: mode == permissionMode)
        }
      }
    } label: {
      ChipLabel(
        text: permissionMode?.shortLabel ?? "Mode",
        tint: permissionMode?.tint ?? .secondary)
    }
    .fixedSize()
    .accessibilityLabel("Permission mode \(permissionMode?.label ?? "unknown")")
  }

  private var modelLabel: String {
    guard let model else { return "Default" }
    return models.first { $0.value == model }?.displayName ?? model
  }

  // MARK: - Usage

  /// Context and rate limits, and the way into the details sheet.
  ///
  /// The branch is per-window presence, not a mode flag: a plan that reports only
  /// two windows gets two rings, not a fallback. Only a session reporting none —
  /// an API-key session, or one before its first turn — shows dollars.
  private var usageCluster: some View {
    Button(action: onOpenDetails) {
      HStack(spacing: 8) {
        if let contextUsage {
          ContextRing(usage: contextUsage)
        }
        if !rateLimits.isEmpty {
          UsageRings(windows: rateLimits)
        } else if totalCostUsd > 0 {
          Text(Fmt.cost(totalCostUsd))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityLabel("Session cost \(Fmt.cost(totalCostUsd))")
        }
        Image(systemName: "chevron.right")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .fixedSize()
    .accessibilityHint("Opens session details")
  }
}

/// A tappable chip on the status bar: a label plus the chevron that says it opens
/// a menu.
private struct ChipLabel: View {
  let text: String
  var tint: Color = .secondary

  var body: some View {
    HStack(spacing: 3) {
      Text(text)
        .font(.caption2.weight(.medium))
        .lineLimit(1)
        .truncationMode(.tail)
      Image(systemName: "chevron.down")
        .font(.system(size: 7, weight: .bold))
        .foregroundStyle(.tertiary)
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .glassPill()
  }
}

/// Menu row with a checkmark for the current choice. An `Image` is only emitted
/// when checked — an empty `systemImage` would log a missing-symbol warning.
struct CheckedLabel: View {
  private let title: String
  private let isChecked: Bool

  init(_ title: String, isChecked: Bool) {
    self.title = title
    self.isChecked = isChecked
  }

  var body: some View {
    if isChecked {
      Label(title, systemImage: "checkmark")
    } else {
      Text(title)
    }
  }
}

/// A progress ring — the shared shape behind every gauge on the bar, so context
/// and rate limits read as the same kind of measurement.
struct RadialGauge: View {
  /// 0–1. Clamped here, so callers can hand over raw arithmetic.
  let fraction: Double
  let tint: Color
  var diameter: CGFloat = 14
  var lineWidth: CGFloat = 2.5

  var body: some View {
    ZStack {
      Circle()
        .stroke(Color.secondary.opacity(0.25), lineWidth: lineWidth)
      Circle()
        // A floor of 2%: a window barely touched still shows a mark, so the ring
        // reads as "almost none used" rather than as missing.
        .trim(from: 0, to: max(0.02, min(max(fraction, 0), 1)))
        .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        // Trim starts at 3 o'clock; a progress ring reads from 12.
        .rotationEffect(.degrees(-90))
    }
    .frame(width: diameter, height: diameter)
  }
}

/// Used share of the context window as a ring. `percentage` is 0–100 from the SDK.
struct ContextRing: View {
  let usage: ContextUsage

  var body: some View {
    HStack(spacing: 5) {
      RadialGauge(fraction: usage.percentage / 100, tint: usageTint(usage.percentage))
      Text(Fmt.percent(usage.percentage))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Context \(Fmt.percent(usage.percentage)) used")
  }
}

/// Rate-limit windows as rings, one each.
///
/// Unlabelled on purpose — three labels and their reset countdowns don't fit a
/// single line, and both are in the details sheet. The order is fixed (session,
/// weekly, per-model) so a ring means the same thing every time, and VoiceOver
/// reads the whole set out with its labels.
struct UsageRings: View {
  let windows: [(key: String, info: RateLimitInfo)]

  var body: some View {
    HStack(spacing: 4) {
      ForEach(windows, id: \.key) { window in
        let utilization = window.info.utilization ?? 0
        RadialGauge(fraction: utilization / 100, tint: usageTint(utilization))
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      windows
        .map { "\(Fmt.rateLimitWindow($0.key)) \(Fmt.percent($0.info.utilization ?? 0))" }
        .joined(separator: ", "))
  }
}

/// Used share of the context window as a linear bar — the details-sheet form,
/// where there is room to spell it out.
struct ContextBar: View {
  let usage: ContextUsage

  var body: some View {
    HStack(spacing: 6) {
      ProgressView(value: min(max(usage.percentage, 0), 100), total: 100)
        .progressViewStyle(.linear)
        .tint(usageTint(usage.percentage))
      Text(Fmt.percent(usage.percentage))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Context \(Fmt.percent(usage.percentage)) used")
  }
}

/// The one severity ramp for every meter in the app, over a 0–100 percentage.
func usageTint(_ percentage: Double) -> Color {
  switch percentage {
  case ..<70: return .accentColor
  case ..<90: return .orange
  default: return .red
  }
}

/// A countdown to a rate-limit reset, ticking on its own.
///
/// `rate_limit` events are sparse — one per turn at best — so a countdown drawn
/// from the last event would sit at "in 3h" for an hour. Minute resolution is the
/// finest thing `Fmt.until` prints, so tick once a minute and no faster.
/// A window whose reset time has passed renders as nothing at all, prefix
/// included — hence the prefix living here rather than in the caller's layout.
struct ResetCountdown: View {
  let resetsAt: Double
  var prefix: String?

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      if let countdown = Fmt.until(epochSeconds: resetsAt, now: context.date) {
        Text(prefix.map { "\($0) \(countdown)" } ?? countdown)
      }
    }
  }
}
