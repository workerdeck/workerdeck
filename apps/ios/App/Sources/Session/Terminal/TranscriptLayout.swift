import UIKit
import WorkerDeckKit

/// The transcript's collection-view layout: one column, every frame read
/// straight from `TerminalHeightBook`.
///
/// This is the iOS spelling of the web client's virtualizer contract
/// (`packages/ui/src/components/agent/Transcript.tsx`): row sizes are
/// **computed, never estimated and never self-sized**. The book derives each
/// row's height from its content with no layout pass, which is what makes the
/// scrollbar honest before rows mount, lets `scrollToRow` land exactly instead
/// of accumulating error over unmounted spans, and is the foundation the
/// scrubber needs — a mark for an unmounted row is only drawable because its
/// offset is already known. A self-sizing cell would re-introduce exactly the
/// estimate-then-correct loop this design exists to avoid, so the layout never
/// consults `preferredLayoutAttributesFitting` (the base class's default) and
/// the hosting view never gets a vote on its own height.
///
/// There is deliberately no per-row cache to build or invalidate: `prepare()`
/// is O(1), attributes are computed on demand from the book, and the visible
/// range is found by binary search. That is what makes replacing the book —
/// which happens on every folded delta while a turn streams — an
/// `invalidateLayout()` and nothing else.
final class TranscriptLayout: UICollectionViewLayout {
  private(set) var book: TerminalHeightBook?
  private(set) var rowCount = 0
  private var width: CGFloat = 0

  /// Swap in a new epoch's frames. Cheap by design — see the type comment.
  /// `rowCount` rides along because the book answers offsets, not membership.
  func setBook(_ book: TerminalHeightBook?, rowCount: Int) {
    self.book = book
    self.rowCount = rowCount
    invalidateLayout()
  }

  override func prepare() {
    guard let cv = collectionView else { return }
    // Inset, not bare bounds: horizontal safe areas (landscape) arrive through
    // `adjustedContentInset`, and a content width that ignored them would make
    // the whole transcript horizontally scrollable by exactly that many points.
    width = cv.bounds.inset(by: cv.adjustedContentInset).width
  }

  override var collectionViewContentSize: CGSize {
    CGSize(width: width, height: book?.totalHeight ?? 0)
  }

  override func layoutAttributesForItem(at indexPath: IndexPath)
    -> UICollectionViewLayoutAttributes?
  {
    guard let book, indexPath.item >= 0, indexPath.item < rowCount else { return nil }
    let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
    // The frame *includes* the blank-line gap above the row — `height(at:)`'s
    // contract — so frames tile the content exactly and the row view draws its
    // own gap, the same way the web row carries it as padding on the measured
    // element. Spacing the layout owned would be a second spacing rule beside
    // `gapBefore`, and two rules is how grids drift.
    attributes.frame = CGRect(
      x: 0,
      y: book.offset(at: indexPath.item),
      width: width,
      height: book.height(at: indexPath.item))
    return attributes
  }

  override func layoutAttributesForElements(in rect: CGRect)
    -> [UICollectionViewLayoutAttributes]?
  {
    guard let book, rowCount > 0 else { return nil }
    // Binary search for the first candidate row, then walk forward — never a
    // scan of all rows; this runs on every scroll tick of a transcript that can
    // be thousands of rows long.
    var index = min(max(book.rowIndex(atOffset: rect.minY), 0), rowCount - 1)
    // The book's rounding convention at an exact boundary is not ours to
    // assume; step back to the row actually containing (or preceding) minY.
    while index > 0, book.offset(at: index) > rect.minY { index -= 1 }
    var attributes: [UICollectionViewLayoutAttributes] = []
    while index < rowCount, book.offset(at: index) < rect.maxY {
      if let item = layoutAttributesForItem(at: IndexPath(item: index, section: 0)),
        item.frame.maxY > rect.minY
      {
        attributes.append(item)
      }
      index += 1
    }
    return attributes
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
    // Width is the only bounds dependency — it is every row's frame width, and
    // (through the parent's re-measured metrics) every row's wrap. A height
    // change is just scrolling and must not invalidate; offsets and heights
    // come from the book and change only when it is replaced.
    guard let cv = collectionView else { return false }
    return newBounds.width != cv.bounds.width
  }
}
