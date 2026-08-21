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
  /// Which transcript **item** to open on, rather than the tail. Set by a deep
  /// link from a tapped notification and nothing else — see
  /// `TranscriptSeqIndex`. In item space, because that is the only space the
  /// caller can speak: rows are a fold of items and only this view holds one.
  var focusItem: TranscriptFocusTarget?
  /// Render **only** the work one sub-agent did — the takeover's frame, the
  /// `parentToolUseId` everything shown was produced inside. Membership is
  /// `subagentItems` (the kit's port of web `blocks.ts`), applied here so the
  /// row build and the empty surface describe the same items.
  ///
  /// Three of this view's features are switched off whenever it is set, and the
  /// gate lives here — mirroring web `Transcript.tsx`'s `frame` prop — rather
  /// than at the call site on purpose: every one of them is keyed to a
  /// **full-transcript item index**, so a caller that passed a frame and any of
  /// them together would not be making a strange choice, it would be making an
  /// incoherent one. They are: the catch-up boundary and its recap row (this
  /// view already constructs its model recap-free; stated here so a future
  /// recap seam knows it must stay out of frames), the sticky prompt, and the
  /// deep-link focus. The **scrubber stays**, and the distinction is the point:
  /// everything the rail consumes — the items, the rows, the book — is the
  /// frame's own here (`model.items`), so inside a takeover it marks that
  /// agent's narration steps and failures, which is what makes a long run
  /// navigable. Host **bookmarks** are the one rail input that would be
  /// full-transcript space and must stay out of a frame whenever this client
  /// grows them; today it passes none anywhere. What stays is everything that
  /// makes a long stream readable — the fold, the height book, the follow pin,
  /// the expansion presses.
  var frame: String? = nil
  /// Raise the sub-agent takeover from a `Task` row's press. Absent, the press
  /// falls back to the inline toggle (see `TerminalTranscriptModel.press`) —
  /// and it is deliberately absent inside a frame, as on the web: no takeover
  /// from a takeover.
  var onOpenSubagent: ((String) -> Void)? = nil
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

  @State private var model: TerminalTranscriptModel?
  /// How a press asks for the rest of a truncated result. Nil outside a live
  /// session (the preview harness), and the press is then a no-op — which is
  /// correct there, since nothing truncated a replay nobody asked for.
  @Environment(\.toolResultFetcher) private var fetchToolResult
  /// How a row's image boxes get their bytes. Nil outside a live session, and
  /// the boxes then rest on their placeholder — correct there, since nothing
  /// refs a replay nobody asked for.
  @Environment(\.terminalImageLoader) private var imageLoader

  private var typography: TerminalTypography { .session }

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
      // the line fits its planned column, the column is simply covered. Spent
      // unconditionally: a frame draws the rail too now, so it pays the same
      // columns, and the planner and the audit both measure against this width.
      let metrics = typography.metrics(
        width: proxy.size.width - 2 * bleed - TerminalScrubberView.railWidth)
      Group {
        if let model, proxy.size.width > 0 {
          VirtualizedTranscriptView(
            rows: model.rows, book: model.book, metrics: metrics, expansion: model.expansion,
            scroll: scroll, reveal: model.reveal,
            // Converted here and nowhere else — an item index is not a row
            // index, and `rowIndex(forItem:)` is the only thing that knows the
            // difference (a folded run of tool calls is one row for many items).
            // Gated out of a frame: the target is a full-transcript item index,
            // and the frame's rows fold a filtered list.
            focus: frame == nil
              ? focusItem.map {
                TranscriptFocusRequest(row: model.rows.rowIndex(forItem: $0.item), nonce: $0.nonce)
              } : nil,
            showsScrollIndicator: false,
            configureRow: { cell, index in
              cell.configure(
                lines: model.plan(at: index), typography: typography, metrics: metrics,
                gapAbove: model.gapAbove(index), bleed: bleed, imageLoader: imageLoader,
                onPress: {
                  model.press(
                    $0, row: index, fetch: fetchToolResult,
                    // No takeover from a takeover — web passes
                    // `onOpenSubagent={frame ? undefined : onOpenSubagent}`.
                    openSubagent: frame == nil ? onOpenSubagent : nil)
                })
            }
          )
          // The prompt of the turn being read, held at the top. An overlay for
          // the same reason the rail is one: it is proposed the transcript's
          // size, and it must sit in the transcript's own coordinate space or
          // the line lands off the column every row below it sits on.
          // Not in a frame: its pins are full-transcript row indices — and a
          // sub-agent's brief is not a prompt, so a frame has nothing to pin.
          .overlay(alignment: .top) {
            if frame == nil {
              TerminalStickyPromptView(
                rows: model.rows, book: model.book, metrics: metrics, typography: typography,
                expansion: model.expansion, bleed: bleed, scroll: scroll,
                promptRows: model.promptRows,
                onJumpToRow: { scroll.scrollToRow($0, anchor: .top, animated: true) })
            }
          }
          // The rail replaces the scrollbar rather than sitting beside it. An
          // overlay, so it is proposed the transcript's size — and it must be,
          // because rail space and content space are the same fraction.
          // In a frame too: the rail rides the frame's OWN items and fold
          // (`model.items` is the frame's list there), so it marks the
          // sub-agent's steps and failures at the frame's own offsets. Only
          // host bookmarks would have to stay out — see `frame`'s doc.
          .overlay(alignment: .trailing) {
            TerminalScrubberView(
              input: ScrubberInput(
                // The model's list, never this view's parameter: inside a frame
                // the parameter is the whole conversation, and the rail must
                // describe the same items the fold did.
                items: model.items, rows: model.rows, book: model.book,
                pendingApprovals: pendingApprovals, viewportHeight: scroll.viewportHeight,
                // What is open decides which failures the rail marks: a call
                // folded inside a collapsed run is not on screen as a failure,
                // and the same call is red on its own line once it is.
                expansion: model.expansion,
                // What "top level" means to the mark rules: nil at the top, the
                // frame's id inside one — a frame's every item has a parent, and
                // the fixed test marked nothing on a hundred-tool agent.
                frameParentId: frame),
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
        let model = model ?? TerminalTranscriptModel(metrics: metrics, frameParentId: frame)
        // The frame's own item list, decided once here so the fold, the empty
        // surface and the presses all describe the same items. The spawning
        // call rides beside it — it is not a frame member (`subagentItems`
        // excludes it: that is the frame, not a row in it), but its `prompt` is
        // the brief the frame's rows open with.
        let visible = frame.map { subagentItems(items, parentToolUseId: $0) } ?? items
        model.update(
          items: visible, metrics: metrics,
          frameTask: frame.flatMap { subagentTask(items, id: $0) })
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
              alsoFullyExpanded: true, frameParentId: frame)
            // The second claim, and the one the hand-rolled renderer added: the
            // text really draws at the height the book handed the layout. Run
            // over the row list as it stands, since that is what is on screen.
            let heights = TerminalAudit.measureHeights(
              rows: model.rows, typography: typography, metrics: metrics, bleed: bleed,
              expansion: model.expansion, frameParentId: frame)
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

  /// The transcript item a deep link wants opened on, and a nonce so a second
  /// notification about the same item still travels. Item space; the row it
  /// folds into is this view's business.
  struct TranscriptFocusTarget: Equatable {
    var item: Int
    var nonce: Int
  }

  /// What a refold is keyed on. The width belongs here as much as the revision
  /// does: a rotation changes every row's height without changing a single item.
  private struct TranscriptEpoch: Equatable {
    var revision: Int
    var width: CGFloat
  }
}
