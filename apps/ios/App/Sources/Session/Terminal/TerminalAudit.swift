#if DEBUG
  import Foundation
  import UIKit
  import WorkerDeckKit

  /// The gate that keeps "heights are exact" honest.
  ///
  /// The planner decides where every line breaks by counting **cells**, and the
  /// renderer draws each line in a one-line box. That is only safe if a line's
  /// real rendered width never exceeds the box it was planned for — otherwise
  /// text is clipped silently, which is a worse failure than a wrong height,
  /// because nothing about it looks wrong.
  ///
  /// Two things can break it: a measured cell that disagrees with what the text
  /// system actually advances, and a glyph the cell model calls two cells wide
  /// that the fallback face draws wider. `TerminalCells` already flags the
  /// second class as inexact; this measures both against real layout, which is
  /// the only thing that can answer it — the web client makes the same call and
  /// puts its height audit in a browser rather than in jsdom.
  ///
  /// Debug-only, and deliberately not a unit test: a unit test would check the
  /// calculator against its author's assumptions.
  enum TerminalAudit {
    struct Finding {
      var rowIndex: Int
      var line: String
      /// How far past its column budget the line actually rendered.
      var overflow: CGFloat
    }

    struct Report {
      var rowsChecked: Int
      var linesChecked: Int
      var findings: [Finding]

      var summary: String {
        findings.isEmpty
          ? "✔ \(linesChecked) lines over \(rowsChecked) rows, none overflowing"
          : "✘ \(findings.count) of \(linesChecked) lines overflow (worst \(String(format: "%.2f", findings.map(\.overflow).max() ?? 0))pt)"
      }
    }

    /// Plan every row and measure what each line would really draw at.
    ///
    /// A tolerance of a quarter point rather than zero: text layout rounds, and a
    /// sub-pixel excess is invisible and unclippable. Anything above that is a
    /// real cell-model disagreement and worth failing over.
    static func run(
      rows: TerminalRows, typography: TerminalTypography, metrics: TerminalMetrics,
      tolerance: CGFloat = 0.25
    ) -> Report {
      var findings: [Finding] = []
      var linesChecked = 0

      for index in 0..<rows.count {
        for line in TerminalPlanner.plan(rows[index], metrics: metrics) {
          linesChecked += 1
          // Trailing spaces are measured out, not measured in: the wrap model
          // deliberately lets preserved spaces *hang* past the last column
          // rather than forcing a break (CSS Text 3, and what every terminal
          // does), so a line ending in one is wider than its budget by design.
          // Counting them found exactly one "overflow" per soft-wrapped line —
          // a gate that cries wolf on its own correct behaviour is a gate
          // people learn to ignore.
          let measured = String(line.text.reversed().drop { $0 == " " }.reversed())
          guard !measured.isEmpty else { continue }
          let width = (measured as NSString)
            .size(withAttributes: [.font: typography.uiFont]).width
          let nested = line.nested ? TerminalPlanner.nestedIndentCells * metrics.cell : 0
          let budget =
            metrics.width - nested - CGFloat(line.columns + line.indent) * metrics.cell
          if width - budget > tolerance {
            findings.append(
              Finding(rowIndex: index, line: measured, overflow: width - budget))
          }
        }
      }
      return Report(rowsChecked: rows.count, linesChecked: linesChecked, findings: findings)
    }
  }
#endif
