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
  /// What the rail pins at its foot. Not an item — the prompt renders below the
  /// transcript — so it cannot be derived from `items`.
  var pendingApprovals: [PermissionRequest] = []
  /// Bumped on every applied event, streamed deltas included — `items.count`
  /// does not change while text streams into the last row, so it cannot be the
  /// only change signal.
  let revision: Int
  let scroll: TranscriptScrollModel
  #if DEBUG
    /// Receives the overflow audit's verdict after each refold. Wired only by
    /// the preview harness — a gate nobody reads is a gate that has never run.
    var onAudit: ((TerminalAudit.Report) -> Void)?
    /// Open every block on mount, for the preview that checks the expanded plan
    /// against real layout rather than against its author's arithmetic.
    var expandAll = false
  #endif

  /// The phone's cell. Larger than the desktop's 13pt because a transcript read
  /// at arm's length is read at arm's length; still a whole number of points,
  /// which is the theme's one non-negotiable — a fractional line puts every
  /// second row on a half-pixel and the text visibly softens.
  private static let fontSize: CGFloat = 12

  @State private var model: TerminalTranscriptModel?
  /// How a press asks for the rest of a truncated result. Nil outside a live
  /// session (the preview harness), and the press is then a no-op — which is
  /// correct there, since nothing truncated a replay nobody asked for.
  @Environment(\.toolResultFetcher) private var fetchToolResult

  private var typography: TerminalTypography { .measure(fontSize: Self.fontSize) }

  var body: some View {
    GeometryReader { proxy in
      // The bleed is spent before the planner ever sees the width: a row wrapped
      // to the full screen and then inset by a cell would overflow by one
      // character, which is exactly the kind of silent clipping the audit exists
      // to catch.
      let bleed = typography.cell
      // The rail is spent before the planner sees the width, exactly like the
      // bleed. It is an *overlay*, so a row wrapped to the full screen would
      // have its last column drawn underneath it — which is the same silent
      // clipping the audit exists to catch, except the audit would not see it:
      // the line fits its planned column, the column is simply covered.
      let metrics = typography.metrics(
        width: proxy.size.width - 2 * bleed - TerminalScrubberView.railWidth)
      Group {
        if let model, proxy.size.width > 0 {
          VirtualizedTranscriptView(
            rows: model.rows, book: model.book, metrics: metrics, expansion: model.expansion,
            scroll: scroll, reveal: model.reveal, showsScrollIndicator: false,
            configureRow: { cell, index in
              cell.configure(
                lines: model.plan(at: index), typography: typography, metrics: metrics,
                gapAbove: model.gapAbove(index), bleed: bleed,
                onPress: { model.press($0, row: index, fetch: fetchToolResult) })
            }
          )
          // The prompt of the turn being read, held at the top. An overlay for
          // the same reason the rail is one: it is proposed the transcript's
          // size, and it must sit in the transcript's own coordinate space or
          // the line lands off the column every row below it sits on.
          .overlay(alignment: .top) {
            TerminalStickyPromptView(
              rows: model.rows, book: model.book, metrics: metrics, typography: typography,
              expansion: model.expansion, bleed: bleed, scroll: scroll,
              promptRows: model.promptRows,
              onJumpToRow: { scroll.scrollToRow($0, anchor: .top, animated: true) })
          }
          // The rail replaces the scrollbar rather than sitting beside it. An
          // overlay, so it is proposed the transcript's size — and it must be,
          // because rail space and content space are the same fraction.
          .overlay(alignment: .trailing) {
            TerminalScrubberView(
              input: ScrubberInput(
                items: items, rows: model.rows, book: model.book,
                pendingApprovals: pendingApprovals, viewportHeight: scroll.viewportHeight),
              scroll: scroll, typography: typography,
              // Through the row model, never by arithmetic — a mark's item index
              // is not its row index, and `buildScrubberClusters` has already
              // done that conversion.
              onJumpToRow: { scroll.scrollToRow($0, anchor: .top, animated: true) })
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
        #if DEBUG
          if expandAll, model.expansion.isEmpty { model.expandEverything() }
        #endif
        if self.model == nil { self.model = model }
        #if DEBUG
          // The gate, run wherever a transcript is actually on screen. A line
          // that renders wider than the column it was planned for is clipped
          // silently, which is worse than a wrong height — nothing about it
          // looks wrong.
          if let onAudit {
            // Both states, because the gate can only check lines it was given
            // and a correctly-wrapped summary says nothing about the fifty
            // result lines folded behind it. Planning is pure, so the second
            // run costs a calculation and draws nothing.
            var report = TerminalAudit.run(
              rows: model.rows, typography: typography, metrics: metrics,
              expansion: model.expansion,
              alsoFullyExpanded: true)
            // The second claim, and the one the hand-rolled renderer added: the
            // text really draws at the height the book handed the layout. Run
            // over the row list as it stands, since that is what is on screen.
            let heights = TerminalAudit.measureHeights(
              rows: model.rows, typography: typography, metrics: metrics, bleed: bleed,
              expansion: model.expansion)
            report.heightsChecked = heights.checked
            report.heightsCapped = heights.capped
            report.heightFindings = heights.findings
            onAudit(report)
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
