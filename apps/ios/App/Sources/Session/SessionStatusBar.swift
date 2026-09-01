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

/// The session's mini status bar, in whichever shape the transcript is wearing:
/// a glass strip floating above the composer in `cards`, and in `terminal` a
/// flat edge-to-edge rule-topped strip sitting directly on the docked composer —
/// the terminal's own status line, which is not a card either.
///
/// It carries the four things worth a glance mid-run — how the session is doing,
/// which model is answering, which permission mode is in force, and how much
/// budget is left — and two of them double as the controls that change them. What
/// it can't fit is one tap away, and *which* tap decides where: the context ring
/// opens `ContextSheet`, the usage rings open `UsageSheet`.
///
/// Everything after the status is conditional. Context usage doesn't exist until
/// the first turn completes, and rate limits only exist for subscription sessions
/// — both are simply absent rather than shown at zero.
struct SessionStatusBar: View {
  /// Same environment the rows and the composer read, so the bar cannot end up
  /// in a different idiom from the two things it sits between.
  @Environment(\.transcriptVariant) private var variant

  let status: SessionStatus
  let pendingCount: Int
  let connection: ConnectionState
  let contextUsage: ContextUsage?
  /// Ordered slots from `TranscriptViewModel.hudRateLimits` — account usage
  /// merged over the session's own reading.
  let rateLimits: [UsageWindowRow]
  /// Cumulative session cost, shown in place of the rings when no window reports.
  let totalCostUsd: Double
  let model: String?
  let models: [ModelOption]
  /// Nil until the engine reports it, which is one event later than this view's
  /// first draw.
  let permissionMode: PermissionMode?
  let onOpenModel: () -> Void
  let onOpenMode: () -> Void
  /// The context ring and the usage rings each open their own sheet — the two
  /// gauges answer different questions, so one destination for both was a detour
  /// through a list every time.
  let onOpenContext: () -> Void
  let onOpenUsage: () -> Void
  let onOpenInfo: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      statusSlot
      modelChip
      permissionChip
      Spacer(minLength: 4)
      usageCluster
    }
    .padding(.horizontal, 12)
    .padding(.vertical, variant.isTerminal ? 5 : 7)
    .modifier(StatusBarShell(terminal: variant.isTerminal))
  }

  /// One slot, two meanings: connection trouble wins it, because a session status
  /// shown over a dead socket is a stale reading presented as a live one.
  ///
  /// Tapping it opens the session's own facts — where it runs, on what, with
  /// which credentials. That is the question a status prompts ("idle since
  /// when? which session is this?"), so the status is its way in.
  private var statusSlot: some View {
    Button(action: onOpenInfo) {
      slotContent
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .fixedSize()
    .accessibilityHint("Opens session info")
  }

  @ViewBuilder
  private var slotContent: some View {
    if connection == .live {
      HStack(spacing: 5) {
        StatusBadge(status: status, pendingCount: pendingCount, compact: true)
        if status.isBusy {
          ProgressView().controlSize(.mini)
        }
      }
    } else {
      HStack(spacing: 4) {
        Image(systemName: connection.symbol)
        Text(connection.label)
          .fontWeight(.medium)
      }
      .font(.caption2)
      .foregroundStyle(connection.tint)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(connection.label). Session status unavailable.")
    }
  }

  // MARK: - Controls

  /// The model in force, and the way to change it. A sheet rather than a menu —
  /// see `SelectionSheets.swift` for why.
  private var modelChip: some View {
    Button(action: onOpenModel) {
      ChipLabel(text: modelLabel, tint: model == nil ? .secondary : .primary)
    }
    .buttonStyle(.plain)
    // The one flexible chip: a model name is the longest thing on the bar, and
    // the least costly to clip.
    .layoutPriority(-1)
    .accessibilityLabel("Model \(modelLabel)")
    .accessibilityHint("Opens the model picker")
  }

  private var permissionChip: some View {
    Button(action: onOpenMode) {
      ChipLabel(
        text: permissionMode?.shortLabel ?? "Mode",
        tint: permissionMode?.tint ?? .secondary)
    }
    .buttonStyle(.plain)
    .fixedSize()
    .accessibilityLabel("Permission mode \(permissionMode?.label ?? "unknown")")
    .accessibilityHint("Opens the mode picker")
  }

  /// The model, under the CLI's own short name ("Opus", "Fable"), never a wire id
  /// and never "Default".
  ///
  /// A session that has told us its model has a real one; one that hasn't
  /// (promptless, before the CLI's init handshake) doesn't know it yet — which is
  /// a placeholder, not a value. The raw id shows only if `capabilities` hasn't
  /// landed to name it, which on a live session is a second or two at most.
  private var modelLabel: String {
    guard let model else { return "Model" }
    return models.first { $0.matches(model) }?.shortDisplayName ?? model
  }

  // MARK: - Usage

  /// Context and rate limits, each its own tap target.
  ///
  /// The branch is per-window presence, not a mode flag: a plan that reports only
  /// two windows gets two rings, not a fallback. Only a session reporting none —
  /// an API-key session, or one before its first turn — shows dollars.
  private var usageCluster: some View {
    // The gap between the two buttons is deliberate and larger than the gap
    // *inside* the usage cluster: adjacent rings that open different sheets need
    // a seam a thumb can find.
    HStack(spacing: 12) {
      if let contextUsage {
        Button(action: onOpenContext) {
          ContextRing(percentage: contextUsage.percentage)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the context breakdown")
      }
      Button(action: onOpenUsage) {
        Group {
          if !rateLimits.isEmpty {
            UsageRings(windows: rateLimits)
          } else if totalCostUsd > 0 {
            // Nothing to gauge yet: cost if there is any, and otherwise the
            // symbol alone, so the way into the usage sheet never disappears.
            Text(Fmt.cost(totalCostUsd))
              .font(.caption2.monospacedDigit())
              .foregroundStyle(.secondary)
              .accessibilityLabel("Session cost \(Fmt.cost(totalCostUsd))")
          } else {
            Image(systemName: "gauge")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .accessibilityLabel("Usage")
          }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint("Opens plan usage")
    }
    .fixedSize()
  }
}

/// A tappable chip on the status bar: a label plus the chevron that says it opens
/// a menu.
/// The bar's own surface.
///
/// `cards` gets the glass panel it always had. `terminal` gets no panel at all:
/// an opaque strip the width of the screen, separated from the transcript by a
/// hairline and from the composer below by the composer's own rule. Two flat
/// bands with rules between them is what a terminal's status line looks like, and
/// a rounded translucent pill wedged between the transcript and a docked composer
/// was the one piece of chat furniture left in the terminal shape.
private struct StatusBarShell: ViewModifier {
  let terminal: Bool

  @ViewBuilder
  func body(content: Content) -> some View {
    if terminal {
      content
        .background(Color(.systemBackground))
        .overlay(alignment: .top) {
          Rectangle().fill(Color.primary.opacity(0.15)).frame(height: 0.5)
        }
    } else {
      content.glassPanel(cornerRadius: 18)
    }
  }
}

private struct ChipLabel: View {
  @Environment(\.transcriptVariant) private var variant

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
    .padding(.horizontal, variant.isTerminal ? 4 : 8)
    .padding(.vertical, 4)
    // No pill in the terminal shape: a chip's job here is to be *readable and
    // tappable*, and on a flat strip the label alone does that. The chevron is
    // what still says it opens something.
    .glassPill(opacity: variant.isTerminal ? 0 : 0.10)
  }
}

/// Rate-limit windows as rings, one each, keyed by a letter: S for the session
/// window, W for weekly, and the model's initial for a per-model weekly one.
///
/// A letter rather than a percentage because there are three of them on one line
/// and the ring already carries the number; what a glance is missing is *which
/// window*. The order is still fixed (session, weekly, per-model), and the full
/// names, percentages and reset countdowns are in the usage sheet.
struct UsageRings: View {
  let windows: [UsageWindowRow]

  var body: some View {
    HStack(spacing: 4) {
      ForEach(windows, id: \.key) { window in
        let utilization = window.info.utilization ?? 0
        RadialGauge(
          fraction: utilization / 100, tint: usageTint(utilization), label: Self.initial(window.key))
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      windows
        .map { "\(Fmt.rateLimitWindow($0.key)) \(Fmt.percent($0.info.utilization ?? 0))" }
        .joined(separator: ", "))
  }

  /// 'five_hour' → "S", 'seven_day' → "W", 'seven_day_fable' → "F". The per-model
  /// suffix is an open set (the CLI adds buckets as plans gain them), so its
  /// letter is taken from the name rather than enumerated.
  static func initial(_ key: String) -> String {
    if key == "five_hour" { return "S" }
    if key == "seven_day" { return "W" }
    guard key.hasPrefix("seven_day_"), let first = key.dropFirst("seven_day_".count).first else {
      return "?"
    }
    return String(first).uppercased()
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
