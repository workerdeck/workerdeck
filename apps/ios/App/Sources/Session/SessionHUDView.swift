import WorkerDeckKit
import SwiftUI

/// The top bar of a live session: status, connectivity, and the compact usage HUD.
///
/// Everything here is conditional. Context usage doesn't exist until the first
/// turn completes, and rate limits only exist for subscription sessions — so both
/// are simply absent rather than shown at zero.
struct SessionHUDView: View {
  let status: SessionStatus
  let pendingCount: Int
  let isConnected: Bool
  let contextUsage: ContextUsage?
  let rateLimits: [(key: String, info: RateLimitInfo)]
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(spacing: 5) {
        HStack(spacing: 8) {
          StatusBadge(status: status, pendingCount: pendingCount, compact: true)
          if status.isBusy {
            ProgressView().controlSize(.mini)
          }
          Spacer(minLength: 0)
          ConnectionIndicator(isConnected: isConnected)
        }

        if contextUsage != nil || !rateLimits.isEmpty {
          HStack(spacing: 10) {
            if let contextUsage {
              ContextBar(usage: contextUsage)
                .frame(maxWidth: 130)
            }
            ForEach(rateLimits, id: \.key) { window in
              RateLimitChip(key: window.key, info: window.info)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(.bar)
  }
}

struct ConnectionIndicator: View {
  let isConnected: Bool

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: isConnected ? "wifi" : "wifi.slash")
      Text(isConnected ? "Live" : "Reconnecting…")
    }
    .font(.caption2)
    .foregroundStyle(isConnected ? Color.secondary : Color.orange)
  }
}

/// Used share of the context window. `percentage` is 0–100 straight from the SDK.
struct ContextBar: View {
  let usage: ContextUsage

  var body: some View {
    HStack(spacing: 6) {
      ProgressView(value: min(max(usage.percentage, 0), 100), total: 100)
        .progressViewStyle(.linear)
        .tint(tint)
      Text(Fmt.percent(usage.percentage))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Context \(Fmt.percent(usage.percentage)) used")
  }

  private var tint: Color {
    switch usage.percentage {
    case ..<70: return .accentColor
    case ..<90: return .orange
    default: return .red
    }
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

/// One rate-limit window. Only rendered for windows that reported a utilization —
/// an absent one means unknown, and 0% would be a lie.
struct RateLimitChip: View {
  let key: String
  let info: RateLimitInfo

  var body: some View {
    if let utilization = info.utilization {
      HStack(spacing: 3) {
        Text(Fmt.rateLimitWindow(key))
          .foregroundStyle(.secondary)
        Text(Fmt.percent(utilization))
          .monospacedDigit()
          .foregroundStyle(tint(utilization))
        if let resetsAt = info.resetsAt {
          ResetCountdown(resetsAt: resetsAt)
            .foregroundStyle(.tertiary)
        }
      }
      .font(.caption2)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Color.secondary.opacity(0.12), in: Capsule())
    }
  }

  private func tint(_ utilization: Double) -> Color {
    switch utilization {
    case ..<70: return .secondary
    case ..<90: return .orange
    default: return .red
    }
  }
}
