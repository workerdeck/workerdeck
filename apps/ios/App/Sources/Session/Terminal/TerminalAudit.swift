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

    /// A row whose drawn height disagrees with the height the book handed the
    /// layout. See `measureHeights`.
    struct HeightFinding {
      var rowIndex: Int
      var planned: CGFloat
      var measured: CGFloat
    }

    struct Report {
      var rowsChecked: Int
      var linesChecked: Int
      var findings: [Finding]
      /// How many rows had their drawn height measured, and how they came out.
      /// Zero means the height pass did not run, which is not the same as
      /// passing — the summary says so.
      var heightsChecked = 0
      var heightFindings: [HeightFinding] = []
      /// The height pass stops after a cap (see `measureHeights`). Reported
      /// rather than silent: a gate that quietly covered a tenth of the rows
      /// reads as a gate that covered them all.
      var heightsCapped = false
      /// How many blocks are open. On the readout because this screen is also
      /// where a press is checked: a tap that lands but toggles nothing and a
      /// tap that never landed look identical from outside.
      var openCount = 0

      var summary: String {
        let state = openCount > 0 ? " · \(openCount) open" : ""
        let width =
          findings.isEmpty
          ? "✔ \(linesChecked) lines over \(rowsChecked) rows, none overflowing"
          : "✘ \(findings.count) of \(linesChecked) lines overflow (worst \(String(format: "%.2f", findings.map(\.overflow).max() ?? 0))pt)"
        return width + " · " + heightSummary + state
      }

      private var heightSummary: String {
        guard heightsChecked > 0 else { return "heights unmeasured" }
        let scope = heightsCapped ? "first \(heightsChecked) rows" : "\(heightsChecked) rows"
        guard let worst = heightFindings.map({ abs($0.measured - $0.planned) }).max() else {
          return "✔ heights exact over \(scope)"
        }
        return "✘ \(heightFindings.count) rows mis-measure (worst \(String(format: "%.2f", worst))pt)"
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

    /// The **height** claim, which is the one the hand-rolled renderer added and
    /// the one nothing else can check.
    ///
    /// `TerminalRowCell` feeds the text system the lines the planner already
    /// broke, one paragraph each, pinned to `metrics.line`. If that is right, a
    /// row draws at exactly `lines.count × line` and the frames the layout took
    /// from the book are the frames the text fills. If any one of
    /// `lineFragmentPadding`, `textContainerInset`, the min/max line heights or
    /// the line-break mode is wrong, every row is off by a fraction and *nothing
    /// looks wrong* — the text simply drifts against the gutter drawn beside it.
    /// That is the same class of failure as a silently clipped line, so it
    /// belongs beside it, measured against real layout rather than asserted in a
    /// unit test.
    ///
    /// Capped, and the cap is reported: this mounts a real text view per row,
    /// and `terminalStress` is sixteen thousand of them.
    @MainActor
    static func measureHeights(
      rows: TerminalRows, typography: TerminalTypography, metrics: TerminalMetrics,
      bleed: CGFloat, expansion: TerminalExpansion = TerminalExpansion(),
      limit: Int = 400, tolerance: CGFloat = 0.5
    ) -> (checked: Int, capped: Bool, findings: [HeightFinding]) {
      let geometry = TerminalRowGeometry(metrics: metrics, bleed: bleed)
      let probe = TerminalRowCell.BodyTextView(frame: .zero, textContainer: nil)
      let width = metrics.width + 2 * bleed
      var findings: [HeightFinding] = []
      let count = min(rows.count, limit)
      for index in 0..<count {
        let lines = TerminalPlanner.plan(rows[index], metrics: metrics, expansion: expansion)
        guard !lines.isEmpty else { continue }
        probe.attributedText = TerminalTextRun.make(
          lines: lines, typography: typography, geometry: geometry)
        let measured = probe.sizeThatFits(
          CGSize(width: width, height: .greatestFiniteMagnitude)
        ).height
        let planned = CGFloat(lines.count) * metrics.line
        if abs(measured - planned) > tolerance {
          findings.append(
            HeightFinding(rowIndex: index, planned: planned, measured: measured))
        }
      }
      return (count, rows.count > limit, findings)
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
