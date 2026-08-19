import UIKit
import WorkerDeckKit

/// One planned row, drawn by hand: a text run for the body, a gutter column
/// beside it, and the bands behind both.
///
/// This replaces the `UIHostingConfiguration` of ~2 SwiftUI views per *line*
/// with three views per *row*, and it exists for one reason that is not
/// performance: **the body has to be one selectable text run**. A stack of
/// per-line `Text`s cannot be selected across, and a selection that stops at
/// the end of every wrapped line is not a feature anyone wanted.
///
/// Three rules hold it together, and each is a silent failure if broken.
///
/// 1. **The gutter is a separate column, and it is not text.** Not for layout —
///    for what lands on the clipboard. `●`, `⎿` and a diff's line numbers are
///    scaffolding the reader did not type and does not want pasted into a
///    commit message, so they are *drawn*, never part of the run. The column
///    also gives every wrapped line its hanging indent for free, which is why
///    the planner pads gutters to a cell count rather than prefixing the text.
///
/// 2. **The planner's lines are the text system's paragraphs.** Each `TermLine`
///    becomes one paragraph with wrapping off (`.byClipping`) and
///    `minimumLineHeight == maximumLineHeight == metrics.line`, its head indent
///    set to where its body column starts. So N planned lines are N line
///    fragments of exactly `line` points, and the height the book handed the
///    layout is the height the text actually occupies — by construction, not by
///    agreement. `TerminalRowCell.measuredHeight` is the gate that proves it
///    (see `TerminalAudit.measureHeights`).
///
/// 3. **Nothing here decides anything.** Where a line breaks, what it says, what
///    a tap on it does — all of that is already in the plan. This puts it on
///    screen at the cell it was measured against.
final class TerminalRowCell: UICollectionViewCell {
  private let backdrop = BackdropView()
  private let gutter = GutterView()
  private let body = BodyTextView()
  /// One per planned image box, laid over the blank lines the planner reserved
  /// for it. A fourth view kind, and the only thing in this cell that is not
  /// drawn: a picture is a picture, and `UIImageView` scales one correctly for
  /// free. There are at most a handful per row, so the per-line view count this
  /// rewrite exists to shed is untouched.
  private var imageBoxes: [ImageBoxView] = []
  private var imageTasks: [Task<Void, Never>] = []
  private weak var imageLoader: TerminalImageLoader?
  private var press: ((TermPress) -> Void)?
  /// How much text was selected when the finger went down — see `handleTap`.
  private var selectionAtTouchDown = 0
  private var lines: [TermLine] = []
  private var geometry = TerminalRowGeometry(
    metrics: TerminalMetrics(cell: 8, line: 18, width: 0, fontSize: 13), bleed: 0)
  /// The blank line above the row, when the spacing rule asks for one. The
  /// theme's only spacing: a blank *line*, never padding, so a row's height
  /// stays an integer number of lines.
  private var topInset: CGFloat = 0
  private var pulseTimer: Timer?

  /// Whether the body's text run can be selected. Off for a *copy* of a row —
  /// the sticky prompt — where a selection would land somewhere the reader
  /// cannot see and would swallow the tap that takes them to the real one.
  var bodyIsSelectable: Bool {
    get { body.isSelectable }
    set { body.isSelectable = newValue }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(backdrop)
    contentView.addSubview(body)
    // Above the text run: the gutter is drawn *over* nothing, but keeping it
    // last means a stray body glyph can never paint on top of a marker.
    contentView.addSubview(gutter)
    contentView.backgroundColor = .clear
    backgroundColor = .clear

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
    // The text view's own recognizers own the long press (that is the
    // selection); a plain tap falls through to this one.
    tap.cancelsTouchesInView = false
    // …but only if it is allowed to run *beside* them. A selectable
    // `UITextView` installs its own single-tap recognizer, and UIKit resolves a
    // conflict in the inner view's favour, so the first tap on a row was spent
    // making the text view first responder and every block needed pressing
    // twice to open. Simultaneous recognition is the fix; the selection guard
    // below is what keeps it honest.
    tap.delegate = self
    contentView.addGestureRecognizer(tap)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  // MARK: - Configure

  func configure(
    lines: [TermLine], typography: TerminalTypography, metrics: TerminalMetrics,
    gapAbove: Bool, bleed: CGFloat, imageLoader: TerminalImageLoader? = nil,
    onPress: @escaping (TermPress) -> Void
  ) {
    self.lines = lines
    self.geometry = TerminalRowGeometry(metrics: metrics, bleed: bleed)
    self.topInset = gapAbove ? metrics.line : 0
    self.press = onPress
    self.imageLoader = imageLoader

    body.attributedText = TerminalTextRun.make(
      lines: lines, typography: typography, geometry: geometry)
    gutter.set(lines: lines, typography: typography, geometry: geometry)
    backdrop.set(lines: lines, geometry: geometry)
    rebuildImageBoxes(typography: typography)
    setNeedsLayout()

    syncPulse()
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    stopPulse()
    cancelImageLoads()
    press = nil
    lines = []
    imageLoader = nil
    imageBoxes.forEach { $0.removeFromSuperview() }
    imageBoxes = []
  }

  // MARK: - Images

  /// A box per planned image, in whatever state the loader already knows.
  ///
  /// Rebuilt on configure rather than reused across rows: a recycled cell draws
  /// a different call's pictures, and a box that kept the old image for a frame
  /// would put someone else's screenshot under this row's header.
  private func rebuildImageBoxes(typography: TerminalTypography) {
    imageBoxes.forEach { $0.removeFromSuperview() }
    imageBoxes = lines.enumerated().compactMap { index, line in
      guard let box = line.image else { return nil }
      let view = ImageBoxView(
        box: box, lineIndex: index, typography: typography, lineHeight: geometry.metrics.line)
      view.render(imageLoader?.state(for: box) ?? .placeholder)
      contentView.insertSubview(view, aboveSubview: body)
      return view
    }
  }

  /// Fire the fetches for whatever this row is showing — called from
  /// `willDisplay`, which is the collection view answering "is this on screen"
  /// so nothing here has to.
  func beginImageLoads() {
    guard let imageLoader, imageTasks.isEmpty else { return }
    imageTasks = imageBoxes.compactMap { view in
      imageLoader.load(view.box) { [weak view] state in view?.render(state) }
    }
  }

  /// Called from `didEndDisplaying`. Cancelling a scrolled-past fetch is the
  /// whole reason a fast scrub through an image session does not pull fifty
  /// screenshots nobody read; the ones that already landed stay in the loader's
  /// cache, so a scroll back is free.
  func cancelImageLoads() {
    imageTasks.forEach { $0.cancel() }
    imageTasks = []
  }

  /// Off the window is off the clock, and it is what stops a recycled-away cell
  /// leaving a timer running against the runloop for the rest of the session —
  /// `prepareForReuse` covers the recycling case and nothing covers this one.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    syncPulse()
  }

  /// Only a row that is actually working pays for a timer, and it is one timer
  /// for the whole row however many of its lines pulse.
  private func syncPulse() {
    let wanted =
      window != nil && !UIAccessibility.isReduceMotionEnabled
      && lines.contains(where: \.pulsing)
    guard wanted else { return stopPulse() }
    guard pulseTimer == nil else { return }
    pulseTimer = Timer.scheduledTimer(
      withTimeInterval: TermGlyph.pulseInterval, repeats: true
    ) { [weak self] _ in
      self?.gutter.setNeedsDisplay()
    }
  }

  private func stopPulse() {
    pulseTimer?.invalidate()
    pulseTimer = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let frame = CGRect(
      x: 0, y: topInset, width: bounds.width, height: max(0, bounds.height - topInset))
    backdrop.frame = frame
    gutter.frame = frame
    body.frame = frame
    for view in imageBoxes {
      // Exactly the lines the planner reserved: the body column at the left,
      // one cell of bleed at the right, and `box.lines` whole lines tall. Every
      // number here is the plan's, which is what makes the placeholder, the
      // picture and the failure notice identical in size.
      let line = lines[view.lineIndex]
      let x = geometry.bodyX(line)
      view.frame = CGRect(
        x: x, y: topInset + CGFloat(view.lineIndex) * geometry.metrics.line,
        width: max(0, bounds.width - x - geometry.bleed),
        height: CGFloat(view.box.lines) * geometry.metrics.line)
    }
  }

  /// What the text system says this row's body actually occupies. The claim the
  /// audit checks against `lines.count × metrics.line` — see rule 2 above.
  var measuredHeight: CGFloat {
    body.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
  }

  // MARK: - Press

  @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
    // A selection standing in this row means the tap is a dismissal of it, not
    // a press: collapsing the block out from under a selection would take the
    // selection with it. Read at **touch down** as well as now, because running
    // beside the text view's own recognizer means the selection it is clearing
    // may already be gone by the time this fires.
    guard selectionAtTouchDown == 0, body.selectedRange.length == 0 else { return }
    guard !lines.isEmpty else { return }
    let point = recognizer.location(in: contentView)
    // Clamped rather than bounds-checked, which is the row's whole hit-target
    // story: a one-line block is `metrics.line` tall — around 19pt, well under
    // anyone's thumb — and the blank line `gapAbove` puts above it is dead
    // space belonging to no one. Clamping hands that space to the row it
    // separates from the block above, roughly doubling the target for exactly
    // the rows that are hardest to hit, and costs nothing anywhere else: an
    // overshoot at the bottom edge lands on the last line, which is where it
    // visually was.
    let raw = Int(((point.y - topInset) / geometry.metrics.line).rounded(.down))
    let index = min(max(raw, 0), lines.count - 1)
    guard let press = lines[index].press else { return }
    self.press?(press)
  }
}

extension TerminalRowCell: UIGestureRecognizerDelegate {
  /// Snapshot the selection before the text view can act on this touch.
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch
  ) -> Bool {
    selectionAtTouchDown = body.selectedRange.length
    return true
  }

  /// Beside the text view's recognizers, never instead of them: selection
  /// within a row still works, and a plain tap now reaches the row on the first
  /// press rather than the second.
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool { true }
}

// MARK: - Geometry

/// Where a planned line's columns land, in points. One spelling, because the
/// backdrop, the gutter and the text run must agree to the point — three
/// arithmetics would be three answers and the misalignment would be a fraction
/// of a cell, which reads as the font being wrong rather than as a bug.
struct TerminalRowGeometry {
  var metrics: TerminalMetrics
  /// One cell of air at each edge, so the gutter marker is not flush against
  /// the screen. Spent *inside* the band, which therefore still runs full width
  /// — a wash that stopped short of the edge would read as a box, which is the
  /// thing this theme exists not to have.
  var bleed: CGFloat

  /// The nested rule's own column, drawn inside the padding so a subagent's
  /// indent stays exactly two cells.
  func nestedOffset(_ line: TermLine) -> CGFloat {
    line.nested ? TerminalPlanner.nestedIndentCells * metrics.cell : 0
  }

  func gutterX(_ line: TermLine) -> CGFloat {
    bleed + nestedOffset(line) + CGFloat(line.indent) * metrics.cell
  }

  func bodyX(_ line: TermLine) -> CGFloat {
    gutterX(line) + CGFloat(line.columns) * metrics.cell
  }

  func lineRect(_ index: Int, width: CGFloat) -> CGRect {
    CGRect(x: 0, y: CGFloat(index) * metrics.line, width: width, height: metrics.line)
  }
}

// MARK: - The text run

/// The planner's lines as one attributed string — the piece that makes the body
/// selectable without giving up the grid.
enum TerminalTextRun {
  /// The paragraph style a planned line is drawn under.
  ///
  /// Every field here is load-bearing, and getting any of them wrong puts every
  /// row a fraction off with nothing visibly wrong:
  ///
  /// - `minimum`/`maximumLineHeight` pinned to the grid line is what makes N
  ///   paragraphs N × `line` tall regardless of the face's own metrics.
  /// - `firstLineHeadIndent == headIndent` is the hanging indent: the body
  ///   cannot flow back under the gutter, wrapped or not.
  /// - `.byClipping` because the text is **pre-wrapped**. Re-wrapping here
  ///   could only disagree with the height that was measured, and truncation
  ///   would put an ellipsis in a transcript that never elides.
  static func paragraphStyle(for line: TermLine, geometry: TerminalRowGeometry)
    -> NSParagraphStyle
  {
    let style = NSMutableParagraphStyle()
    style.minimumLineHeight = geometry.metrics.line
    style.maximumLineHeight = geometry.metrics.line
    style.lineSpacing = 0
    style.paragraphSpacing = 0
    style.paragraphSpacingBefore = 0
    style.lineBreakMode = .byClipping
    let indent = geometry.bodyX(line)
    style.firstLineHeadIndent = indent
    style.headIndent = indent
    return style
  }

  static func make(
    lines: [TermLine], typography: TerminalTypography, geometry: TerminalRowGeometry
  ) -> NSAttributedString {
    let run = NSMutableAttributedString()
    for (index, line) in lines.enumerated() {
      // The newline carries the paragraph it *ends*, so a line's style covers
      // its whole paragraph including the break.
      let text = index == lines.count - 1 ? line.text : line.text + "\n"
      let piece: NSMutableAttributedString
      if let attributed = line.attributed {
        piece = NSMutableAttributedString(attributedString: NSAttributedString(attributed))
        if index < lines.count - 1 { piece.append(NSAttributedString(string: "\n")) }
      } else {
        piece = NSMutableAttributedString(string: text)
      }
      let whole = NSRange(location: 0, length: piece.length)
      // Applied over the top of whatever the inline markdown produced: the
      // *traits* it carries (bold, italic, code) are honoured below by reading
      // them back off the existing font, but the face and the grid are ours.
      piece.enumerateAttribute(.font, in: whole) { value, range, _ in
        let inline = value as? UIFont
        piece.addAttribute(
          .font,
          value: typography.uiFont(
            bold: line.bold || inline?.isBold == true,
            italic: line.italic || inline?.isItalic == true),
          range: range)
      }
      piece.addAttributes(
        [
          .foregroundColor: TerminalPalette.uiColor(line.tone),
          .paragraphStyle: paragraphStyle(for: line, geometry: geometry),
        ], range: whole)
      run.append(piece)
    }
    return run
  }
}

extension TerminalTypography {
  /// The measured face in the weight and slant a line asked for.
  ///
  /// Metric-compatible by construction: the system monospace face advances the
  /// same for regular, bold and italic, which is what lets the planner count
  /// cells without knowing a row's weight.
  func uiFont(bold: Bool, italic: Bool) -> UIFont {
    var font = bold ? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .semibold) : uiFont
    if italic, let descriptor = font.fontDescriptor.withSymbolicTraits(.traitItalic) {
      font = UIFont(descriptor: descriptor, size: fontSize)
    }
    return font
  }
}

extension UIFont {
  fileprivate var isBold: Bool { fontDescriptor.symbolicTraits.contains(.traitBold) }
  fileprivate var isItalic: Bool { fontDescriptor.symbolicTraits.contains(.traitItalic) }
}

// MARK: - The three views

extension TerminalRowCell {
  /// The bands, the open wash and the nested rule — everything behind the text.
  ///
  /// Drawn rather than stacked as subviews because there is one of each *per
  /// line*, and an expanded result is fifty lines: fifty background views per
  /// row is exactly the per-cell view count this rewrite exists to shed.
  final class BackdropView: UIView {
    private var lines: [TermLine] = []
    private var geometry: TerminalRowGeometry?

    override init(frame: CGRect) {
      super.init(frame: frame)
      isOpaque = false
      backgroundColor = .clear
      isUserInteractionEnabled = false
      contentMode = .redraw
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func set(lines: [TermLine], geometry: TerminalRowGeometry) {
      self.lines = lines
      self.geometry = geometry
      setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
      guard let geometry, let context = UIGraphicsGetCurrentContext() else { return }
      for (index, line) in lines.enumerated() {
        let box = geometry.lineRect(index, width: bounds.width)
        guard box.intersects(rect) else { continue }
        // Full-bleed, both of them: the band runs edge to edge behind the
        // padding, and an open block's wash marks where it began even when its
        // header has scrolled off the top.
        if line.band != .none {
          context.setFillColor(TerminalPalette.uiBand(line.band).cgColor)
          context.fill(box)
        }
        if line.inOpen {
          context.setFillColor(TerminalPalette.uiOpenWash.cgColor)
          context.fill(box)
        }
        // What a press would do something to. Only the lines that carry one
        // *and* wear nothing else: a tool call's preview rows are pressable
        // too, but they already sit in the output band, and a second wash on
        // top would say "these are two targets" when the block is one. So it
        // marks the summary lines — the folded run, the task, the tool header —
        // which are precisely the one-line rows that are hardest to find and to
        // hit. There is no hover on a phone, so this is the only affordance
        // there can be.
        if line.band == .none && !line.inOpen && line.press != nil {
          context.setFillColor(TerminalPalette.uiPressable.cgColor)
          context.fill(box)
        }
        if line.nested {
          context.setFillColor(TerminalPalette.uiNestedRule.cgColor)
          context.fill(CGRect(x: geometry.bleed, y: box.minY, width: 1, height: box.height))
        }
      }
    }
  }

  /// The gutter column: markers, drawn, never selectable.
  ///
  /// Drawn under the same paragraph style as the body, which is the whole
  /// reason the two sit on one baseline — a marker positioned by its own
  /// arithmetic would drift against the text beside it as the face changed.
  final class GutterView: UIView {
    private var lines: [TermLine] = []
    private var geometry: TerminalRowGeometry?
    private var typography: TerminalTypography?

    override init(frame: CGRect) {
      super.init(frame: frame)
      isOpaque = false
      backgroundColor = .clear
      isUserInteractionEnabled = false
      contentMode = .redraw
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func set(lines: [TermLine], typography: TerminalTypography, geometry: TerminalRowGeometry) {
      self.lines = lines
      self.typography = typography
      self.geometry = geometry
      setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
      guard let geometry, let typography else { return }
      let style = NSMutableParagraphStyle()
      style.minimumLineHeight = geometry.metrics.line
      style.maximumLineHeight = geometry.metrics.line
      style.lineBreakMode = .byClipping
      for (index, line) in lines.enumerated() {
        let box = geometry.lineRect(index, width: bounds.width)
        guard box.intersects(rect) else { continue }
        let glyph = line.pulsing ? Self.pulseFrame() : line.gutter
        guard !glyph.isEmpty else { continue }
        let tone = line.pulsing ? TermTone.mark : line.gutterTone
        (glyph as NSString).draw(
          in: CGRect(
            x: geometry.gutterX(line), y: box.minY,
            width: CGFloat(line.columns) * geometry.metrics.cell, height: box.height),
          withAttributes: [
            .font: typography.uiFont,
            .foregroundColor: TerminalPalette.uiColor(tone),
            .paragraphStyle: style,
          ])
      }
    }

    /// The working marker: the brand mark's own pulse, `⋄ ◇ ◈ ◆` at 150ms — one
    /// cycle is 0.6s, the clock in `icon-loading.svg`, so the transcript's
    /// working row and the brand mark beat together. It rests on `◆` under
    /// Reduce Motion, which is free: the last frame *is* the mark.
    ///
    /// Read off the wall clock rather than counted, so every pulsing row in the
    /// transcript is on the same frame however long ago each was mounted.
    static func pulseFrame() -> String {
      guard !UIAccessibility.isReduceMotionEnabled else { return TermGlyph.pulseRest }
      let step = Int(Date.timeIntervalSinceReferenceDate / TermGlyph.pulseInterval)
      return TermGlyph.pulseFrames[step % TermGlyph.pulseFrames.count]
    }
  }

  /// One image's box: a dim wash, the placeholder words, and the picture over
  /// them once it lands.
  ///
  /// **Its height never changes.** The frame is `box.lines × line` in all three
  /// states, set by the cell from the plan, so nothing here can reflow the
  /// transcript — which is the whole reason images are drawn in a fixed box
  /// rather than at their intrinsic size. `.scaleAspectFit` is what that costs:
  /// a wide screenshot letterboxes.
  ///
  /// Pointer-transparent throughout, so a tap on the picture is a tap on the
  /// block — the theme's rule that every line a block drew is one target, and
  /// the image is not an exception to it.
  final class ImageBoxView: UIView {
    let box: TermImageBox
    /// Which planned line this box starts on — the cell's own arithmetic reads
    /// it back to place the frame.
    let lineIndex: Int
    private let label = UILabel()
    private let picture = UIImageView()

    private let lineHeight: CGFloat

    init(
      box: TermImageBox, lineIndex: Int, typography: TerminalTypography, lineHeight: CGFloat
    ) {
      self.box = box
      self.lineIndex = lineIndex
      self.lineHeight = lineHeight
      super.init(frame: .zero)
      isUserInteractionEnabled = false
      backgroundColor = TerminalPalette.uiBand(.output)
      clipsToBounds = true

      label.font = typography.uiFont
      label.textColor = TerminalPalette.uiColor(.faint)
      label.numberOfLines = 1
      addSubview(label)

      picture.contentMode = .scaleAspectFit
      picture.isHidden = true
      addSubview(picture)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func render(_ state: TerminalImageState) {
      switch state {
      case .placeholder:
        label.text = TermImage.placeholder(bytes: box.bytes)
        picture.image = nil
        picture.isHidden = true
      case .loaded(let image):
        // Cleared, not merely covered: `.scaleAspectFit` letterboxes, so words
        // left behind the picture would show beside it rather than under it.
        label.text = nil
        picture.image = image
        picture.isHidden = false
      case .failed:
        label.text = TermImage.unavailable
        picture.image = nil
        picture.isHidden = true
      }
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      // The words sit on the box's **first line**, not centred in it: this is a
      // grid, and a string floating at the box's midpoint would be the one
      // piece of text in the transcript that is not on a line.
      label.frame = CGRect(x: 0, y: 0, width: bounds.width, height: lineHeight)
      picture.frame = bounds
    }
  }

  /// The body: one text run, selectable, laid out by the paragraph styles above.
  final class BodyTextView: UITextView {
    override init(frame: CGRect, textContainer: NSTextContainer?) {
      super.init(frame: frame, textContainer: textContainer)
      isEditable = false
      isSelectable = true
      // The collection view does the scrolling. A text view that scrolled
      // itself would be a second scroll view inside every row.
      isScrollEnabled = false
      backgroundColor = .clear
      // The four settings the height claim rests on. Any inset or padding here
      // is a fraction added to every row, and nothing about a row that is 2pt
      // too tall looks wrong.
      textContainerInset = .zero
      self.textContainer.lineFragmentPadding = 0
      self.textContainer.maximumNumberOfLines = 0
      self.textContainer.lineBreakMode = .byClipping
      adjustsFontForContentSizeCategory = false
      // A transcript is full of paths and URLs the *engine* wrote; turning them
      // into tappable links would put a second meaning on a tap that already
      // expands the block.
      dataDetectorTypes = []
      isFindInteractionEnabled = false
      clipsToBounds = true
      contentInsetAdjustmentBehavior = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Everything the system offers on a selection except what would edit it —
    /// this run is a rendering of somebody's session, not a document.
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
      action == #selector(copy(_:)) || action == #selector(selectAll(_:))
    }
  }
}
