import SwiftUI
import WorkerDeckKit

/// The terminal transcript: folded rows, computed heights, virtualized scroll.
///
/// This is the composition point and deliberately thin — every decision it looks
/// like it is making has already been made somewhere testable. What lines a row
/// draws is `TerminalPlanner`'s; how tall it is is `TerminalHeightBook`'s; where
/// the reader is is `VirtualizedTranscriptView`'s. What is left here is the one
/// thing none of them can know: how wide the transcript actually is on this
/// screen, which is what closes the loop, because the cell and the width are
/// what every height is computed against.
struct TerminalTranscriptView: View {
  let items: [TranscriptItem]
  /// Bumped on every applied event, streamed deltas included — `items.count`
  /// does not change while text streams into the last row, so it cannot be the
  /// only change signal.
  let revision: Int
  let scroll: TranscriptScrollModel
  #if DEBUG
    /// Receives the overflow audit's verdict after each refold. Wired only by
    /// the preview harness — a gate nobody reads is a gate that has never run.
    var onAudit: ((TerminalAudit.Report) -> Void)?
  #endif

  /// The phone's cell. Larger than the desktop's 13pt because a transcript read
  /// at arm's length is read at arm's length; still a whole number of points,
  /// which is the theme's one non-negotiable — a fractional line puts every
  /// second row on a half-pixel and the text visibly softens.
  private static let fontSize: CGFloat = 12

  @State private var model: TerminalTranscriptModel?

  private var typography: TerminalTypography { .measure(fontSize: Self.fontSize) }

  var body: some View {
    GeometryReader { proxy in
      // The bleed is spent before the planner ever sees the width: a row wrapped
      // to the full screen and then inset by a cell would overflow by one
      // character, which is exactly the kind of silent clipping the audit exists
      // to catch.
      let bleed = typography.cell
      let metrics = typography.metrics(width: proxy.size.width - 2 * bleed)
      Group {
        if let model, proxy.size.width > 0 {
          VirtualizedTranscriptView(
            rows: model.rows, book: model.book, metrics: metrics, scroll: scroll
          ) { index in
            TerminalRowView(
              lines: model.plan(at: index), typography: typography, metrics: metrics,
              gapAbove: model.gapAbove(index), bleed: bleed)
          }
        } else {
          Color.clear
        }
      }
      // Keyed off the proxy's width directly rather than a mirrored `@State`:
      // the view is mounted at the moment the replay hold releases, and a state
      // round-trip would spend the reveal frame showing nothing.
      .task(id: TranscriptEpoch(revision: revision, width: proxy.size.width)) {
        guard proxy.size.width > 0 else { return }
        let model = model ?? TerminalTranscriptModel(metrics: metrics)
        model.update(items: items, metrics: metrics)
        if self.model == nil { self.model = model }
        #if DEBUG
          // The gate, run wherever a transcript is actually on screen. A line
          // that renders wider than the column it was planned for is clipped
          // silently, which is worse than a wrong height — nothing about it
          // looks wrong.
          if let onAudit {
            onAudit(TerminalAudit.run(rows: model.rows, typography: typography, metrics: metrics))
          }
        #endif
      }
    }
    .background(Color(uiColor: .systemBackground))
  }

  /// What a refold is keyed on. The width belongs here as much as the revision
  /// does: a rotation changes every row's height without changing a single item.
  private struct TranscriptEpoch: Equatable {
    var revision: Int
    var width: CGFloat
  }
}
