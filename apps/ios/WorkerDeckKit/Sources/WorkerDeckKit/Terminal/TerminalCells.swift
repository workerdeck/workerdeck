import Foundation

public enum TerminalCells {
  private static let wideRanges: [ClosedRange<UInt32>] = [
    0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF,
    0x4E00...0x9FFF, 0xA000...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF,
    0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x20000...0x3FFFD,
  ]

  // How many cells one grapheme cluster occupies.
  public static func clusterCells(_ cluster: Character) -> Int {
    if cluster.unicodeScalars.contains(where: { $0.value == 0x200D || $0.value == 0xFE0F }) { return 2 }
    guard let first = cluster.unicodeScalars.first else { return 0 }
    if first.properties.isEmojiPresentation { return 2 }
    if wideRanges.contains(where: { $0.contains(first.value) }) { return 2 }
    return first.value < 0x20 ? 0 : 1
  }
}
