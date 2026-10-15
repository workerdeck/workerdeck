import Foundation
import Testing

@testable import WorkerDeckKit

// WD_CONFORMANCE_WRITE=1 rewrites the goldens; otherwise a kit change that moves one fails here.
@Suite("Conformance goldens")
@MainActor
struct ConformanceGoldenTests {
  private static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("crates/core/tests/conformance")
  private static let writing = ProcessInfo.processInfo.environment["WD_CONFORMANCE_WRITE"] == "1"
  private static let metrics = TerminalMetrics(cell: 19.8, line: 44, width: 1080, fontSize: 32)

  private struct Line: Encodable {
    var tone: String
    var gutterTone: String
    var gutter: String
    var text: String
    var runs: [[Int]]
    var columns: Int
    var indent: Int
    var band: String
    var bold: Bool
    var italic: Bool
    var nested: Bool
    var pulsing: Bool
    var inOpen: Bool
    var elapsedSince: Double?
    var press: String?
    var image: Image?
  }

  private struct Image: Encodable {
    var toolUseId: String
    var sourceSeq: Int
    var partIndex: Int
    var mediaType: String
    var bytes: Int
    var lines: Int
  }

  private struct FrameHeader: Encodable {
    var frame: String
  }

  private struct VTCase: Decodable {
    var cols: Int
    var rows: Int
    var input: String
  }

  private struct Screen: Encodable {
    var cursor: [Int]
    var cursorVisible: Bool
    var altScreen: Bool
    var title: String?
    var bellCount: Int
    var applicationCursorKeys: Bool
    var bracketedPaste: Bool
    var sgrMouse: Bool
    var focusReporting: Bool
    var lines: [[VTRun]]
  }

  private struct VTRun: Encodable {
    var fg: UInt32
    var bg: UInt32
    var attrs: Int
    var text: String
  }

  private static func files(_ suffix: String) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasSuffix(suffix) }
      .map { String($0.dropLast(suffix.count)) }
      .sorted()
  }

  private static func encode<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  private static func settle(_ name: String, _ body: String) throws {
    let url = directory.appendingPathComponent(name)
    if writing {
      try body.write(to: url, atomically: true, encoding: .utf8)
      return
    }
    let existing = try? String(contentsOf: url, encoding: .utf8)
    #expect(existing == body, "\(name) is stale: run WD_CONFORMANCE_WRITE=1 swift test --filter Conformance")
  }

  private static func runs(_ line: TermLine) -> [[Int]] {
    guard let attributed = line.attributed else { return [] }
    var out: [[Int]] = []
    var offset = 0
    for run in attributed.runs {
      let length = String(attributed[run.range].characters).utf8.count
      let intent = Int(run.inlinePresentationIntent?.rawValue ?? 0)
      if intent != 0 { out.append([offset, length, intent]) }
      offset += length
    }
    return out
  }

  private static func color(_ color: VTColor) -> UInt32 {
    switch color {
    case .default: return 0
    case .indexed(let index): return 0x0100_0000 | UInt32(index)
    case .rgb(let r, let g, let b): return 0x0200_0000 | UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b)
    }
  }

  private static func press(_ press: TermPress?) -> String? {
    switch press {
    case nil: return nil
    case .toggle(let key): return "toggle:\(key)"
    case .expandFull(let id): return "expandFull:\(id)"
    case .openSubagent(let id): return "openSubagent:\(id)"
    case .killShell(let id): return "killShell:\(id)"
    case .openShell(let id): return "openShell:\(id)"
    case .line(let index): return "line:\(index)"
    }
  }

  private static func encode(_ line: TermLine) throws -> String {
    let image = line.image.map {
      Image(
        toolUseId: $0.toolUseId, sourceSeq: $0.sourceSeq, partIndex: $0.partIndex,
        mediaType: $0.mediaType, bytes: $0.bytes, lines: $0.lines)
    }
    return try encode(
      Line(
        tone: line.tone.rawValue, gutterTone: line.gutterTone.rawValue, gutter: line.gutter,
        text: line.text, runs: runs(line), columns: line.columns, indent: line.indent,
        band: line.band.rawValue, bold: line.bold, italic: line.italic, nested: line.nested,
        pulsing: line.pulsing, inOpen: line.inOpen, elapsedSince: line.elapsedSince,
        press: press(line.press), image: image)) + "\n"
  }

  private static func planned(
    _ rows: TerminalRows, expansion: TerminalExpansion = TerminalExpansion(),
    frameParentId: String? = nil
  ) throws -> String {
    var out = ""
    for row in rows.rows {
      for line in TerminalPlanner.plan(
        row, metrics: metrics, expansion: expansion, frameParentId: frameParentId)
      {
        out += try encode(line)
      }
    }
    return out
  }

  // Recap label and boundary for the open variant: halfway, so both sides of the seam fold.
  static let recapLabel = "conformance recap"

  @Test func plannedLinesMatchTheGoldens() throws {
    let cases = try Self.files(".events.jsonl")
    #expect(!cases.isEmpty)
    let decoder = JSONDecoder()
    for name in cases {
      let data = try Data(contentsOf: Self.directory.appendingPathComponent("\(name).events.jsonl"))
      var state = TranscriptState.initial
      for line in data.split(separator: 0x0A) where !line.isEmpty {
        if case .event(let event) = try decoder.decode(ServerFrame.self, from: Data(line)) {
          state = applyEvent(state, event)
        }
      }
      let items = state.items
      try Self.settle("\(name).lines.jsonl", try Self.planned(TerminalRows.build(items: items)))

      let boundary = items.count >= 4 ? items.count / 2 : nil
      let open = TerminalRows.build(items: items, recapAt: boundary, recapLabel: Self.recapLabel)
      let everything = TerminalExpansion.everything(in: open)
      try Self.settle(
        "\(name).open.lines.jsonl",
        try Self.planned(open, expansion: TerminalExpansion(open: everything.open)))
      try Self.settle(
        "\(name).full.lines.jsonl", try Self.planned(open, expansion: everything))

      var frames = ""
      let parents = items.compactMap { parentToolUseId(of: $0) }
      var seen = Set<String>()
      for id in parents where seen.insert(id).inserted {
        let rows = TerminalRows.build(
          items: subagentItems(items, parentToolUseId: id), frameTask: subagentTask(items, id: id))
        frames += try Self.encode(FrameHeader(frame: id)) + "\n"
        frames += try Self.planned(rows, frameParentId: id)
        frames += try Self.planned(rows, expansion: .everything(in: rows), frameParentId: id)
      }
      if !frames.isEmpty { try Self.settle("\(name).frames.lines.jsonl", frames) }
    }
  }

  @Test func vtScreensMatchTheGoldens() throws {
    let cases = try Self.files(".vt.json")
    #expect(!cases.isEmpty)
    for name in cases {
      let data = try Data(contentsOf: Self.directory.appendingPathComponent("\(name).vt.json"))
      let input = try JSONDecoder().decode(VTCase.self, from: data)
      let screen = VTScreen(cols: input.cols, rows: input.rows, scrollbackLimit: 1000)
      screen.feed(input.input)
      var lines: [[VTRun]] = []
      for index in 0..<screen.totalRows {
        var runs: [VTRun] = []
        var last: VTStyle?
        for cell in screen.line(at: index).cells where !cell.isContinuation {
          let text = cell.text.map(String.init) ?? " "
          if last == cell.style, !runs.isEmpty {
            runs[runs.count - 1].text += text
          } else {
            let style = cell.style
            let attrs =
              (style.bold ? 1 : 0) | (style.dim ? 2 : 0) | (style.italic ? 4 : 0) | (style.underline ? 8 : 0)
              | (style.inverse ? 16 : 0) | (style.strikethrough ? 32 : 0) | (style.hidden ? 64 : 0)
            runs.append(VTRun(fg: Self.color(style.fg), bg: Self.color(style.bg), attrs: attrs, text: text))
            last = style
          }
        }
        lines.append(runs)
      }
      let result = Screen(
        cursor: [screen.cursorRow, screen.cursorCol], cursorVisible: screen.cursorVisible,
        altScreen: screen.altScreenActive, title: screen.title, bellCount: screen.bellCount,
        applicationCursorKeys: screen.applicationCursorKeys, bracketedPaste: screen.bracketedPaste,
        sgrMouse: screen.sgrMouse, focusReporting: screen.focusReporting, lines: lines)
      try Self.settle("\(name).screen.json", try Self.encode(result) + "\n")
    }
  }
}
