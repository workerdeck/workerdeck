import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

struct CoreHeightBook {
  private let heights: [CGFloat]
  private let offsets: [CGFloat]

  init(_ rows: [LayoutRow]) {
    var heights = [CGFloat](repeating: 0, count: rows.count)
    var offsets = [CGFloat](repeating: 0, count: rows.count + 1)
    for (index, row) in rows.enumerated() {
      heights[index] = CGFloat(row.height)
      offsets[index + 1] = offsets[index] + heights[index]
    }
    self.heights = heights
    self.offsets = offsets
  }

  var totalHeight: CGFloat { offsets.last ?? 0 }

  func height(at index: Int) -> CGFloat {
    heights.indices.contains(index) ? heights[index] : 0
  }

  func offset(at index: Int) -> CGFloat {
    guard index >= 0 else { return 0 }
    return index < offsets.count ? offsets[index] : totalHeight
  }

  func rowIndex(atOffset offset: CGFloat) -> Int {
    guard !heights.isEmpty else { return 0 }
    var low = 0
    var high = heights.count - 1
    while low < high {
      let mid = (low + high + 1) / 2
      if offsets[mid] <= offset { low = mid } else { high = mid - 1 }
    }
    return low
  }
}

// Rows outside the window the core holds draw empty at their planned height until `show_rows` brings their lines.
struct CoreTranscriptContent {
  let rows: CoreRows
  let metrics: TerminalMetrics

  var count: Int { rows.rows.count }
  var book: CoreHeightBook { rows.book }
  func key(at index: Int) -> String { rows.rows[index].key }

  func sameEpoch(as other: Self) -> Bool {
    rows.linesRevision == other.rows.linesRevision && metrics == other.metrics
  }

  func redraws(_ index: Int, from old: Self) -> Bool {
    metrics != old.metrics || rows.rows[index] != old.rows.rows[index]
      || rows.linesAt(index) != old.rows.linesAt(index) || read(index) != old.read(index)
  }

  func read(_ index: Int) -> Bool { rows.recapRow.map { index < $0 } ?? false }
}

// The session's transcript, or with `frame` set an open sub-agent's own rows: no sticky prompt there, since a
// sub-agent's brief is not a prompt.
struct CoreTranscriptView: View {
  let model: CoreSessionModel
  var frame: String?
  let scroll: TranscriptScrollModel
  let imageLoader: TerminalImageLoader
  let hideThinking: Bool
  @Environment(\.coreRowActions) private var actions
  private let typography = TerminalTypography.session

  var body: some View {
    GeometryReader { proxy in
      let bleed = typography.cell
      let metrics = typography.metrics(width: proxy.size.width - 2 * bleed - CoreScrubberRail.railWidth)
      Group {
        if let planned = model.metrics, proxy.size.width > 0, let rows {
          transcript(CoreTranscriptContent(rows: rows, metrics: planned), bleed: bleed)
        } else {
          Color.clear
        }
      }
      .onAppear { model.layout(metrics: metrics, hideThinking: hideThinking) }
      .onChange(of: metrics) { _, metrics in model.layout(metrics: metrics, hideThinking: hideThinking) }
    }
    .background(Color(uiColor: .systemBackground))
  }

  private var rows: CoreRows? {
    guard let frame else { return model.ui.main }
    return model.ui.frame?.taskId == frame ? model.ui.frame?.rows : nil
  }

  private func transcript(_ content: CoreTranscriptContent, bleed: CGFloat) -> some View {
    let inFrame = frame != nil
    return VirtualizedTranscriptView(
      content: content, scroll: scroll, reveal: content.rows.reveal, focus: inFrame ? nil : model.ui.focus,
      showsScrollIndicator: false, verticalPadding: content.metrics.line,
      configureRow: { [model, imageLoader, typography, actions] cell, index in
        cell.configure(
          lines: content.rows.linesAt(index)?.enumerated().map { $1.termLine(press: $0) } ?? [],
          typography: typography, metrics: content.metrics, gapAbove: content.rows.rows[index].gapAbove,
          bleed: bleed, read: content.read(index), imageLoader: imageLoader, onImage: actions?.openImage,
          onPress: { press in
            guard case .line(let line) = press else { return }
            if inFrame { model.framePress(row: index, line: line) } else { model.press(row: index, line: line) }
          })
      },
      menuForRow: actions.map { actions in { actions.menu($0, inFrame) } },
      onVisibleRows: { [model] first, last in
        if inFrame { model.frameVisible(first: first, last: last) } else { model.visible(first: first, last: last) }
      }
    )
    .overlay(alignment: .top) {
      if !inFrame {
        CoreStickyPrompt(model: model, content: content, scroll: scroll, typography: typography, bleed: bleed)
      }
    }
    .overlay(alignment: .trailing) {
      CoreScrubberRail(
        model: model, inFrame: inFrame, clusters: content.rows.rail, total: content.book.totalHeight,
        scroll: scroll, typography: typography)
    }
  }
}

private struct CoreStickyPrompt: View {
  let model: CoreSessionModel
  let content: CoreTranscriptContent
  let scroll: TranscriptScrollModel
  let typography: TerminalTypography
  let bleed: CGFloat

  private static let rule: CGFloat = 1
  private var line: CGFloat { content.metrics.line }

  var body: some View {
    let pin = self.pin
    ZStack(alignment: .top) {
      if let pin, let pinned = line(of: pin.row) {
        VStack(spacing: 0) {
          TerminalLineStrip(line: pinned, typography: typography, metrics: content.metrics, bleed: bleed)
            .frame(height: line)
          Rectangle().fill(TerminalPalette.nestedRule).frame(height: Self.rule)
        }
        .background(Color(uiColor: .systemBackground))
        .offset(y: pin.offset)
        .frame(height: line + Self.rule, alignment: .top)
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { scroll.scrollToRow(pin.row, anchor: .top, animated: true) }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Go to this prompt")
      }
    }
    .task(id: pin?.row) {
      guard let row = pin?.row, line(of: row) == nil else { return }
      model.pinLine(row: row, key: content.rows.rows[row].key)
    }
  }

  private var pin: StickyPrompt.Pin? {
    let rows = content.rows.rows
    return StickyPrompt.resolve(
      promptRows: content.rows.promptRows,
      contentTop: { content.book.offset(at: $0) + (rows[$0].gapAbove ? line : 0) },
      top: scroll.contentOffset, line: line, stripHeight: line + Self.rule)
  }

  private func line(of row: Int) -> TermLine? {
    guard content.rows.rows.indices.contains(row) else { return nil }
    if let first = content.rows.linesAt(row)?.first { return first.termLine(press: nil) }
    guard let pinned = model.ui.pinned, pinned.key == content.rows.rows[row].key else { return nil }
    return pinned.line.termLine(press: nil)
  }
}

private enum CoreNames {
  static let tones = toneNames().map { TermTone(rawValue: $0) ?? .fg }
  static let bands = bandNames().map { TermBand(rawValue: $0) ?? .none }

  static func tone(_ index: UInt8) -> TermTone { tones.indices.contains(Int(index)) ? tones[Int(index)] : .fg }
  static func band(_ index: UInt8) -> TermBand { bands.indices.contains(Int(index)) ? bands[Int(index)] : .none }
}

extension TranscriptLine {
  // The core's run intents are Foundation's `InlinePresentationIntent` bits, which the row cell already reads.
  func termLine(press index: Int?) -> TermLine {
    TermLine(
      gutter: gutter, gutterTone: CoreNames.tone(gutterTone), text: text, attributed: attributed,
      tone: CoreNames.tone(tone), columns: columns, indent: indent, band: CoreNames.band(band), bold: bold,
      italic: italic, nested: nested, pulsing: pulsing, press: pressable ? index.map(TermPress.line) : nil,
      image: image.map {
        TermImageBox(
          toolUseId: $0.toolUseId, sourceSeq: Int($0.sourceSeq), partIndex: Int($0.partIndex),
          mediaType: $0.mediaType, bytes: Int($0.bytes), lines: $0.lines,
          hostPath: $0.hostPath.isEmpty ? nil : $0.hostPath, placeholder: $0.placeholder.isEmpty ? nil : $0.placeholder)
      },
      inOpen: inOpen, elapsedSince: elapsedSince)
  }

  private var attributed: AttributedString? {
    guard !runs.isEmpty else { return nil }
    let string = NSMutableAttributedString(string: text)
    for run in runs where run.end > run.start && run.end <= string.length {
      string.addAttribute(
        .inlinePresentationIntent, value: NSNumber(value: UInt(run.intent)),
        range: NSRange(location: run.start, length: run.end - run.start))
    }
    return AttributedString(string)
  }
}
