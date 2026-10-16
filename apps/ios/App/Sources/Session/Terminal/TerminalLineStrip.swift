import SwiftUI
import UIKit
import WorkerDeckKit

/// One planned line, drawn by the row cell's own primitives.
///
/// A `UIViewRepresentable` around the same backdrop/gutter/body triple a row
/// cell uses, because the whole claim of the sticky prompt is that it is *the
/// same line* - a second renderer would be a second set of column arithmetic,
/// and the drift would be a fraction of a cell.
struct TerminalLineStrip: UIViewRepresentable {
  let line: TermLine
  let typography: TerminalTypography
  let metrics: TerminalMetrics
  let bleed: CGFloat

  func makeUIView(context: Context) -> TerminalRowCell { TerminalRowCell(frame: .zero) }

  func updateUIView(_ view: TerminalRowCell, context: Context) {
    view.configure(
      lines: [line], typography: typography, metrics: metrics, gapAbove: false, bleed: bleed,
      onPress: { _ in })
    // A copy is not the text. Selecting the pinned line would put the reader's
    // selection somewhere they cannot see it, and it would swallow the tap that
    // takes them to the real row.
    view.bodyIsSelectable = false
    // The band is the row's own wash and it is what makes the strip opaque
    // enough to sit over moving text. Nothing else may show through.
    view.backgroundColor = UIColor.systemBackground
  }
}
