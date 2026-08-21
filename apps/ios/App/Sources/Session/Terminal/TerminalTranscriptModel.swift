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

  /// The items these rows fold — the frame's own list when this model folds a
  /// takeover. Readable because the scrubber's input must describe the same
  /// items the fold did: the rail's marks resolve through these rows, and a
  /// caller's unfolded list would be a second answer to "what is on screen".
  private(set) var items: [TranscriptItem] = []

  /// The catch-up seam: how many rows had already been read when this session
  /// was opened. Fixed at mount — a boundary that moved as new rows arrived
  /// would be a boundary that never means anything.
  private let recapAt: Int?
  private let recapLabel: String

  /// Set when this model folds a sub-agent's frame — the takeover. Constant for
  /// the model's whole life (a takeover is one agent, remounted per open), which
  /// is what keeps the plan cache valid: the cache keys on row and expansion
  /// alone, so a frame id that changed under it would poison every height.
  private let frameParentId: String?

  private var metrics: TerminalMetrics
  private let cache = TerminalPlanCache()

  init(
    metrics: TerminalMetrics, recapAt: Int? = nil, recapLabel: String = "",
    frameParentId: String? = nil
  ) {
    self.metrics = metrics
    self.recapAt = recapAt
    self.recapLabel = recapLabel
    self.frameParentId = frameParentId
    self.book = TerminalHeightBook(rows: TerminalRows(rows: []), metrics: metrics)
  }

  /// Refold and re-measure. Cheap by design: a streamed delta changes the last
  /// row, so the cache answers for every row above it.
  /// - Parameter frameTask: the spawning call, when this model folds a frame —
  ///   its brief leads the rows (`TerminalRows.build`). Passed per update
  ///   rather than held: the call is an item of the *full* transcript, which
  ///   this model never sees, and only the caller that sliced the frame has it.
  func update(items: [TranscriptItem], metrics: TerminalMetrics, frameTask: ToolCallItem? = nil) {
    let metricsChanged = metrics != self.metrics
    self.metrics = metrics
    self.items = items
    // A fetch landing is an item mutation and arrives here like any other. The
    // key crosses from `pending` to `full` in the same pass that plans the new
    // text, so the row goes from "fetching 641,003 chars" straight to the whole
    // result with no intermediate state on screen.
    resolveFetched()

    let rows = TerminalRows.build(
      items: items, recapAt: recapAt, recapLabel: recapLabel, frameTask: frameTask)
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
  /// - Parameter fetch: how to ask for the rest of a truncated result. Absent
  ///   outside a live session, and the press then does nothing rather than
  ///   promising text nobody can deliver.
  /// - Parameter openSubagent: how a `Task` row's press raises the takeover.
  ///   Absent — the preview harness, or any surface with no navigation stack to
  ///   push — the press falls back to the inline toggle, so the target never
  ///   visibly does nothing: the web draws no affordance when it has nowhere to
  ///   go, and here the press rides the plan, so the fallback is the view
  ///   layer's version of the same honesty.
  func press(
    _ press: TermPress, row: Int, fetch: ToolResultFetcher? = nil,
    openSubagent: ((String) -> Void)? = nil
  ) {
    if case .openSubagent(let taskId) = press {
      if let openSubagent {
        openSubagent(taskId)
      } else {
        self.press(.toggle(.task(taskId)), row: row, fetch: fetch)
      }
      return
    }
    // "Show everything" on a result the replay delivered as a head is a network
    // round trip, so it does not lift a budget — it enters `pending`, the
    // planner draws a line saying what is in flight, and the text arrives as a
    // mutation of the item (see `update`). Planning from `totalChars` instead
    // would invent a line count for text nobody has seen.
    if case .expandFull(let callId) = press, let call = truncatedCall(callId) {
      guard expansion.beginFetch(callId: callId) else { return }
      remeasure()
      fetch?(call.id)
      return
    }
    // The row's whole key set goes with the press, so closing a container closes
    // what it contains — see `TerminalExpansion.close`. Computed here because
    // this is the only place that holds both the press and the rows it landed
    // on; it is one block's walk, on a press.
    let opened = expansion.apply(press, subtree: subtreeKeys(at: row))
    remeasure()
    guard opened else { return }
    revealNonce += 1
    reveal = TranscriptRevealRequest(row: row, nonce: revealNonce)
  }

  /// Every expansion key inside the row at this index — a container's subtree,
  /// for the press that closes it. Empty for a recap seam or an out-of-range
  /// index, both of which open nothing.
  private func subtreeKeys(at row: Int) -> Set<ExpansionKey> {
    guard row >= 0, row < rows.count else { return [] }
    return expansionKeys(of: rows[row])
  }

  /// The call behind an id, when its result is still only a head.
  private func truncatedCall(_ id: String) -> ToolCallItem? {
    for item in items {
      guard case .toolCall(let call) = item, call.id == id else { continue }
      return call.result?.truncated == true ? call : nil
    }
    return nil
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

  /// Promote every pending key whose result is no longer a head.
  ///
  /// Driven off the items rather than off the fetch's completion, which is what
  /// makes it self-healing: the hydration lands in transcript state, and any
  /// path that puts the whole text on an item — a fetch, a re-attach without
  /// truncation — resolves the row the same way.
  private func resolveFetched() {
    guard !expansion.pending.isEmpty else { return }
    for id in expansion.pending where truncatedCall(id) == nil {
      expansion.finishFetch(callId: id)
    }
  }

  private func remeasure() {
    book = TerminalHeightBook(
      rows: rows, metrics: metrics, cache: cache, expansion: expansion,
      frameParentId: frameParentId)
  }

  /// The lines a row draws. Planned on demand rather than stored: only the rows
  /// on screen need their text, and holding the plan for a ten-thousand-row
  /// transcript is megabytes of strings nobody is reading.
  func plan(at index: Int) -> [TermLine] {
    guard index >= 0, index < rows.count else { return [] }
    // The **subset**, not the whole expansion — which is what the book planned
    // this row's cached height from (`TerminalHeightBook.lineCounts`). Handing
    // the two a different value made "the lines drawn are as tall as the height
    // reserved" a claim that two derivations agree, resting on the planner
    // reading nothing outside the subset's domain. It is the one thing this
    // renderer cannot get wrong, so it is now the same function of the same
    // value rather than an argument.
    return TerminalPlanner.plan(
      rows[index], metrics: metrics, expansion: expansion.subset(for: rows[index]),
      frameParentId: frameParentId)
  }

  func gapAbove(_ index: Int) -> Bool { rows.gapBefore(index) }

  /// Where a transcript item is on screen — through the row model, never by
  /// arithmetic. A folded run and an absorbed subagent child both break any
  /// index-to-row shortcut.
  func rowIndex(forItem index: Int) -> Int { rows.rowIndex(forItem: index) }
}
