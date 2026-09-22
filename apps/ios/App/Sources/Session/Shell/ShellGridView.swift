import SwiftUI
import UIKit
import WorkerDeckKit

/// The grid, drawn.
///
/// UIKit and `draw(_:)` rather than SwiftUI text, for the reason the transcript
/// renderer is also hand-drawn: this surface redraws thirty times a second while
/// a build talks, and a view tree rebuilt at that rate is the one thing a phone
/// cannot afford. Here it is cheaper still, because a grid needs no layout at
/// all - every cell's rectangle is arithmetic on the column and the line.
struct ShellGridView: UIViewRepresentable {
  let screen: VTScreen
  /// Read so that a bump re-runs `updateUIView`. The value itself is unused:
  /// the grid is read straight off `screen`.
  let revision: Int
  let typography: TerminalTypography
  /// Called with the columns and rows the pane can actually hold, after every
  /// layout pass.
  let onMeasure: (Int, Int) -> Void

  func makeUIView(context: Context) -> ShellScrollView {
    let view = ShellScrollView()
    view.configure(screen: screen, typography: typography, onMeasure: onMeasure)
    return view
  }

  func updateUIView(_ view: ShellScrollView, context: Context) {
    view.configure(screen: screen, typography: typography, onMeasure: onMeasure)
    view.reload()
  }
}

/// The scroller around the canvas, and the one piece of behaviour that is not
/// arithmetic: **it follows the tail unless the reader has scrolled away from
/// it.** A terminal that jumped to the bottom on every chunk would be unusable
/// while output is flowing, and one that never did would have to be dragged
/// after every command.
final class ShellScrollView: UIScrollView, UIScrollViewDelegate {
  private let canvas = ShellCanvasView()
  private var onMeasure: ((Int, Int) -> Void)?
  private var pinned = true
  private var lastMeasured: (cols: Int, rows: Int)?

  /// How far from the foot still counts as "at the foot". One line would make
  /// the pin flicker on a rubber-band; a few lines is what a thumb resting
  /// mid-drag actually produces.
  private static let pinSlack: CGFloat = 24

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    backgroundColor = .clear
    showsHorizontalScrollIndicator = true
    alwaysBounceVertical = true
    // The canvas is the exact width of the column budget, so a horizontal
    // scroll would only ever reveal blank ground. A program that draws wider
    // than the pane is the pane's problem to report, not the scroller's to
    // paper over.
    bounces = true
    addSubview(canvas)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  func configure(
    screen: VTScreen, typography: TerminalTypography, onMeasure: @escaping (Int, Int) -> Void
  ) {
    canvas.screen = screen
    canvas.typography = typography
    self.onMeasure = onMeasure
  }

  func reload() {
    canvas.setNeedsDisplay()
    layoutCanvas()
    if pinned { scrollToBottom() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    measure()
    layoutCanvas()
    if pinned { scrollToBottom() }
  }

  /// Tell the model how big the pane is, in cells. Reported only on a change:
  /// every resize reaches the process as SIGWINCH, and a redrawing TUI pays for
  /// each one.
  private func measure() {
    guard let typography = canvas.typography, bounds.width > 0, bounds.height > 0 else { return }
    let cols = max(Int(floor(bounds.width / typography.cell)), 20)
    let rows = max(Int(floor(bounds.height / typography.line)), 4)
    guard lastMeasured?.cols != cols || lastMeasured?.rows != rows else { return }
    lastMeasured = (cols, rows)
    onMeasure?(cols, rows)
  }

  private func layoutCanvas() {
    guard let screen = canvas.screen, let typography = canvas.typography else { return }
    let size = CGSize(
      width: max(bounds.width, CGFloat(screen.cols) * typography.cell),
      height: max(bounds.height, CGFloat(screen.totalRows) * typography.line))
    if canvas.frame.size != size { canvas.frame = CGRect(origin: .zero, size: size) }
    if contentSize != size { contentSize = size }
  }

  private func scrollToBottom() {
    let y = max(contentSize.height - bounds.height + adjustedContentInset.bottom, -adjustedContentInset.top)
    guard abs(contentOffset.y - y) > 0.5 else { return }
    setContentOffset(CGPoint(x: contentOffset.x, y: y), animated: false)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    // Only a drag or a fling un-pins. Our own `scrollToBottom` also lands here,
    // and reading the pin from it would let one rounding error latch the view
    // off the tail for good.
    guard isDragging || isDecelerating else { return }
    let distance = contentSize.height - bounds.height - contentOffset.y
    pinned = distance <= Self.pinSlack
  }
}

/// One `draw(_:)` over the grid. Draws only the lines the dirty rect covers, so
/// a thousand lines of scrollback cost nothing until they are looked at.
final class ShellCanvasView: UIView {
  var screen: VTScreen?
  var typography: TerminalTypography?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  override func draw(_ rect: CGRect) {
    guard let screen, let typography else { return }
    let line = typography.line
    let cell = typography.cell
    let first = max(Int(floor(rect.minY / line)), 0)
    let last = min(Int(ceil(rect.maxY / line)), screen.totalRows)
    guard first < last else { return }

    // The cursor's row in the same coordinates the lines are in. The screen
    // reports it relative to the live screen, which sits after the scrollback.
    let cursorRow = screen.scrollbackCount + screen.cursorRow

    for index in first..<last {
      let y = CGFloat(index) * line
      var column = 0
      for run in screen.line(at: index).runs() {
        // Scrollback is stored as it was emitted and never cut, so a line from
        // before a narrowing resize is wider than the grid. Clipped here rather
        // than reflowed: reflowing emitted output is what the emulator
        // deliberately does not do, and drawing past the canvas would spill
        // under the scroll indicator.
        guard column < screen.cols else { break }
        // `columns`, never the text's length: a wide glyph is one Character in
        // two cells, and counting characters would walk every later run in the
        // line one cell to the left.
        let (fg, bg) = ShellPalette.resolve(run.style)
        let box = CGRect(
          x: CGFloat(column) * cell, y: y, width: CGFloat(run.columns) * cell, height: line)
        if let bg {
          bg.setFill()
          UIRectFill(box)
        }
        if !run.style.hidden {
          draw(run.text, at: box, color: fg, style: run.style, typography: typography)
        }
        column += run.columns
      }
      if screen.cursorVisible, index == cursorRow {
        // A block, not a bar, and not blinking: a block is legible at 12pt on a
        // phone, and a blink is a timer that would redraw a still screen.
        ShellPalette.cursor.withAlphaComponent(0.55).setFill()
        UIRectFill(CGRect(x: CGFloat(screen.cursorCol) * cell, y: y, width: cell, height: line))
      }
    }
  }

  private func draw(
    _ text: String, at box: CGRect, color: UIColor, style: VTStyle,
    typography: TerminalTypography
  ) {
    guard !text.isEmpty else { return }
    var font = typography.uiFont
    if style.bold || style.italic {
      var traits: UIFontDescriptor.SymbolicTraits = []
      if style.bold { traits.insert(.traitBold) }
      if style.italic { traits.insert(.traitItalic) }
      // The monospaced descriptor keeps the advance, which is the whole grid. A
      // face that lost it here would put every later column half a pixel out.
      if let descriptor = font.fontDescriptor.withSymbolicTraits(
        font.fontDescriptor.symbolicTraits.union(traits))
      {
        font = UIFont(descriptor: descriptor, size: typography.fontSize)
      }
    }
    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    if style.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
    if style.strikethrough { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    // Baseline from the top of the grid line, so a glyph sits where the cell
    // says rather than where the string's own line box would put it.
    let baseline = box.minY + (box.height - font.lineHeight) / 2
    NSAttributedString(string: text, attributes: attributes)
      .draw(at: CGPoint(x: box.minX, y: baseline))
  }
}
