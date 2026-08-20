import SwiftUI
import WorkerDeckKit

/// A progress ring with its own label inside it — the shared shape behind every
/// gauge in the app, so the context reading, the rate-limit windows and a
/// sessions-list row all read as the same measurement.
///
/// Lives here rather than under `Session/` because the sessions list draws it
/// too: reaching across a feature folder for a component is how one of them
/// quietly becomes the other's library.
///
/// Hand-rolled rather than stock, which is a deliberate call: `ProgressView`'s
/// `.circular` style is indeterminate-only on iOS (it is a spinner, not a
/// meter), and `Gauge` with `.accessoryCircular` is determinate but sized for a
/// watch complication — scaled down to fit a status bar its stroke goes hairline
/// and its label unreadable. This is a `Circle().trim()` and a `Text`, which is
/// the whole of what a ring is.
struct RadialGauge: View {
  /// 0–1. Clamped here, so callers can hand over raw arithmetic.
  let fraction: Double
  let tint: Color
  /// One or two characters shown in the middle. The ring is the reading; this
  /// says *what* is being read.
  var label: String?
  var diameter: CGFloat = 20
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
      if let label {
        Text(label)
          .font(.system(size: 9, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(.secondary)
          // Two digits at this size are a hair wider than the inner circle on the
          // smallest text setting; let them shrink rather than truncate.
          .minimumScaleFactor(0.7)
          .lineLimit(1)
          .frame(width: diameter - lineWidth * 2 - 2)
      }
    }
    .frame(width: diameter, height: diameter)
  }
}

/// Used share of the context window as a ring, with the percentage inside it.
///
/// Capped at 99 rather than rounded to 100: three digits don't fit, and a window
/// that full is telling you the same thing either way.
///
/// Takes the bare percentage, not a usage record — the session screen holds a
/// whole `ContextUsage` from the event stream and a list row holds the compact
/// `ContextReading` from the rollup, and this is the one number both agree on.
/// A ring that named either type would make the other convert to draw itself.
///
/// **On a list row the label goes: `showsLabel: false`.** Two digits inside a
/// 16pt ring are unreadable at arm's length, and across twenty rows the ring's
/// *fill* is the reading — the exact number is what opening the session is for.
struct ContextRing: View {
  let percentage: Double
  var diameter: CGFloat = 20
  var lineWidth: CGFloat = 2.5
  var showsLabel = true

  var body: some View {
    RadialGauge(
      fraction: percentage / 100,
      tint: usageTint(percentage),
      label: showsLabel ? "\(min(99, max(0, Int(percentage.rounded()))))" : nil,
      diameter: diameter,
      lineWidth: lineWidth)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Context \(Fmt.percent(percentage)) used")
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

