import Foundation
@_exported import WorkerDeckCore

// Readers for the core's byte snapshots, layout per docs/NATIVE-CORE-SNAPSHOTS.md. Offsets the core gives in UTF-8
// bytes come back here in UTF-16 units, the ones NSString and NSRange index by.
public let snapshotReaderVersion: UInt8 = 4

public struct SnapshotError: Error, Equatable {
  public let message: String
}

public struct LayoutRow: Equatable, Sendable {
  public let key: String
  public let height: Float
  public let gapAbove: Bool
  public let prompt: Bool
  public let recap: Bool
}

public struct TranscriptLayout: Equatable, Sendable {
  public let rows: [LayoutRow]
  public let revealRow: Int?
  public let revealNonce: UInt64
}

public struct TextRun: Equatable, Sendable {
  public let start: Int
  public let end: Int
  public let intent: UInt8
}

public struct LineImage: Equatable, Hashable, Sendable {
  public let toolUseId: String
  public let sourceSeq: Int64
  public let partIndex: Int64
  public let mediaType: String
  public let bytes: Int64
  public let lines: Int
  public let name: String
  public let placeholder: String
  public let hostPath: String
}

public struct TranscriptLine: Equatable, Sendable {
  public let tone: UInt8
  public let gutterTone: UInt8
  public let band: UInt8
  public let flags: UInt8
  public let indent: Int
  public let columns: Int
  public let gutter: String
  public let text: String
  public let runs: [TextRun]
  public let elapsedSince: Double?
  public let image: LineImage?

  public var bold: Bool { flags & 1 != 0 }
  public var italic: Bool { flags & 2 != 0 }
  public var nested: Bool { flags & 4 != 0 }
  public var pulsing: Bool { flags & 8 != 0 }
  public var inOpen: Bool { flags & 16 != 0 }
  public var pressable: Bool { flags & 32 != 0 }
}

public struct TranscriptLines: Equatable, Sendable {
  public let startRow: Int
  public let rows: [[TranscriptLine]]
}

public struct TranscriptFrame: Equatable, Sendable {
  public let layout: TranscriptLayout
  public let lines: TranscriptLines
}

// Colour words: 0 the slot's default (theme foreground, or no fill), FOREGROUND / BACKGROUND the theme's own, RGB | rgb.
public struct ShellRun: Equatable, Sendable {
  public static let foreground: UInt32 = 0x0100_0000
  public static let rgb: UInt32 = 0x0200_0000
  public static let background: UInt32 = 0x0300_0000

  public let fg: UInt32
  public let bg: UInt32
  public let style: UInt8
  public let columns: Int
  public let text: String

  public var bold: Bool { style & 1 != 0 }
  public var dim: Bool { style & 2 != 0 }
  public var italic: Bool { style & 4 != 0 }
  public var underline: Bool { style & 8 != 0 }
  public var strikethrough: Bool { style & 32 != 0 }
  public var hidden: Bool { style & 64 != 0 }
}

public struct ShellGrid: Equatable, Sendable {
  public let revision: Int64
  public let cols: Int
  public let rows: Int
  public let totalLines: Int
  public let cursorRow: Int
  public let cursorCol: Int
  public let flags: UInt8
  public let title: String
  public let statusText: String
  public let startLine: Int
  public let lines: [[ShellRun]]

  public var cursorVisible: Bool { flags & 1 != 0 }
  public var altScreen: Bool { flags & 2 != 0 }
  public var canType: Bool { flags & 4 != 0 }
  public var running: Bool { flags & 8 != 0 }
  public var ended: Bool { flags & 16 != 0 }
}

public enum Snapshots {
  public static func transcriptLayout(_ bytes: Data) throws -> TranscriptLayout {
    var reader = Reader(bytes)
    try reader.version()
    return try reader.layout()
  }

  public static func transcriptLines(_ bytes: Data) throws -> TranscriptLines {
    var reader = Reader(bytes)
    try reader.version()
    return try reader.lines()
  }

  public static func transcriptFrame(_ bytes: Data) throws -> TranscriptFrame {
    var reader = Reader(bytes)
    try reader.version()
    let layout = try reader.layout()
    try reader.version()
    return TranscriptFrame(layout: layout, lines: try reader.lines())
  }

  public static func shellGrid(_ bytes: Data) throws -> ShellGrid {
    var reader = Reader(bytes)
    try reader.version()
    let revision = Int64(bitPattern: try reader.u64())
    let cols = Int(try reader.u16())
    let rows = Int(try reader.u16())
    let total = Int(try reader.u32())
    let cursorRow = Int(try reader.u16())
    let cursorCol = Int(try reader.u16())
    let flags = try reader.u8()
    let title = try reader.str16()
    let status = try reader.str16()
    let start = Int(try reader.u32())
    let count = Int(try reader.u32())
    var lines: [[ShellRun]] = []
    lines.reserveCapacity(count)
    for _ in 0..<count {
      let runs = Int(try reader.u16())
      var line: [ShellRun] = []
      line.reserveCapacity(runs)
      for _ in 0..<runs {
        line.append(
          ShellRun(
            fg: try reader.u32(), bg: try reader.u32(), style: try reader.u8(),
            columns: Int(try reader.u16()), text: try reader.str32()))
      }
      lines.append(line)
    }
    return ShellGrid(
      revision: revision, cols: cols, rows: rows, totalLines: total, cursorRow: cursorRow,
      cursorCol: cursorCol, flags: flags, title: title, statusText: status, startLine: start, lines: lines)
  }
}

private struct Reader {
  private let bytes: [UInt8]
  private var at = 0

  init(_ data: Data) { bytes = [UInt8](data) }

  mutating func version() throws {
    let found = try u8()
    guard found == snapshotReaderVersion else {
      throw SnapshotError(message: "snapshot version \(found), this reader knows \(snapshotReaderVersion)")
    }
  }

  private mutating func take(_ count: Int) throws -> ArraySlice<UInt8> {
    guard count >= 0, at + count <= bytes.count else {
      throw SnapshotError(message: "snapshot ends at \(bytes.count), wanted \(at + count)")
    }
    defer { at += count }
    return bytes[at..<at + count]
  }

  private mutating func little(_ count: Int) throws -> UInt64 {
    try take(count).reversed().reduce(0) { $0 << 8 | UInt64($1) }
  }

  mutating func u8() throws -> UInt8 { try take(1).first! }
  mutating func u16() throws -> UInt16 { UInt16(try little(2)) }
  mutating func u32() throws -> UInt32 { UInt32(try little(4)) }
  mutating func u64() throws -> UInt64 { try little(8) }
  mutating func i32() throws -> Int32 { Int32(bitPattern: try u32()) }
  mutating func f32() throws -> Float { Float(bitPattern: try u32()) }
  mutating func f64() throws -> Double { Double(bitPattern: try u64()) }
  mutating func i64() throws -> Int64 { Int64(bitPattern: try u64()) }

  mutating func str16() throws -> String { String(decoding: try take(Int(try u16())), as: UTF8.self) }
  mutating func str32() throws -> String { String(decoding: try take(Int(try u32())), as: UTF8.self) }

  mutating func layout() throws -> TranscriptLayout {
    let count = Int(try u32())
    var rows: [LayoutRow] = []
    rows.reserveCapacity(count)
    for _ in 0..<count {
      let key = try str16()
      let height = try f32()
      let flags = try u8()
      rows.append(
        LayoutRow(key: key, height: height, gapAbove: flags & 1 != 0, prompt: flags & 2 != 0, recap: flags & 4 != 0))
    }
    let reveal = try i32()
    let nonce = try u64()
    return TranscriptLayout(rows: rows, revealRow: reveal >= 0 ? Int(reveal) : nil, revealNonce: nonce)
  }

  mutating func lines() throws -> TranscriptLines {
    let start = Int(try u32())
    let count = Int(try u32())
    var rows: [[TranscriptLine]] = []
    rows.reserveCapacity(count)
    for _ in 0..<count {
      let lineCount = Int(try u32())
      var row: [TranscriptLine] = []
      row.reserveCapacity(lineCount)
      for _ in 0..<lineCount { row.append(try line()) }
      rows.append(row)
    }
    return TranscriptLines(startRow: start, rows: rows)
  }

  private mutating func line() throws -> TranscriptLine {
    let tone = try u8()
    let gutterTone = try u8()
    let band = try u8()
    let flags = try u8()
    let indent = Int(try u16())
    let columns = Int(try u16())
    let gutter = try str16()
    let raw = try take(Int(try u32()))
    let text = String(decoding: raw, as: UTF8.self)
    var units = Utf16Offsets(raw)
    let runCount = Int(try u16())
    var runs: [TextRun] = []
    runs.reserveCapacity(runCount)
    for _ in 0..<runCount {
      let byteStart = Int(try u32())
      let byteLen = Int(try u32())
      runs.append(
        TextRun(start: units.at(byteStart), end: units.at(byteStart + byteLen), intent: try u8()))
    }
    let elapsed = flags & 128 != 0 ? try f64() : nil
    var image: LineImage?
    if flags & 64 != 0 {
      image = LineImage(
        toolUseId: try str16(), sourceSeq: try i64(), partIndex: try i64(), mediaType: try str16(),
        bytes: try i64(), lines: Int(try u16()), name: try str16(), placeholder: try str16(),
        hostPath: try str16())
    }
    return TranscriptLine(
      tone: tone, gutterTone: gutterTone, band: band, flags: flags, indent: indent, columns: columns,
      gutter: gutter, text: text, runs: runs, elapsedSince: elapsed, image: image)
  }
}

private struct Utf16Offsets {
  private let utf8: ArraySlice<UInt8>
  private var byte: Int
  private var unit = 0

  init(_ utf8: ArraySlice<UInt8>) {
    self.utf8 = utf8
    byte = utf8.startIndex
  }

  mutating func at(_ target: Int) -> Int {
    let goal = utf8.startIndex + min(target, utf8.count)
    if goal < byte {
      byte = utf8.startIndex
      unit = 0
    }
    while byte < goal {
      let lead = utf8[byte]
      let width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
      byte += width
      unit += width == 4 ? 2 : 1
    }
    return unit
  }
}
