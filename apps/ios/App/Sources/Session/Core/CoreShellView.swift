import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// Android's ShellScreen: the core owns the emulator and the scroll position, this screen draws the window it hands back
// and turns touches into keys, text and line scrolls.
struct CoreShellScreen: View {
  let model: CoreSessionModel
  let shellId: String

  @State private var keyboardFocused = false
  @State private var controlArmed = false
  @State private var confirmKill = false
  @State private var opened = false
  private let typography = TerminalTypography.session

  private var grid: ShellGrid? { model.ui.shell?.id == shellId ? model.ui.shell?.grid : nil }

  var body: some View {
    CoreShellCanvas(
      grid: grid, typography: typography,
      onMeasure: { cols, rows in
        if opened {
          model.resizeShell(shellId, cols: cols, rows: rows)
        } else {
          opened = true
          model.openShell(shellId, cols: cols, rows: rows)
        }
      },
      onScroll: model.scrollShell,
      onTap: { if grid?.canType == true { keyboardFocused = true } }
    )
    .background(Color(uiColor: .systemBackground))
    .overlay(alignment: .topLeading) {
      ShellKeyboard(focused: $keyboardFocused, onKey: { send($0) }, onText: type)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
    }
    .safeAreaInset(edge: .top, spacing: 0) { statusStrip }
    .safeAreaInset(edge: .bottom, spacing: 0) { controlStrip }
    .navigationTitle(grid?.title ?? "Shell")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if grid?.running == true {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Kill", systemImage: "stop.circle") { confirmKill = true }
            .tint(TerminalPalette.color(.red))
        }
      }
    }
    .confirmationDialog("Kill this shell?", isPresented: $confirmKill, titleVisibility: .visible) {
      Button("Kill", role: .destructive) { model.killShell(shellId) }
    } message: {
      Text("The process and everything it started are stopped. The output stays readable.")
    }
  }

  private var statusStrip: some View {
    HStack(spacing: 0) {
      Text(TerminalShell.glyph)
        .frame(width: typography.cell * 2, alignment: .leading)
      Text(grid?.statusText ?? "connecting…")
        .lineLimit(1)
        .accessibilityIdentifier("shell-status")
      Spacer(minLength: 0)
      if let grid, grid.canType {
        Text("\(grid.cols)x\(grid.rows)")
          .monospacedDigit()
          .foregroundStyle(TerminalPalette.color(.faint))
      }
    }
    .font(typography.font)
    .foregroundStyle(grid?.running == true ? TerminalPalette.color(.magenta) : TerminalPalette.color(.dim))
    .padding(.horizontal, typography.cell)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .systemBackground))
    .overlay(alignment: .bottom) { Divider() }
  }

  @ViewBuilder private var controlStrip: some View {
    if grid?.canType == true {
      HStack(spacing: 4) {
        key("esc") { send(.escape) }
        key("tab") { send(.tab) }
        key("ctrl", active: controlArmed) { controlArmed.toggle() }
        key("^C") {
          controlArmed = false
          send(.control("c"))
        }
        Spacer(minLength: 0)
        key("↑") { send(.up) }
        key("↓") { send(.down) }
        key("←") { send(.left) }
        key("→") { send(.right) }
        Button {
          keyboardFocused.toggle()
        } label: {
          Image(systemName: keyboardFocused ? "keyboard.chevron.compact.down" : "keyboard")
            .font(.footnote)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .frame(minHeight: 30)
        .accessibilityLabel(keyboardFocused ? "Hide keyboard" : "Show keyboard")
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(.bar)
      .overlay(alignment: .top) { Divider() }
    }
  }

  private func key(_ label: String, active: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label)
        .font(.footnote.monospaced())
        .padding(.horizontal, 8)
        .frame(minWidth: 34, minHeight: 30)
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(active ? TerminalPalette.color(.magenta).opacity(0.3) : Color(uiColor: .secondarySystemFill)))
    }
    .buttonStyle(.plain)
    .foregroundStyle(active ? TerminalPalette.color(.magenta) : Color.primary)
  }

  private func send(_ key: VTKey) {
    model.shellKey(shellId, key.core)
  }

  // The `ctrl` latch takes one character; more than one is a paste, so it never turns into a signal.
  private func type(_ text: String) {
    if controlArmed, text.count == 1, let first = text.first {
      controlArmed = false
      send(.control(first))
    } else if text == "\n" {
      send(.enter)
    } else if text.count > 1 {
      model.shellPaste(shellId, text)
    } else {
      model.shellText(shellId, text)
    }
  }
}

extension VTKey {
  fileprivate var core: Key {
    switch self {
    case .char(let character): .char(text: String(character))
    case .enter: .enter
    case .tab: .tab
    case .backspace: .backspace
    case .escape: .escape
    case .up: .up
    case .down: .down
    case .left: .left
    case .right: .right
    case .home: .home
    case .end: .end
    case .pageUp: .pageUp
    case .pageDown: .pageDown
    case .delete: .delete
    case .function(let n): .function(n: UInt8(clamping: n))
    case .control(let character): .control(text: String(character))
    }
  }
}

private struct CoreShellCanvas: UIViewRepresentable {
  let grid: ShellGrid?
  let typography: TerminalTypography
  let onMeasure: (Int, Int) -> Void
  let onScroll: (Int) -> Void
  let onTap: () -> Void

  func makeUIView(context: Context) -> CoreShellCanvasView { CoreShellCanvasView() }

  func updateUIView(_ view: CoreShellCanvasView, context: Context) {
    view.typography = typography
    view.onMeasure = onMeasure
    view.onScroll = onScroll
    view.onTap = onTap
    if view.grid != grid {
      view.grid = grid
      view.setNeedsDisplay()
    }
  }
}

// The window is screen-tall, so the canvas never scrolls itself: a vertical drag is counted in lines and the core moves
// the window, the way the Android canvas does it.
final class CoreShellCanvasView: UIView {
  var grid: ShellGrid?
  var typography: TerminalTypography? { didSet { if oldValue == nil { setNeedsLayout() } } }
  var onMeasure: ((Int, Int) -> Void)?
  var onScroll: ((Int) -> Void)?
  var onTap: (() -> Void)?
  private var measured: (cols: Int, rows: Int)?
  private var drag: CGFloat = 0
  static let padding: CGFloat = 8

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isAccessibilityElement = true
    accessibilityIdentifier = "shell-screen"
    accessibilityLabel = "Shell output"
    addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap)))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  override var accessibilityValue: String? {
    get { grid?.lines.map { $0.map(\.text).joined() }.joined(separator: "\n") }
    set {}
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let typography, bounds.width > 0, bounds.height > 0 else { return }
    let cols = max(Int(floor((bounds.width - Self.padding * 2) / typography.cell)), 20)
    let rows = max(Int(floor(bounds.height / typography.line)), 4)
    guard measured?.cols != cols || measured?.rows != rows else { return }
    measured = (cols, rows)
    onMeasure?(cols, rows)
  }

  @objc private func tap() { onTap?() }

  @objc private func pan(_ recognizer: UIPanGestureRecognizer) {
    guard let line = typography?.line, line > 0 else { return }
    switch recognizer.state {
    case .changed:
      drag += recognizer.translation(in: self).y
      recognizer.setTranslation(.zero, in: self)
      let lines = Int(drag / line)
      guard lines != 0 else { return }
      drag -= CGFloat(lines) * line
      onScroll?(lines)
    default:
      drag = 0
    }
  }

  override func draw(_ rect: CGRect) {
    guard let grid, let typography else { return }
    let line = typography.line
    let cell = typography.cell
    for (index, runs) in grid.lines.enumerated() {
      let y = CGFloat(index) * line
      guard y + line <= bounds.height else { break }
      var column = 0
      for run in runs {
        let x = Self.padding + CGFloat(column) * cell
        guard column < grid.cols, x + cell <= bounds.width else { break }
        let box = CGRect(x: x, y: y, width: CGFloat(run.columns) * cell, height: line)
        let (fg, bg) = Self.colors(run)
        if let bg {
          bg.setFill()
          UIRectFill(box)
        }
        if !run.hidden, !run.text.allSatisfy(\.isWhitespace) {
          draw(run, at: box, color: fg, typography: typography)
        }
        column += run.columns
      }
    }
    let cursorLine = grid.totalLines - grid.rows + grid.cursorRow - grid.startLine
    if grid.cursorVisible, grid.lines.indices.contains(cursorLine) {
      ShellPalette.cursor.withAlphaComponent(0.55).setFill()
      UIRectFill(
        CGRect(x: Self.padding + CGFloat(grid.cursorCol) * cell, y: CGFloat(cursorLine) * line, width: cell, height: line))
    }
  }

  // Colour words from the core: 0 the slot's default, FOREGROUND / BACKGROUND the theme's, RGB a literal colour.
  private static func colors(_ run: ShellRun) -> (UIColor, UIColor?) {
    func word(_ value: UInt32) -> UIColor? {
      switch value & 0xFF00_0000 {
      case ShellRun.foreground: return ShellPalette.foreground
      case ShellRun.background: return ShellPalette.resolvedBackground
      case ShellRun.rgb:
        return UIColor(
          red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
          blue: CGFloat(value & 0xFF) / 255, alpha: 1)
      default: return nil
      }
    }
    let fg = word(run.fg) ?? ShellPalette.foreground
    return (run.dim ? fg.withAlphaComponent(0.6) : fg, word(run.bg))
  }

  private func draw(_ run: ShellRun, at box: CGRect, color: UIColor, typography: TerminalTypography) {
    var font = typography.uiFont
    if run.bold || run.italic {
      var traits: UIFontDescriptor.SymbolicTraits = []
      if run.bold { traits.insert(.traitBold) }
      if run.italic { traits.insert(.traitItalic) }
      if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)) {
        font = UIFont(descriptor: descriptor, size: typography.fontSize)
      }
    }
    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    if run.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
    if run.strikethrough { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    NSAttributedString(string: run.text, attributes: attributes)
      .draw(at: CGPoint(x: box.minX, y: box.minY + (box.height - font.lineHeight) / 2))
  }
}
