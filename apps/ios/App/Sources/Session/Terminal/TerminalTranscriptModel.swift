import Observation
import SwiftUI
import WorkerDeckKit

/// Everything the terminal transcript needs to draw and to navigate: the folded
/// rows, their heights, and where each one sits.
///
/// It exists because all three are derived from the same two inputs — the
/// transcript items and the cell — and deriving them in a view body would redo
/// the whole fold on every frame of a streaming turn. Held here, a delta
/// re-plans the one row that changed (see `TerminalPlanCache`) and re-sums an
/// array of doubles.
///
/// Kept deliberately free of scroll state. Where the reader *is* belongs to the
/// scroll view; what there is to read belongs here.
@MainActor
@Observable
final class TerminalTranscriptModel {
  private(set) var rows = TerminalRows(rows: [])
  private(set) var book: TerminalHeightBook
  /// Ascending row indices of the human's own prompts — what the sticky prompt
  /// binary-searches. Cached with the fold rather than derived per scroll frame:
  /// it is a walk of the transcript and it changes only when the rows do.
  private(set) var promptRows: [Int] = []

  /// Which blocks are open. Here rather than in a row view, and that is the
  /// whole design of this feature: a `UICollectionViewLayout` takes every frame
  /// from the height book, so a height the book does not know about is a frame
  /// the layout gets wrong. Cell-local `@State` — which is what the web client
  /// uses — would be exactly that. See `TerminalExpansion.swift`.
  private(set) var expansion = TerminalExpansion()
  /// The last row a press *opened*, for the scroll view to bring back into view
  /// if the expansion pushed its first line above the fold. Nonce-keyed because
  /// opening the same row twice is two requests and an equal value is a no-op.
  private(set) var reveal: TranscriptRevealRequest?
  private var revealNonce = 0

  private var items: [TranscriptItem] = []

  /// The catch-up seam: how many rows had already been read when this session
  /// was opened. Fixed at mount — a boundary that moved as new rows arrived
  /// would be a boundary that never means anything.
  private let recapAt: Int?
  private let recapLabel: String

  private var metrics: TerminalMetrics
  private let cache = TerminalPlanCache()

  init(metrics: TerminalMetrics, recapAt: Int? = nil, recapLabel: String = "") {
    self.metrics = metrics
    self.recapAt = recapAt
    self.recapLabel = recapLabel
    self.book = TerminalHeightBook(rows: TerminalRows(rows: []), metrics: metrics)
  }

  /// Refold and re-measure. Cheap by design: a streamed delta changes the last
  /// row, so the cache answers for every row above it.
  func update(items: [TranscriptItem], metrics: TerminalMetrics) {
    let metricsChanged = metrics != self.metrics
    self.metrics = metrics
    self.items = items

    let rows = TerminalRows.build(
      items: items, recapAt: recapAt, recapLabel: recapLabel)
    // Nothing to do when neither the content nor the cell moved — this is called
    // from a view update, which fires for reasons that are not either.
    if !metricsChanged && rows == self.rows { return }

    self.rows = rows
    promptRows = rows.promptRows
    remeasure()
    // A long session would otherwise keep a plan for every row it has ever
    // shown, including the ones a `/clear` took away.
    cache.evict(keeping: rows)
  }

  /// A press on a line: open or close what it points at, then re-measure.
  ///
  /// The rows are untouched — expansion is not a refold — so keys, indices and
  /// `rowIndex(forItem:)` all stand, and the scroll view's escaped-regime anchor
  /// holds the reader still over the change for free.
  func press(_ press: TermPress, row: Int) {
    let opened = expansion.apply(press)
    remeasure()
    guard opened else { return }
    revealNonce += 1
    reveal = TranscriptRevealRequest(row: row, nonce: revealNonce)
  }

  #if DEBUG
    /// Open every block there is. The preview harness's gate: the overflow audit
    /// can check the expanded plan arithmetically, but only a real layout pass
    /// can show that fifty planned lines are fifty drawn lines in the frames the
    /// book handed out.
    func expandEverything() {
      expansion = .everything(in: rows)
      remeasure()
    }
  #endif

  private func remeasure() {
    book = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache, expansion: expansion)
  }

  /// The lines a row draws. Planned on demand rather than stored: only the rows
  /// on screen need their text, and holding the plan for a ten-thousand-row
  /// transcript is megabytes of strings nobody is reading.
  func plan(at index: Int) -> [TermLine] {
    guard index >= 0, index < rows.count else { return [] }
    return TerminalPlanner.plan(rows[index], metrics: metrics, expansion: expansion)
  }

  func gapAbove(_ index: Int) -> Bool { rows.gapBefore(index) }

  /// Where a transcript item is on screen — through the row model, never by
  /// arithmetic. A folded run and an absorbed subagent child both break any
  /// index-to-row shortcut.
  func rowIndex(forItem index: Int) -> Int { rows.rowIndex(forItem: index) }
}
