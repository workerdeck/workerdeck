import Observation
import SwiftUI
import UIKit
import WorkerDeckKit

// MARK: - Anchors & readings

/// Where a jumped-to row lands in the viewport.
enum TranscriptRowAnchor: Sendable {
  case top
  case center
  case bottom
}

/// One frame's worth of scroll geometry, all in **content space** (the top
/// inset already folded in, so `contentOffset` is "how far into the content the
/// first visible point is"). This is the coordinate system the scrubber's
/// `railScale` arithmetic wants — its denominator is
/// `max(contentHeight, viewportHeight)`, exactly as on the web.
struct TranscriptScrollReadings: Equatable, Sendable {
  var contentOffset: CGFloat = 0
  var viewportHeight: CGFloat = 0
  var contentHeight: CGFloat = 0
  var pinned = true
}

/// What the coordinator answers for; the model forwards commands through it.
/// A protocol rather than the coordinator type because the coordinator is
/// generic over the row content and the model must not be.
@MainActor
protocol TranscriptScrollDriver: AnyObject {
  func scrollToBottom(animated: Bool)
  func scrollToRow(_ index: Int, anchor: TranscriptRowAnchor, animated: Bool)
}

/// The handle the parent holds: commands in, live readings out.
///
/// Readings are published once per runloop turn (the coordinator coalesces
/// them), so a 120Hz scroll writes at most one observation mutation per frame
/// and only views that actually read a field re-render — the scrubber's
/// cursor, not the whole session screen. Held by the parent as `@State` so it
/// survives the representable's many re-inits.
@MainActor @Observable
final class TranscriptScrollModel {
  private(set) var contentOffset: CGFloat = 0
  private(set) var viewportHeight: CGFloat = 0
  private(set) var contentHeight: CGFloat = 0
  /// True while the transcript follows its tail. The jump-to-latest button is
  /// `!pinned`.
  private(set) var pinned = true

  /// Wired by the coordinator; ignored by observation because it is command
  /// plumbing, not a reading.
  @ObservationIgnored weak var driver: TranscriptScrollDriver?

  func scrollToBottom(animated: Bool = true) {
    driver?.scrollToBottom(animated: animated)
  }

  /// Jump to a row by **row index** (the fold's index, not a transcript item
  /// index — resolve items through `TerminalRows.rowIndex(forItem:)` first,
  /// never by arithmetic; a `Task` row covers a membership).
  func scrollToRow(_ index: Int, anchor: TranscriptRowAnchor = .top, animated: Bool = false) {
    driver?.scrollToRow(index, anchor: anchor, animated: animated)
  }

  func publish(_ readings: TranscriptScrollReadings) {
    // Field-by-field, so an unchanged reading costs no observation churn.
    if contentOffset != readings.contentOffset { contentOffset = readings.contentOffset }
    if viewportHeight != readings.viewportHeight { viewportHeight = readings.viewportHeight }
    if contentHeight != readings.contentHeight { contentHeight = readings.contentHeight }
    if pinned != readings.pinned { pinned = readings.pinned }
  }
}

// MARK: - Collection view

/// A `UICollectionView` that reports geometry changes to the coordinator. Both
/// hooks are needed: the composer growing and the keyboard rising arrive as
/// safe-area/inset changes with the bounds untouched (`adjustedContentInsetDidChange`),
/// while a rotation is a bounds change that lands in `layoutSubviews`.
final class TranscriptCollectionView: UICollectionView {
  var onGeometryChange: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onGeometryChange?()
  }

  override func adjustedContentInsetDidChange() {
    super.adjustedContentInsetDidChange()
    onGeometryChange?()
  }
}

private let transcriptRowReuseIdentifier = "row"

// MARK: - Representable

/// The virtualized terminal transcript: a `UICollectionView` under
/// `TranscriptLayout`, cells hosting SwiftUI rows via `UIHostingConfiguration`.
///
/// The row builder is a **generic `RowContent`, not `(Int) -> AnyView`**, and
/// that is a recycling decision: with a concrete generic type every
/// reconfigure of a reused cell is a SwiftUI *update* of the same view type —
/// state-preserving diffing, no teardown — where `AnyView` erases identity and
/// makes each reuse a remount. It also spares an allocation per configure on
/// the hottest path there is (cells appearing during a fling).
///
/// Contract with the parent, stated because the types cannot express it:
/// - `rows`, `book` and `metrics` are one epoch: the book was built from
///   exactly these rows at exactly these metrics. The layout draws frames from
///   the book and the rows draw their pre-wrapped lines from the same metrics,
///   which is the whole reason no self-sizing exists here.
/// - Rows are the single source of what a cell draws. The builder runs only
///   when a row (or the metrics) changed — parent state that should redraw a
///   row must be *in* the row. Anything expansion-shaped must flow through the
///   rows/book epoch too: an expanded result changes a row's height, and a
///   height the book doesn't know about is a frame the layout gets wrong.
/// - A cell's frame includes the blank-line gap above its row (`gapBefore`);
///   the row view pads itself by one line when the fold says so.
struct VirtualizedTranscriptView<RowContent: View>: UIViewRepresentable {
  var rows: TerminalRows
  var book: TerminalHeightBook
  var metrics: TerminalMetrics
  var scroll: TranscriptScrollModel
  /// Breathing room above the first and below the last row, applied as
  /// `contentInset` so it scrolls with the content and never enters the book.
  var verticalPadding: CGFloat = 0
  @ViewBuilder var rowContent: (Int) -> RowContent

  func makeCoordinator() -> Coordinator {
    Coordinator(rowContent: rowContent)
  }

  func makeUIView(context: Context) -> TranscriptCollectionView {
    let layout = TranscriptLayout()
    let cv = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
    cv.backgroundColor = .clear
    // The composer is docked with `.safeAreaInset(edge: .bottom)` and the nav
    // bar floats; `.automatic` turns both — and the keyboard — into
    // `adjustedContentInset`, which is the one coordinate system every
    // computation below reads. Nothing here assumes where an inset came from.
    cv.contentInsetAdjustmentBehavior = .automatic
    cv.keyboardDismissMode = .interactive
    cv.alwaysBounceVertical = true
    cv.showsHorizontalScrollIndicator = false
    cv.isPrefetchingEnabled = true
    // The load-bearing negation: iOS 16+ would otherwise let the hosting
    // configuration invalidate its own size, and every frame must come from
    // the book — see `TranscriptLayout`.
    cv.selfSizingInvalidation = .disabled
    // Rows are not selectable things; taps belong to what is inside them.
    cv.allowsSelection = false
    cv.contentInset = UIEdgeInsets(top: verticalPadding, left: 0, bottom: verticalPadding, right: 0)
    cv.register(UICollectionViewCell.self, forCellWithReuseIdentifier: transcriptRowReuseIdentifier)
    cv.dataSource = context.coordinator
    cv.delegate = context.coordinator
    context.coordinator.collectionView = cv
    context.coordinator.layout = layout
    cv.onGeometryChange = { [weak coordinator = context.coordinator, weak cv] in
      guard let coordinator, let cv else { return }
      coordinator.geometryChanged(cv)
    }
    context.coordinator.attach(model: scroll)
    return cv
  }

  func updateUIView(_ uiView: TranscriptCollectionView, context: Context) {
    let coordinator = context.coordinator
    coordinator.rowContent = rowContent
    coordinator.attach(model: scroll)
    if uiView.contentInset.top != verticalPadding || uiView.contentInset.bottom != verticalPadding {
      uiView.contentInset = UIEdgeInsets(
        top: verticalPadding, left: 0, bottom: verticalPadding, right: 0)
    }
    coordinator.apply(rows: rows, book: book, metrics: metrics)
  }

  // MARK: - Coordinator

  /// Owns the data source, the key diff, and the one genuinely hard rule on
  /// this surface: **two parties want to write `contentOffset`** — following
  /// the tail, and holding the scrollback still while content above it
  /// changes. The web client resolves it by splitting regimes
  /// (`packages/ui/src/components/agent/Transcript.tsx`), and this mirrors it:
  ///
  /// - **Pinned, corrections are suppressed.** Being at the bottom *is* the
  ///   scroll position; the offsets of rows above are moot. Every applied
  ///   epoch ends with one write: the bottom.
  /// - **Escaped, the scrollback holds still.** Before an epoch lands, the row
  ///   under the viewport's top edge is captured *by key* plus the offset into
  ///   it; after, the offset is re-derived from that key's new position. A key
  ///   anchor rather than a sum of height deltas because rows fold — a run
  ///   absorbs its successor, a recap splices in — so "the same row" is a
  ///   membership question the keys already answer, not an index. If the key
  ///   vanished (its call folded into a neighbouring run), the numeric offset
  ///   stands, clamped: one line of drift in a case the reader cannot have
  ///   been reading closely, against no correction at all.
  ///
  /// The moment the user scrolls up, the pin releases; scrolling back to
  /// within `repinThreshold` of the bottom re-arms it. Only *user* scrolls
  /// move the flag — `isTracking || isDragging || isDecelerating` — so our own
  /// writes can never be mistaken for an escape, which is the exact bug the
  /// web comment warns about (a correction reading as a user scroll and
  /// breaking the lock mid-stream).
  @MainActor
  final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate,
    TranscriptScrollDriver
  {
    var rowContent: (Int) -> RowContent
    weak var collectionView: TranscriptCollectionView?
    weak var layout: TranscriptLayout?
    private(set) var model: TranscriptScrollModel?

    private(set) var rows = TerminalRows(rows: [])
    private var book: TerminalHeightBook?
    private var metrics: TerminalMetrics?
    /// Cached keys of `rows` — the diff runs per applied epoch and rebuilding
    /// the old side each time would double its cost.
    private var keys: [String] = []

    private var pinned = true
    /// Re-pin when the user stops within this of the bottom. One line-ish of
    /// slack: generous enough that "I scrolled back down" counts, small enough
    /// that reading the second-to-last row never gets yanked.
    private let repinThreshold: CGFloat = 44

    private var lastWidth: CGFloat = 0
    private var lastViewport: CGFloat = 0

    private var latest = TranscriptScrollReadings()
    private var publishScheduled = false

    init(rowContent: @escaping (Int) -> RowContent) {
      self.rowContent = rowContent
    }

    func attach(model: TranscriptScrollModel) {
      guard model !== self.model else { return }
      self.model = model
      model.driver = self
    }

    // MARK: Epochs

    func apply(rows newRows: TerminalRows, book newBook: TerminalHeightBook,
      metrics newMetrics: TerminalMetrics)
    {
      let rowsChanged = newRows != rows
      let metricsChanged = newMetrics != metrics
      // Equal (rows, metrics) derive an identical book — the calculator is
      // deterministic, which is the premise of this whole surface — so there
      // is nothing to do. This guard is what makes it safe for SwiftUI to call
      // `updateUIView` as often as it likes.
      guard rowsChanged || metricsChanged else { return }

      guard let cv = collectionView, let layout else {
        self.rows = newRows
        self.book = newBook
        self.metrics = newMetrics
        self.keys = newRows.rows.map(\.key)
        return
      }

      let old = rows
      let oldBook = book
      let oldKeys = keys
      let wasPinned = pinned
      // The anchor is captured before anything moves, and only when escaped —
      // pinned needs no anchor, the bottom is the anchor.
      let anchor = wasPinned ? nil : captureAnchor(cv, old: old, oldBook: oldBook)

      rows = newRows
      book = newBook
      metrics = newMetrics
      let newKeys = newRows.rows.map(\.key)
      keys = newKeys
      layout.setBook(newBook, rowCount: newRows.count)

      UIView.performWithoutAnimation {
        if cv.window == nil {
          // Not yet on screen: batch-update bookkeeping buys nothing and UIKit
          // is touchy about updates before the first layout.
          cv.reloadData()
        } else if newKeys == oldKeys {
          // The streaming shape: same rows, one of them grew (a delta landed,
          // a call settled into its run). Reconfigure keeps the same cell and
          // hosting view, so SwiftUI diffs in place.
          reconfigureVisible(cv, old: old, force: metricsChanged)
        } else if newKeys.count > oldKeys.count, newKeys.starts(with: oldKeys) {
          // The append shape. The old tail commonly changed in the same event
          // (a run's key is its *first* call, so a growing run appends
          // nothing), hence the reconfigure ride-along.
          let inserted = (oldKeys.count..<newKeys.count).map { IndexPath(item: $0, section: 0) }
          cv.performBatchUpdates { cv.insertItems(at: inserted) }
          reconfigureVisible(cv, old: old, force: metricsChanged)
        } else {
          // Anything structural — a refold, the recap splice, a truncation.
          // Deliberately not a keyed batch-diff: UICollectionView move/delete
          // arithmetic is a classic crash source for exactly these reshapes,
          // and with frames owned by the layout and the offset owned by the
          // regime below, `reloadData` has no visual cost to pay for.
          cv.reloadData()
        }

        // The offset is written *before* forcing layout, computed from the
        // book rather than `contentSize` (stale until the pass runs), so the
        // single layout that follows mounts cells at their final positions.
        if wasPinned {
          // While a finger is down, a write here would fight the pan gesture
          // (UIKit reapplies its own translation on the next touch move).
          // The pin re-asserts on the next epoch or when the touch ends.
          if !cv.isTracking { pinToBottom(cv) }
        } else if let anchor {
          restoreAnchor(anchor, in: cv)
        } else {
          cv.contentOffset.y = clampedOffsetY(cv.contentOffset.y, in: cv)
        }
        cv.layoutIfNeeded()
      }
      publishReadings(cv)
    }

    private func reconfigureVisible(_ cv: UICollectionView, old: TerminalRows, force: Bool) {
      // Positional compare is sound here because both callers guarantee the
      // shared prefix is key-aligned. `force` is the metrics case: an
      // unchanged row still re-wraps when the cell or width changed.
      let paths = cv.indexPathsForVisibleItems.filter { path in
        guard path.item < rows.count else { return false }
        guard path.item < old.count else { return false }  // freshly inserted: configured on mount
        return force || old.rows[path.item] != rows.rows[path.item]
      }
      guard !paths.isEmpty else { return }
      cv.reconfigureItems(at: paths)
    }

    // MARK: The escaped regime's anchor

    private struct Anchor {
      var key: String
      var within: CGFloat
      var nearIndex: Int
    }

    private func captureAnchor(_ cv: UICollectionView, old: TerminalRows,
      oldBook: TerminalHeightBook?) -> Anchor?
    {
      guard let oldBook, old.count > 0 else { return nil }
      let foldY = cv.contentOffset.y + cv.adjustedContentInset.top
      var row = min(max(oldBook.rowIndex(atOffset: foldY), 0), old.count - 1)
      // Settle onto the row actually containing the fold — the book's rounding
      // convention at an exact boundary is not ours to assume.
      while row > 0, oldBook.offset(at: row) > foldY { row -= 1 }
      while row + 1 < old.count, oldBook.offset(at: row + 1) <= foldY { row += 1 }
      return Anchor(
        key: old.rows[row].key,
        within: max(0, foldY - oldBook.offset(at: row)),
        nearIndex: row)
    }

    private func restoreAnchor(_ anchor: Anchor, in cv: UICollectionView) {
      guard let book, let index = rowIndex(forKey: anchor.key, near: anchor.nearIndex) else {
        cv.contentOffset.y = clampedOffsetY(cv.contentOffset.y, in: cv)
        return
      }
      let target = book.offset(at: index) + anchor.within - cv.adjustedContentInset.top
      cv.contentOffset.y = clampedOffsetY(target, in: cv)
    }

    /// Outward scan from where the key last was. Keys move by a handful of
    /// positions per epoch (an append shifts nothing, a fold shifts by one or
    /// two), so this is O(shift), not O(rows) — and never a per-epoch
    /// dictionary of five thousand strings.
    private func rowIndex(forKey key: String, near start: Int) -> Int? {
      let count = rows.count
      guard count > 0 else { return nil }
      let base = min(max(start, 0), count - 1)
      if rows[base].key == key { return base }
      var distance = 1
      while base - distance >= 0 || base + distance < count {
        if base - distance >= 0, rows[base - distance].key == key { return base - distance }
        if base + distance < count, rows[base + distance].key == key { return base + distance }
        distance += 1
      }
      return nil
    }

    // MARK: Geometry

    func geometryChanged(_ cv: TranscriptCollectionView) {
      let inset = cv.adjustedContentInset
      let width = cv.bounds.inset(by: inset).width
      if width != lastWidth {
        lastWidth = width
        // A horizontal *inset* change never reaches
        // `shouldInvalidateLayout(forBoundsChange:)` — the bounds are
        // untouched — so the nudge lives here.
        layout?.invalidateLayout()
      }
      let viewport = cv.bounds.height - inset.top - inset.bottom
      if viewport != lastViewport {
        lastViewport = viewport
        // The composer growing (or the keyboard rising) steals lines from the
        // transcript with no scroll event fired — `contentOffset` is untouched
        // while "the bottom" moved. Re-pin **only when already pinned**: this
        // guard is the whole feature, or every keyboard appearance would yank
        // a reader who had deliberately scrolled up (the web client's scroller
        // ResizeObserver, same rule). It also covers the initial layout, which
        // is what lands a freshly opened session at its tail before first
        // paint.
        if pinned, !cv.isTracking { pinToBottom(cv) }
      }
      publishReadings(cv)
    }

    // MARK: Offsets

    private func contentHeight(_ scrollView: UIScrollView) -> CGFloat {
      // The book over `contentSize`: mid-apply the latter is a layout pass
      // stale, and the book is the truth `contentSize` converges to.
      book?.totalHeight ?? scrollView.contentSize.height
    }

    private func bottomOffsetY(_ scrollView: UIScrollView) -> CGFloat {
      let inset = scrollView.adjustedContentInset
      return max(
        -inset.top,
        contentHeight(scrollView) + inset.bottom - scrollView.bounds.height)
    }

    private func clampedOffsetY(_ y: CGFloat, in scrollView: UIScrollView) -> CGFloat {
      min(max(y, -scrollView.adjustedContentInset.top), bottomOffsetY(scrollView))
    }

    private func distanceFromBottom(_ scrollView: UIScrollView) -> CGFloat {
      bottomOffsetY(scrollView) - scrollView.contentOffset.y
    }

    private func pinToBottom(_ scrollView: UIScrollView) {
      scrollView.contentOffset = CGPoint(
        x: scrollView.contentOffset.x, y: bottomOffsetY(scrollView))
    }

    private func setPinned(_ value: Bool) {
      guard pinned != value else { return }
      pinned = value
    }

    // MARK: Readings

    /// Coalesced to one model write per runloop turn. The hop is also what
    /// keeps apply-path publishes out of SwiftUI's own update (mutating
    /// observed state from inside `updateUIView` is how AttributeGraph cycles
    /// are made); scroll events pay one frame of latency, which nothing
    /// reading these values can perceive.
    private func publishReadings(_ scrollView: UIScrollView) {
      let inset = scrollView.adjustedContentInset
      latest = TranscriptScrollReadings(
        contentOffset: scrollView.contentOffset.y + inset.top,
        viewportHeight: scrollView.bounds.height - inset.top - inset.bottom,
        contentHeight: contentHeight(scrollView),
        pinned: pinned)
      guard !publishScheduled else { return }
      publishScheduled = true
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.publishScheduled = false
        self.model?.publish(self.latest)
      }
    }

    // MARK: Commands (TranscriptScrollDriver)

    func scrollToBottom(animated: Bool) {
      guard let cv = collectionView else { return }
      setPinned(true)
      cv.setContentOffset(
        CGPoint(x: cv.contentOffset.x, y: bottomOffsetY(cv)), animated: animated)
      if !animated { publishReadings(cv) }
    }

    func scrollToRow(_ index: Int, anchor: TranscriptRowAnchor, animated: Bool) {
      guard let cv = collectionView, let book, index >= 0, index < rows.count else { return }
      let inset = cv.adjustedContentInset
      let visible = cv.bounds.height - inset.top - inset.bottom
      let top = book.offset(at: index)
      let height = book.height(at: index)
      let contentY: CGFloat
      switch anchor {
      // `.top` lands on the frame's top, gap line included — the breathing
      // room is wanted there, and it matches the web's one-line scroll margin
      // on a jumped-to row.
      case .top: contentY = top
      case .center: contentY = top + (height - visible) / 2
      case .bottom: contentY = top + height - visible
      }
      let target = clampedOffsetY(contentY - inset.top, in: cv)
      // A jump decides the pin from where it lands, not from where it left:
      // jumping to the last row *is* going to the bottom.
      setPinned(target >= bottomOffsetY(cv) - repinThreshold)
      cv.setContentOffset(CGPoint(x: cv.contentOffset.x, y: target), animated: animated)
      if !animated { publishReadings(cv) }
    }

    // MARK: UICollectionViewDataSource

    func numberOfSections(in collectionView: UICollectionView) -> Int { 1 }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int)
      -> Int
    { rows.count }

    func collectionView(_ collectionView: UICollectionView,
      cellForItemAt indexPath: IndexPath) -> UICollectionViewCell
    {
      let cell = collectionView.dequeueReusableCell(
        withReuseIdentifier: transcriptRowReuseIdentifier, for: indexPath)
      // Zero margins: the grid owns every point of geometry, and the default
      // hosting margins would put the whole transcript off the cell frames the
      // book computed.
      cell.contentConfiguration = UIHostingConfiguration { [rowContent] in
        rowContent(indexPath.item)
      }
      .margins(.all, 0)
      cell.backgroundConfiguration = .clear()
      return cell
    }

    // MARK: UIScrollViewDelegate

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
      // Only a *user's* scroll may move the pin — this is the regime split's
      // load-bearing guard. Our own writes (pins, corrections, animated jumps)
      // arrive here with all three flags false and fall through to readings.
      if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
        setPinned(distanceFromBottom(scrollView) <= repinThreshold)
      }
      publishReadings(scrollView)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
      guard !decelerate, pinned else { return }
      // Settle the last few points so "pinned" means *at* the bottom, not
      // near it — otherwise an idle session rests a half-line short until the
      // next event pins it.
      scrollView.setContentOffset(
        CGPoint(x: scrollView.contentOffset.x, y: bottomOffsetY(scrollView)), animated: true)
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
      guard pinned else { return }
      scrollView.setContentOffset(
        CGPoint(x: scrollView.contentOffset.x, y: bottomOffsetY(scrollView)), animated: true)
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
      // The status-bar tap is a user scroll that fires no tracking flags.
      setPinned(false)
      publishReadings(scrollView)
    }
  }
}
