import Foundation

/// A VT/xterm emulator small enough to carry in the app: the grid a shell
/// session's PTY output draws on, fed the same decoded string the gateway
/// streams to xterm.js in the browser.
///
/// The one property everything else leans on: the parser is a state machine
/// whose state **outlives a `feed`**. Frames split escape sequences wherever
/// the socket felt like it, so `"\u{1b}["` then `"3"` then `"1m"` must land
/// exactly as `"\u{1b}[31m"` would. Nothing is buffered and re-parsed; every
/// scalar is consumed once, in O(1), against whatever state the last one left.
///
/// Scope is "real programs on a phone-sized pane look right", not vttest: no
/// left/right margins, no reflow on resize, no mouse (the modes are recorded
/// for the view), no DCS replies. Unknown sequences are consumed and dropped,
/// never printed.
@MainActor
public final class VTScreen {
  public private(set) var cols: Int
  public private(set) var rows: Int
  public let scrollbackLimit: Int
  /// Bumped once per `feed` that changed anything a view would draw, and on
  /// every `resize` and `reset`. A SwiftUI view observes this instead of
  /// diffing the grid.
  public private(set) var revision = 0
  public private(set) var cursorVisible = true
  /// True while the alternate screen is active (a full-screen TUI). A view uses
  /// this to hide the scrollback and pin to the live screen; the scrollback
  /// itself is untouched underneath and counts as before.
  public private(set) var altScreenActive = false
  /// The last OSC 0/2 title, if any.
  public private(set) var title: String?
  /// Count of BELs seen. A view can haptic-tap on a change and ignore the value.
  public private(set) var bellCount = 0
  /// DECCKM (mode 1): arrows send `ESC O A` rather than `ESC [ A`. ``encode(_:)``
  /// already honours it; it is public for a view that wants to show the mode.
  public private(set) var applicationCursorKeys = false
  /// Mode 2004. ``encodePaste(_:)`` honours it.
  public private(set) var bracketedPaste = false
  public private(set) var mouseTracking = VTMouseTracking.none
  /// Mode 1006: mouse reports in the SGR encoding, should a view ever send one.
  public private(set) var sgrMouse = false
  /// Mode 1004: the program wants `ESC [ I` / `ESC [ O` on focus changes.
  public private(set) var focusReporting = false

  /// Scrollback plus the live screen, oldest first. `count == scrollbackCount + rows`.
  public var totalRows: Int { scrollback.count + rows }
  public var scrollbackCount: Int { scrollback.count }
  /// Cursor in screen coordinates: `row` is 0 ..< rows, relative to the live
  /// screen, so a view adds `scrollbackCount` to place it.
  public var cursorCol: Int { buffer.cursorCol }
  public var cursorRow: Int { buffer.cursorRow }

  var buffer: VTBuffer
  var inactive: VTBuffer?
  var scrollback: VTLineRing
  var style = VTStyle.default
  var originMode = false
  var autowrap = true
  var insertMode = false
  var newlineMode = false
  var tabStops: [Bool]
  var g0Graphics = false
  var g1Graphics = false
  var shiftedOut = false
  var lastPrinted: (text: Character, width: Int)?
  var responses = ""
  var dirty = false

  var state = VTParserState.ground
  var params: [Int] = []
  var subparams: [Bool] = []
  var param = 0
  var paramIsSub = false
  var sawParam = false
  var intermediate: UInt32 = 0
  var intermediateCount = 0
  var privateMarker: UInt32 = 0
  var csiIgnore = false
  var oscText = ""

  static let maxParams = 32
  static let maxParamValue = 65535
  static let maxOscLength = 4096
  static let maxResponseLength = 4096
  static let maxRepeat = 4096

  public init(cols: Int, rows: Int, scrollbackLimit: Int = 1000) {
    let cols = max(1, cols)
    let rows = max(1, rows)
    self.cols = cols
    self.rows = rows
    self.scrollbackLimit = max(0, scrollbackLimit)
    buffer = VTBuffer(cols: cols, rows: rows, fill: .blank)
    scrollback = VTLineRing(capacity: self.scrollbackLimit)
    tabStops = VTScreen.defaultTabStops(cols)
    params.reserveCapacity(VTScreen.maxParams)
    subparams.reserveCapacity(VTScreen.maxParams)
  }

  /// 0 ..< totalRows. Returns a blank line rather than trapping out of range.
  /// Live lines are exactly `cols` wide; a scrollback line is padded up to
  /// `cols` but never cut, so one emitted before a narrower resize keeps its
  /// width (no reflow, see ``resize(cols:rows:)``) and the view clips it.
  public func line(at index: Int) -> VTLine {
    let kept = scrollback.count
    if index < 0 || index >= kept + rows {
      return VTLine(cells: Array(repeating: .blank, count: cols))
    }
    if index < kept {
      var cells = scrollback[index]
      if cells.count < cols {
        cells.append(contentsOf: repeatElement(.blank, count: cols - cells.count))
      }
      return VTLine(cells: cells)
    }
    return VTLine(cells: buffer.grid[index - kept])
  }

  public func feed(_ text: String) {
    for scalar in text.unicodeScalars {
      step(scalar)
    }
    if dirty {
      dirty = false
      revision += 1
    }
  }

  /// Bytes the program asked the terminal to report (DSR, DA). The caller drains
  /// this and writes it to the PTY as input. Empty is the common case.
  public func takeResponses() -> String {
    defer { responses = "" }
    return responses
  }

  /// Reflow is not attempted: a live line is cut or padded, and a scrollback
  /// line is left exactly as it was emitted, which is what xterm does for
  /// already-emitted scrollback too. Rows follow xterm.js: shrinking drops
  /// lines below the cursor first and only then pushes the top into
  /// scrollback; growing pulls lines back out of scrollback while the cursor
  /// sits on the last row. Margins reset to the full screen.
  public func resize(cols newCols: Int, rows newRows: Int) {
    let newCols = max(1, newCols)
    let newRows = max(1, newRows)
    guard newCols != cols || newRows != rows else { return }
    var active = buffer
    buffer = VTBuffer(cols: 1, rows: 1, fill: .blank)
    resizeBuffer(&active, cols: newCols, rows: newRows, usesScrollback: !altScreenActive)
    buffer = active
    if var main = inactive {
      inactive = nil
      resizeBuffer(&main, cols: newCols, rows: newRows, usesScrollback: true)
      inactive = main
    }
    var stops = VTScreen.defaultTabStops(newCols)
    for column in 0..<min(cols, newCols) {
      stops[column] = tabStops[column]
    }
    tabStops = stops
    cols = newCols
    rows = newRows
    revision += 1
  }

  /// Everything back to power-on, scrollback and title included. RIS (`ESC c`)
  /// is the same operation.
  public func reset() {
    buffer = VTBuffer(cols: cols, rows: rows, fill: .blank)
    inactive = nil
    altScreenActive = false
    scrollback.removeAll()
    title = nil
    responses = ""
    lastPrinted = nil
    softReset()
    state = .ground
    dirty = false
    revision += 1
  }

  static func defaultTabStops(_ cols: Int) -> [Bool] {
    (0..<cols).map { $0 > 0 && $0 % 8 == 0 }
  }
}

// MARK: - The parser

enum VTParserState {
  case ground, escape, escapeIntermediate, csi, osc
  /// DCS, SOS, PM and APC alike: consumed to the string terminator, never
  /// interpreted.
  case string
}

extension VTScreen {
  func step(_ scalar: Unicode.Scalar) {
    let value = scalar.value
    switch state {
    case .ground:
      if value >= 0x20 && value < 0x7F {
        printScalar(scalar)
      } else if value >= 0xA0 {
        printScalar(scalar)
      } else if value < 0x20 {
        if value == 0x1B { enterEscape() } else { execute(value) }
      } else if value >= 0x80 {
        controlC1(value)
      }

    case .escape:
      switch value {
      case 0x18, 0x1A: state = .ground
      case 0x1B: enterEscape()
      case 0x00..<0x20: execute(value)
      case 0x20..<0x30:
        intermediate = value
        intermediateCount = 1
        state = .escapeIntermediate
      case 0x50: enterString()
      case 0x58, 0x5E, 0x5F: enterString()
      case 0x5B: enterCSI()
      case 0x5D: enterOSC()
      case 0x30..<0x7F:
        state = .ground
        escapeDispatch(value)
      case 0x7F: break
      default: state = .ground
      }

    case .escapeIntermediate:
      switch value {
      case 0x18, 0x1A: state = .ground
      case 0x1B: enterEscape()
      case 0x00..<0x20: execute(value)
      case 0x20..<0x30: intermediateCount += 1
      case 0x30..<0x7F:
        state = .ground
        escapeDispatch(value)
      case 0x7F: break
      default: state = .ground
      }

    case .csi:
      switch value {
      case 0x18, 0x1A: state = .ground
      case 0x1B: enterEscape()
      case 0x00..<0x20: execute(value)
      case 0x30...0x39:
        if intermediateCount > 0 { csiIgnore = true }
        param = min(param * 10 + Int(value - 0x30), VTScreen.maxParamValue)
        sawParam = true
      case 0x3A:
        if intermediateCount > 0 { csiIgnore = true }
        pushParam()
        paramIsSub = true
      case 0x3B:
        if intermediateCount > 0 { csiIgnore = true }
        pushParam()
      case 0x3C...0x3F:
        if sawParam || intermediateCount > 0 || privateMarker != 0 { csiIgnore = true }
        privateMarker = value
        sawParam = true
      case 0x20..<0x30:
        if intermediateCount == 0 { intermediate = value }
        intermediateCount += 1
      case 0x40..<0x7F:
        pushParam()
        state = .ground
        if !csiIgnore { csiDispatch(value) }
      case 0x7F: break
      default: state = .ground
      }

    case .osc:
      switch value {
      case 0x07, 0x9C:
        state = .ground
        oscDispatch()
      case 0x1B:
        oscDispatch()
        enterEscape()
      case 0x18, 0x1A: state = .ground
      case 0x00..<0x20, 0x7F: break
      default:
        if oscText.utf8.count < VTScreen.maxOscLength { oscText.unicodeScalars.append(scalar) }
      }

    case .string:
      switch value {
      case 0x1B: enterEscape()
      case 0x9C, 0x18, 0x1A: state = .ground
      default: break
      }
    }
  }

  private func enterEscape() {
    state = .escape
    intermediate = 0
    intermediateCount = 0
  }

  private func enterCSI() {
    state = .csi
    params.removeAll(keepingCapacity: true)
    subparams.removeAll(keepingCapacity: true)
    param = 0
    paramIsSub = false
    sawParam = false
    intermediate = 0
    intermediateCount = 0
    privateMarker = 0
    csiIgnore = false
  }

  private func enterOSC() {
    state = .osc
    oscText.removeAll(keepingCapacity: true)
  }

  private func enterString() {
    state = .string
  }

  private func pushParam() {
    if params.count < VTScreen.maxParams {
      params.append(param)
      subparams.append(paramIsSub)
    }
    param = 0
    paramIsSub = false
  }

  /// The C0 controls, which run even in the middle of a sequence.
  private func execute(_ value: UInt32) {
    switch value {
    case 0x07:
      bellCount += 1
      dirty = true
    case 0x08:
      if buffer.cursorCol > 0 { buffer.cursorCol -= 1 }
      buffer.pendingWrap = false
      dirty = true
    case 0x09: tab(1)
    case 0x0A, 0x0B, 0x0C:
      lineFeed()
      if newlineMode { buffer.cursorCol = 0 }
    case 0x0D:
      buffer.cursorCol = 0
      buffer.pendingWrap = false
      dirty = true
    case 0x0E: shiftedOut = true
    case 0x0F: shiftedOut = false
    default: break
    }
  }

  private func controlC1(_ value: UInt32) {
    switch value {
    case 0x84: lineFeed()
    case 0x85:
      lineFeed()
      buffer.cursorCol = 0
    case 0x88: tabStops[buffer.cursorCol] = true
    case 0x8D: reverseIndex()
    case 0x90, 0x98, 0x9E, 0x9F: enterString()
    case 0x9B: enterCSI()
    case 0x9D: enterOSC()
    default: break
    }
  }

  private func escapeDispatch(_ final: UInt32) {
    guard intermediateCount <= 1 else { return }
    switch intermediate {
    case 0:
      switch final {
      case 0x37: saveCursor()
      case 0x38: restoreCursor()
      case 0x44: lineFeed()
      case 0x45:
        lineFeed()
        buffer.cursorCol = 0
      case 0x48: tabStops[buffer.cursorCol] = true
      case 0x4D: reverseIndex()
      case 0x63: reset()
      default: break
      }
    case 0x28: g0Graphics = final == 0x30
    case 0x29: g1Graphics = final == 0x30
    case 0x23: if final == 0x38 { alignmentTest() }
    default: break
    }
  }

  private func oscDispatch() {
    guard let separator = oscText.firstIndex(of: ";") else { return }
    guard let code = Int(oscText[..<separator]) else { return }
    if code == 0 || code == 2 {
      title = String(oscText[oscText.index(after: separator)...])
      dirty = true
    }
  }

  /// `params[index]`, with `fallback` standing in for both a missing and a
  /// zero parameter, which is what every cursor and edit command wants.
  private func arg(_ index: Int, _ fallback: Int = 1) -> Int {
    let value = index < params.count ? params[index] : 0
    return value == 0 ? fallback : value
  }

  private func csiDispatch(_ final: UInt32) {
    if intermediateCount > 0 {
      if intermediate == 0x21 && final == 0x70 { softReset() }
      return
    }
    switch privateMarker {
    case 0: break
    case 0x3F:
      switch final {
      case 0x68: setPrivateModes(true)
      case 0x6C: setPrivateModes(false)
      case 0x6E:
        if arg(0, 0) == 6 { respond("\u{1b}[?\(reportedRow());\(buffer.cursorCol + 1)R") }
      case 0x4A: eraseInDisplay(arg(0, 0))
      case 0x4B: eraseInLine(arg(0, 0))
      default: break
      }
      return
    case 0x3E:
      if final == 0x63 && arg(0, 0) == 0 { respond("\u{1b}[>0;276;0c") }
      return
    default: return
    }

    switch final {
    case 0x40: insertCells(arg(0))
    case 0x41: cursorUp(arg(0))
    case 0x42: cursorDown(arg(0))
    case 0x43: moveCursor(col: buffer.cursorCol + arg(0), row: buffer.cursorRow)
    case 0x44: moveCursor(col: buffer.cursorCol - arg(0), row: buffer.cursorRow)
    case 0x45:
      cursorDown(arg(0))
      buffer.cursorCol = 0
    case 0x46:
      cursorUp(arg(0))
      buffer.cursorCol = 0
    case 0x47, 0x60: moveCursor(col: arg(0) - 1, row: buffer.cursorRow)
    case 0x48, 0x66: setCursor(col: arg(1) - 1, row: arg(0) - 1)
    case 0x49: tab(arg(0))
    case 0x4A: eraseInDisplay(arg(0, 0))
    case 0x4B: eraseInLine(arg(0, 0))
    case 0x4C: insertLines(arg(0))
    case 0x4D: deleteLines(arg(0))
    case 0x50: deleteCells(arg(0))
    case 0x53: scrollUp(arg(0))
    case 0x54: if params.count <= 1 { scrollDown(arg(0)) }
    case 0x58: eraseCells(arg(0))
    case 0x5A: backTab(arg(0))
    case 0x61: moveCursor(col: buffer.cursorCol + arg(0), row: buffer.cursorRow)
    case 0x62: repeatLast(arg(0))
    case 0x63: if arg(0, 0) == 0 { respond("\u{1b}[?1;2c") }
    case 0x64: setCursor(col: buffer.cursorCol, row: arg(0) - 1, keepCol: true)
    case 0x65: cursorDown(arg(0))
    case 0x67:
      switch arg(0, 0) {
      case 0: tabStops[buffer.cursorCol] = false
      case 3: tabStops = Array(repeating: false, count: cols)
      default: break
      }
    case 0x68: setModes(true)
    case 0x6C: setModes(false)
    case 0x6D: selectGraphicRendition()
    case 0x6E:
      switch arg(0, 0) {
      case 5: respond("\u{1b}[0n")
      case 6: respond("\u{1b}[\(reportedRow());\(buffer.cursorCol + 1)R")
      default: break
      }
    case 0x72: setMargins(top: arg(0) - 1, bottom: arg(1, rows) - 1)
    case 0x73: saveCursor()
    case 0x74: if arg(0, 0) == 18 { respond("\u{1b}[8;\(rows);\(cols)t") }
    case 0x75: restoreCursor()
    default: break
    }
  }

  private func reportedRow() -> Int {
    (originMode ? buffer.cursorRow - buffer.scrollTop : buffer.cursorRow) + 1
  }

  private func respond(_ text: String) {
    if responses.utf8.count + text.utf8.count <= VTScreen.maxResponseLength {
      responses += text
    }
  }

  private func setModes(_ on: Bool) {
    for mode in params {
      switch mode {
      case 4: insertMode = on
      case 20: newlineMode = on
      default: break
      }
    }
  }

  private func setPrivateModes(_ on: Bool) {
    for mode in params {
      switch mode {
      case 1: applicationCursorKeys = on
      case 6:
        originMode = on
        setCursor(col: 0, row: 0)
      case 7: autowrap = on
      case 25:
        cursorVisible = on
        dirty = true
      case 47, 1047:
        if on { enterAltScreen() } else { leaveAltScreen() }
      case 1048:
        if on { saveCursor() } else { restoreCursor() }
      case 1049:
        if on {
          saveCursor()
          enterAltScreen()
        } else {
          leaveAltScreen()
          restoreCursor()
        }
      case 1000: mouseTracking = on ? .click : .none
      case 1002: mouseTracking = on ? .drag : .none
      case 1003: mouseTracking = on ? .any : .none
      case 1004: focusReporting = on
      case 1006: sgrMouse = on
      case 2004: bracketedPaste = on
      default: break
      }
    }
  }

  private func selectGraphicRendition() {
    var index = 0
    while index < params.count {
      let code = params[index]
      if subparams[index] {
        index += 1
        continue
      }
      switch code {
      case 0: style = .default
      case 1: style.bold = true
      case 2: style.dim = true
      case 3: style.italic = true
      case 4: style.underline = !(index + 1 < params.count && subparams[index + 1] && params[index + 1] == 0)
      case 7: style.inverse = true
      case 8: style.hidden = true
      case 9: style.strikethrough = true
      case 21: style.underline = true
      case 22:
        style.bold = false
        style.dim = false
      case 23: style.italic = false
      case 24: style.underline = false
      case 27: style.inverse = false
      case 28: style.hidden = false
      case 29: style.strikethrough = false
      case 30...37: style.fg = .indexed(UInt8(code - 30))
      case 38: if let color = extendedColor(after: &index) { style.fg = color }
      case 39: style.fg = .default
      case 40...47: style.bg = .indexed(UInt8(code - 40))
      case 48: if let color = extendedColor(after: &index) { style.bg = color }
      case 49: style.bg = .default
      case 58: _ = extendedColor(after: &index)
      case 90...97: style.fg = .indexed(UInt8(code - 82))
      case 100...107: style.bg = .indexed(UInt8(code - 92))
      default: break
      }
      index += 1
    }
  }

  /// The arguments of a 38/48/58 at `index`, in either spelling: `;5;n` and
  /// `;2;r;g;b` take their arguments from the following parameters, `:5:n`,
  /// `:2::r:g:b` and `:2:r:g:b` from the subparameters. `index` lands on the
  /// last argument consumed, so an unknown form costs the rest of the SGR
  /// nothing.
  private func extendedColor(after index: inout Int) -> VTColor? {
    let start = index + 1
    if start < params.count, subparams[start] {
      var end = start
      while end < params.count, subparams[end] { end += 1 }
      index = end - 1
      let args = params[start..<end]
      switch args.first {
      case 5: return args.count >= 2 ? .indexed(UInt8(clamping: args[start + 1])) : nil
      case 2:
        if args.count >= 5 { return rgb(args[start + 2], args[start + 3], args[start + 4]) }
        if args.count == 4 { return rgb(args[start + 1], args[start + 2], args[start + 3]) }
        return nil
      default: return nil
      }
    }
    guard start < params.count else {
      index = params.count
      return nil
    }
    switch params[start] {
    case 5:
      index = start + 1
      return index < params.count ? .indexed(UInt8(clamping: params[index])) : nil
    case 2:
      index = start + 3
      return index < params.count ? rgb(params[start + 1], params[start + 2], params[start + 3]) : nil
    default:
      index = start
      return nil
    }
  }

  private func rgb(_ r: Int, _ g: Int, _ b: Int) -> VTColor {
    .rgb(UInt8(clamping: r), UInt8(clamping: g), UInt8(clamping: b))
  }
}

// MARK: - Printing

extension VTScreen {
  private static let decGraphics: [Character] = [
    "◆", "▒", "␉", "␌", "␍", "␊", "°", "±", "␤", "␋", "┘", "┐", "┌", "└", "┼", "⎺", "⎻", "─",
    "⎼", "⎽", "├", "┤", "┴", "┬", "│", "≤", "≥", "π", "≠", "£", "·",
  ]

  private func printScalar(_ scalar: Unicode.Scalar) {
    if scalar.value < 0x7F {
      let graphics = shiftedOut ? g1Graphics : g0Graphics
      if graphics && scalar.value >= 0x60 {
        put(VTScreen.decGraphics[Int(scalar.value - 0x60)], width: 1)
      } else {
        put(Character(scalar), width: 1)
      }
      return
    }
    let width = VTWidth.of(scalar)
    if width == 0 {
      attach(scalar)
    } else {
      put(Character(scalar), width: width)
    }
  }

  /// One printable, `width` cells wide, at the cursor: the deferred wrap, the
  /// wide-at-the-margin case, insert mode, and the cursor's advance.
  private func put(_ text: Character, width: Int) {
    lastPrinted = (text, width)
    if buffer.pendingWrap {
      buffer.pendingWrap = false
      if autowrap {
        buffer.cursorCol = 0
        lineFeed()
      }
    }
    if width == 2 {
      guard cols >= 2 else { return }
      if buffer.cursorCol == cols - 1 {
        if autowrap {
          severWide(row: buffer.cursorRow, boundary: cols - 1)
          blankCell(row: buffer.cursorRow, col: cols - 1)
          buffer.cursorCol = 0
          lineFeed()
        } else {
          buffer.cursorCol = cols - 2
        }
      }
    }
    let row = buffer.cursorRow
    let col = buffer.cursorCol
    if insertMode { shiftRight(row: row, from: col, by: width) }
    severWide(row: row, boundary: col)
    severWide(row: row, boundary: col + width)
    buffer.grid[row][col] = VTCell(text: text, style: style, isContinuation: false)
    if width == 2 {
      buffer.grid[row][col + 1] = VTCell(text: nil, style: style, isContinuation: true)
    }
    if col + width >= cols {
      buffer.cursorCol = cols - 1
      buffer.pendingWrap = autowrap
    } else {
      buffer.cursorCol = col + width
    }
    dirty = true
  }

  /// A zero-width scalar joins the cell before the cursor, which is the last
  /// cell printed; at the left margin there is nothing to join and it is
  /// dropped, as xterm.js does. If joining would make two graphemes (a
  /// format character that does not extend its base) the scalar is dropped
  /// rather than widening the cell.
  private func attach(_ scalar: Unicode.Scalar) {
    let row = buffer.cursorRow
    var col = buffer.pendingWrap ? buffer.cursorCol : buffer.cursorCol - 1
    guard col >= 0 else { return }
    if buffer.grid[row][col].isContinuation { col -= 1 }
    guard col >= 0 else { return }
    var text = buffer.grid[row][col].text.map(String.init) ?? ""
    text.unicodeScalars.append(scalar)
    guard text.count == 1 else { return }
    buffer.grid[row][col].text = Character(text)
    dirty = true
  }

  private func repeatLast(_ count: Int) {
    guard let last = lastPrinted else { return }
    for _ in 0..<min(count, VTScreen.maxRepeat) {
      put(last.text, width: last.width)
    }
  }

  /// If a wide character straddles the boundary before `boundary`, blank both
  /// of its halves. Every edit that writes or shifts at a column calls this on
  /// its edges so a continuation never survives without its head.
  private func severWide(row: Int, boundary: Int) {
    guard boundary > 0, boundary < cols, buffer.grid[row][boundary].isContinuation else { return }
    blankCell(row: row, col: boundary - 1)
    blankCell(row: row, col: boundary)
  }

  private func blankCell(row: Int, col: Int) {
    buffer.grid[row][col].text = nil
    buffer.grid[row][col].isContinuation = false
  }
}

// MARK: - The cursor

extension VTScreen {
  private func moveCursor(col: Int, row: Int) {
    buffer.cursorCol = min(max(0, col), cols - 1)
    buffer.cursorRow = min(max(0, row), rows - 1)
    buffer.pendingWrap = false
    dirty = true
  }

  /// CUP and VPA: absolute, so origin mode (DECOM) shifts and clamps into the
  /// scroll region.
  private func setCursor(col: Int, row: Int, keepCol: Bool = false) {
    let top = originMode ? buffer.scrollTop : 0
    let bottom = originMode ? buffer.scrollBottom : rows - 1
    moveCursor(col: keepCol ? buffer.cursorCol : col, row: min(max(top, row + top), bottom))
  }

  /// Relative moves stop at the margin the cursor is inside of, and at the
  /// screen edge when it is outside the region.
  private func cursorUp(_ count: Int) {
    let limit = buffer.cursorRow >= buffer.scrollTop ? buffer.scrollTop : 0
    moveCursor(col: buffer.cursorCol, row: max(limit, buffer.cursorRow - count))
  }

  private func cursorDown(_ count: Int) {
    let limit = buffer.cursorRow <= buffer.scrollBottom ? buffer.scrollBottom : rows - 1
    moveCursor(col: buffer.cursorCol, row: min(limit, buffer.cursorRow + count))
  }

  private func tab(_ count: Int) {
    var col = buffer.cursorCol
    for _ in 0..<count {
      var next = col + 1
      while next < cols - 1, !tabStops[next] { next += 1 }
      col = min(next, cols - 1)
    }
    moveCursor(col: col, row: buffer.cursorRow)
  }

  private func backTab(_ count: Int) {
    var col = buffer.cursorCol
    for _ in 0..<count {
      var previous = col - 1
      while previous > 0, !tabStops[previous] { previous -= 1 }
      col = max(previous, 0)
    }
    moveCursor(col: col, row: buffer.cursorRow)
  }

  private func lineFeed() {
    buffer.pendingWrap = false
    if buffer.cursorRow == buffer.scrollBottom {
      scrollUp(1)
    } else if buffer.cursorRow < rows - 1 {
      buffer.cursorRow += 1
    }
    dirty = true
  }

  private func reverseIndex() {
    buffer.pendingWrap = false
    if buffer.cursorRow == buffer.scrollTop {
      scrollDown(1)
    } else if buffer.cursorRow > 0 {
      buffer.cursorRow -= 1
    }
    dirty = true
  }

  private func saveCursor() {
    buffer.saved = VTSavedCursor(
      col: buffer.cursorCol, row: buffer.cursorRow, style: style, originMode: originMode,
      g0Graphics: g0Graphics, g1Graphics: g1Graphics, shiftedOut: shiftedOut)
  }

  private func restoreCursor() {
    guard let saved = buffer.saved else {
      moveCursor(col: 0, row: 0)
      style = .default
      return
    }
    style = saved.style
    originMode = saved.originMode
    g0Graphics = saved.g0Graphics
    g1Graphics = saved.g1Graphics
    shiftedOut = saved.shiftedOut
    moveCursor(col: saved.col, row: saved.row)
  }

  private func setMargins(top: Int, bottom: Int) {
    let top = max(0, top)
    let bottom = min(rows - 1, bottom)
    guard top < bottom else { return }
    buffer.scrollTop = top
    buffer.scrollBottom = bottom
    setCursor(col: 0, row: 0)
  }

  /// DECSTR: the modes and margins, not the screen.
  func softReset() {
    style = .default
    originMode = false
    autowrap = true
    insertMode = false
    newlineMode = false
    cursorVisible = true
    applicationCursorKeys = false
    bracketedPaste = false
    mouseTracking = .none
    sgrMouse = false
    focusReporting = false
    g0Graphics = false
    g1Graphics = false
    shiftedOut = false
    tabStops = VTScreen.defaultTabStops(cols)
    buffer.scrollTop = 0
    buffer.scrollBottom = rows - 1
    buffer.pendingWrap = false
    buffer.saved = nil
    dirty = true
  }
}

// MARK: - Erasing, scrolling and editing

extension VTScreen {
  /// Back colour erase, as xterm: an erased cell takes the current background
  /// and nothing else, so a TUI's tinted panel survives its own `ESC [ K`.
  private var eraseCell: VTCell {
    VTCell(text: nil, style: VTStyle(bg: style.bg), isContinuation: false)
  }

  private func blankLine() -> [VTCell] {
    Array(repeating: eraseCell, count: cols)
  }

  private func fill(row: Int, from: Int, to: Int) {
    guard from < to else { return }
    severWide(row: row, boundary: from)
    severWide(row: row, boundary: to)
    let blank = eraseCell
    for col in from..<to {
      buffer.grid[row][col] = blank
    }
    dirty = true
  }

  private func eraseInLine(_ mode: Int) {
    buffer.pendingWrap = false
    let row = buffer.cursorRow
    switch mode {
    case 0: fill(row: row, from: buffer.cursorCol, to: cols)
    case 1: fill(row: row, from: 0, to: min(buffer.cursorCol + 1, cols))
    case 2: fill(row: row, from: 0, to: cols)
    default: break
    }
  }

  private func eraseInDisplay(_ mode: Int) {
    buffer.pendingWrap = false
    switch mode {
    case 0:
      eraseInLine(0)
      for row in (buffer.cursorRow + 1)..<max(buffer.cursorRow + 1, rows) {
        buffer.grid[row] = blankLine()
      }
    case 1:
      eraseInLine(1)
      for row in 0..<buffer.cursorRow {
        buffer.grid[row] = blankLine()
      }
    case 2:
      for row in 0..<rows {
        buffer.grid[row] = blankLine()
      }
    case 3:
      scrollback.removeAll()
    default: return
    }
    dirty = true
  }

  private func eraseCells(_ count: Int) {
    let col = buffer.cursorCol
    fill(row: buffer.cursorRow, from: col, to: min(col + count, cols))
    buffer.pendingWrap = false
  }

  private func insertCells(_ count: Int) {
    shiftRight(row: buffer.cursorRow, from: buffer.cursorCol, by: count)
    buffer.pendingWrap = false
  }

  private func shiftRight(row: Int, from col: Int, by count: Int) {
    let count = min(count, cols - col)
    guard count > 0 else { return }
    severWide(row: row, boundary: col)
    severWide(row: row, boundary: cols - count)
    buffer.grid[row].removeLast(count)
    buffer.grid[row].insert(contentsOf: repeatElement(eraseCell, count: count), at: col)
    dirty = true
  }

  private func deleteCells(_ count: Int) {
    let row = buffer.cursorRow
    let col = buffer.cursorCol
    let count = min(count, cols - col)
    guard count > 0 else { return }
    severWide(row: row, boundary: col)
    severWide(row: row, boundary: col + count)
    buffer.grid[row].removeSubrange(col..<(col + count))
    buffer.grid[row].append(contentsOf: repeatElement(eraseCell, count: count))
    buffer.pendingWrap = false
    dirty = true
  }

  /// Lines leaving the top of the main screen enter scrollback, but only when
  /// the region starts at row 0: a line scrolled out of a smaller region is
  /// gone, as in xterm.
  private func scrollUp(_ count: Int) {
    let top = buffer.scrollTop
    let bottom = buffer.scrollBottom
    let keep = !altScreenActive && top == 0
    for _ in 0..<min(count, bottom - top + 1) {
      let line = buffer.grid.remove(at: top)
      if keep { scrollback.push(VTScreen.trimmed(line)) }
      buffer.grid.insert(blankLine(), at: bottom)
    }
    dirty = true
  }

  private func scrollDown(_ count: Int) {
    let top = buffer.scrollTop
    let bottom = buffer.scrollBottom
    for _ in 0..<min(count, bottom - top + 1) {
      buffer.grid.remove(at: bottom)
      buffer.grid.insert(blankLine(), at: top)
    }
    dirty = true
  }

  private func insertLines(_ count: Int) {
    let row = buffer.cursorRow
    guard row >= buffer.scrollTop, row <= buffer.scrollBottom else { return }
    for _ in 0..<min(count, buffer.scrollBottom - row + 1) {
      buffer.grid.remove(at: buffer.scrollBottom)
      buffer.grid.insert(blankLine(), at: row)
    }
    buffer.cursorCol = 0
    buffer.pendingWrap = false
    dirty = true
  }

  private func deleteLines(_ count: Int) {
    let row = buffer.cursorRow
    guard row >= buffer.scrollTop, row <= buffer.scrollBottom else { return }
    for _ in 0..<min(count, buffer.scrollBottom - row + 1) {
      buffer.grid.remove(at: row)
      buffer.grid.insert(blankLine(), at: buffer.scrollBottom)
    }
    buffer.cursorCol = 0
    buffer.pendingWrap = false
    dirty = true
  }

  private func alignmentTest() {
    let cell = VTCell(text: "E", style: .default, isContinuation: false)
    for row in 0..<rows {
      buffer.grid[row] = Array(repeating: cell, count: cols)
    }
    buffer.scrollTop = 0
    buffer.scrollBottom = rows - 1
    moveCursor(col: 0, row: 0)
  }

  private func enterAltScreen() {
    guard !altScreenActive else { return }
    inactive = buffer
    buffer = VTBuffer(cols: cols, rows: rows, fill: eraseCell)
    buffer.cursorCol = inactive?.cursorCol ?? 0
    buffer.cursorRow = inactive?.cursorRow ?? 0
    altScreenActive = true
    dirty = true
  }

  /// The cursor carries over from the alternate screen, as xterm.js does; the
  /// 1049 pair restores the saved one on top of that.
  private func leaveAltScreen() {
    guard altScreenActive, var main = inactive else { return }
    main.cursorCol = buffer.cursorCol
    main.cursorRow = buffer.cursorRow
    main.pendingWrap = false
    buffer = main
    inactive = nil
    altScreenActive = false
    dirty = true
  }

  /// A scrollback line keeps only what it drew; the padding comes back in
  /// ``line(at:)``. A blank whose style paints stays, so a coloured bar keeps
  /// its colour into the past.
  static func trimmed(_ line: [VTCell]) -> [VTCell] {
    var end = line.count
    while end > 0, line[end - 1].isBlank, !line[end - 1].style.paintsBlank { end -= 1 }
    return end == line.count ? line : Array(line[..<end])
  }

  private func resizeBuffer(_ target: inout VTBuffer, cols newCols: Int, rows newRows: Int, usesScrollback: Bool) {
    for row in target.grid.indices {
      if target.grid[row].count > newCols {
        if target.grid[row][newCols].isContinuation {
          target.grid[row][newCols - 1].text = nil
        }
        target.grid[row].removeSubrange(newCols...)
      } else if target.grid[row].count < newCols {
        target.grid[row].append(contentsOf: repeatElement(.blank, count: newCols - target.grid[row].count))
      }
    }
    var excess = target.grid.count - newRows
    while excess > 0 {
      if target.grid.count - 1 > target.cursorRow {
        target.grid.removeLast()
      } else {
        let line = target.grid.removeFirst()
        if usesScrollback { scrollback.push(VTScreen.trimmed(line)) }
        target.cursorRow -= 1
      }
      excess -= 1
    }
    while target.grid.count < newRows {
      if usesScrollback, target.cursorRow == target.grid.count - 1, var line = scrollback.popLast() {
        if line.count > newCols {
          line.removeSubrange(newCols...)
        } else if line.count < newCols {
          line.append(contentsOf: repeatElement(.blank, count: newCols - line.count))
        }
        target.grid.insert(line, at: 0)
        target.cursorRow += 1
      } else {
        target.grid.append(Array(repeating: .blank, count: newCols))
      }
    }
    target.scrollTop = 0
    target.scrollBottom = newRows - 1
    target.cursorCol = min(target.cursorCol, newCols - 1)
    target.cursorRow = min(target.cursorRow, newRows - 1)
    target.pendingWrap = false
    if let saved = target.saved {
      target.saved?.col = min(saved.col, newCols - 1)
      target.saved?.row = min(saved.row, newRows - 1)
    }
  }
}

// MARK: - Keys

extension VTScreen {
  /// What to send to the PTY for a key, given the modes this screen is in.
  /// Backspace is DEL, as xterm sends it; a function key past F12 is empty.
  public func encode(_ key: VTKey) -> String {
    let arrow = applicationCursorKeys ? "\u{1b}O" : "\u{1b}["
    switch key {
    case .char(let character): return String(character)
    case .enter: return "\r"
    case .tab: return "\t"
    case .backspace: return "\u{7f}"
    case .escape: return "\u{1b}"
    case .up: return arrow + "A"
    case .down: return arrow + "B"
    case .right: return arrow + "C"
    case .left: return arrow + "D"
    case .home: return arrow + "H"
    case .end: return arrow + "F"
    case .pageUp: return "\u{1b}[5~"
    case .pageDown: return "\u{1b}[6~"
    case .delete: return "\u{1b}[3~"
    case .function(let number):
      switch number {
      case 1: return "\u{1b}OP"
      case 2: return "\u{1b}OQ"
      case 3: return "\u{1b}OR"
      case 4: return "\u{1b}OS"
      case 5: return "\u{1b}[15~"
      case 6: return "\u{1b}[17~"
      case 7: return "\u{1b}[18~"
      case 8: return "\u{1b}[19~"
      case 9: return "\u{1b}[20~"
      case 10: return "\u{1b}[21~"
      case 11: return "\u{1b}[23~"
      case 12: return "\u{1b}[24~"
      default: return ""
      }
    case .control(let character):
      guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1 else { return "" }
      switch scalar.value {
      case 0x61...0x7A: return String(Unicode.Scalar(UInt8(scalar.value - 0x60)))
      case 0x41...0x5A: return String(Unicode.Scalar(UInt8(scalar.value - 0x40)))
      case 0x40, 0x20: return "\0"
      case 0x5B...0x5F: return String(Unicode.Scalar(UInt8(scalar.value - 0x40)))
      case 0x3F: return "\u{7f}"
      default: return ""
      }
    }
  }

  /// Bracketed paste when mode 2004 is set, plain text otherwise. Line breaks
  /// become carriage returns either way, which is what a keyboard would have
  /// sent and what xterm.js does before writing a paste.
  public func encodePaste(_ text: String) -> String {
    let body = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
    return bracketedPaste ? "\u{1b}[200~" + body + "\u{1b}[201~" : body
  }
}

// MARK: - Storage

struct VTSavedCursor {
  var col: Int
  var row: Int
  var style: VTStyle
  var originMode: Bool
  var g0Graphics: Bool
  var g1Graphics: Bool
  var shiftedOut: Bool
}

/// One screen's worth of state: the main and the alternate screen each keep
/// their own grid, cursor, margins and DECSC slot, so a TUI's `ESC 7` inside
/// the alternate screen cannot clobber the cursor 1049 will restore on exit.
struct VTBuffer {
  var grid: [[VTCell]]
  var cursorCol = 0
  var cursorRow = 0
  var pendingWrap = false
  var scrollTop = 0
  var scrollBottom: Int
  var saved: VTSavedCursor?

  init(cols: Int, rows: Int, fill: VTCell) {
    grid = Array(repeating: Array(repeating: fill, count: cols), count: rows)
    scrollBottom = rows - 1
  }
}

/// The scrollback: a ring so that pushing at the limit evicts the oldest line
/// in O(1), and `yes | head -c 10M` costs one line's work per line.
struct VTLineRing {
  let capacity: Int
  private var storage: [[VTCell]] = []
  private var start = 0
  private(set) var count = 0

  init(capacity: Int) {
    self.capacity = capacity
  }

  subscript(index: Int) -> [VTCell] {
    storage[(start + index) % capacity]
  }

  mutating func push(_ line: [VTCell]) {
    guard capacity > 0 else { return }
    let slot = (start + count) % capacity
    if slot < storage.count { storage[slot] = line } else { storage.append(line) }
    if count == capacity { start = (start + 1) % capacity } else { count += 1 }
  }

  mutating func popLast() -> [VTCell]? {
    guard count > 0 else { return nil }
    let slot = (start + count - 1) % capacity
    let line = storage[slot]
    storage[slot] = []
    count -= 1
    return line
  }

  mutating func removeAll() {
    storage.removeAll()
    start = 0
    count = 0
  }
}
