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

    let rows = TerminalRows.build(
      items: items, recapAt: recapAt, recapLabel: recapLabel)
    // Nothing to do when neither the content nor the cell moved — this is called
    // from a view update, which fires for reasons that are not either.
    if !metricsChanged && rows == self.rows { return }

    self.rows = rows
    self.book = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    // A long session would otherwise keep a plan for every row it has ever
    // shown, including the ones a `/clear` took away.
    cache.evict(keeping: rows)
  }

  /// The lines a row draws. Planned on demand rather than stored: only the rows
  /// on screen need their text, and holding the plan for a ten-thousand-row
  /// transcript is megabytes of strings nobody is reading.
  func plan(at index: Int) -> [TermLine] {
    guard index >= 0, index < rows.count else { return [] }
    return TerminalPlanner.plan(rows[index], metrics: metrics)
  }

  func gapAbove(_ index: Int) -> Bool { rows.gapBefore(index) }

  /// Where a transcript item is on screen — through the row model, never by
  /// arithmetic. A folded run and an absorbed subagent child both break any
  /// index-to-row shortcut.
  func rowIndex(forItem index: Int) -> Int { rows.rowIndex(forItem: index) }
}
