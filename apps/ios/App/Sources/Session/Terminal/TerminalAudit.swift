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
      /// How many blocks are open. On the readout because this screen is also
      /// where a press is checked: a tap that lands but toggles nothing and a
      /// tap that never landed look identical from outside.
      var openCount = 0

      var summary: String {
        let state = openCount > 0 ? " · \(openCount) open" : ""
        return findings.isEmpty
          ? "✔ \(linesChecked) lines over \(rowsChecked) rows, none overflowing\(state)"
          : "✘ \(findings.count) of \(linesChecked) lines overflow (worst \(String(format: "%.2f", findings.map(\.overflow).max() ?? 0))pt)\(state)"
      }
    }

    /// Plan every row and measure what each line would really draw at.
    ///
    /// A tolerance of a quarter point rather than zero: text layout rounds, and a
    /// sub-pixel excess is invisible and unclippable. Anything above that is a
    /// real cell-model disagreement and worth failing over.
    /// - Parameter alsoFullyExpanded: fold in a second pass over the transcript
    ///   with **everything open**. Without it the gate only ever sees collapsed
    ///   lines, and a summary that wraps correctly says nothing about the fifty
    ///   result lines behind it. Planning is pure, so this draws nothing.
    static func run(
      rows: TerminalRows, typography: TerminalTypography, metrics: TerminalMetrics,
      expansion: TerminalExpansion = TerminalExpansion(), alsoFullyExpanded: Bool = false,
      tolerance: CGFloat = 0.25
    ) -> Report {
      var report = pass(
        rows: rows, typography: typography, metrics: metrics, expansion: expansion,
        tolerance: tolerance)
      guard alsoFullyExpanded else { return report }
      let expanded = pass(
        rows: rows, typography: typography, metrics: metrics,
        expansion: .everything(in: rows), tolerance: tolerance)
      report.linesChecked += expanded.linesChecked
      report.findings += expanded.findings
      report.openCount = expansion.open.count
      return report
    }

    private static func pass(
      rows: TerminalRows, typography: TerminalTypography, metrics: TerminalMetrics,
      expansion: TerminalExpansion, tolerance: CGFloat
    ) -> Report {
      var findings: [Finding] = []
      var linesChecked = 0

      for index in 0..<rows.count {
        for line in TerminalPlanner.plan(rows[index], metrics: metrics, expansion: expansion) {
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
