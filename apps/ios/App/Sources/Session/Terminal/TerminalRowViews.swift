import SwiftUI
import UIKit
import WorkerDeckKit

/// Draws the lines a row was planned as.
///
/// There is deliberately no layout intelligence in here. `TerminalPlanner` has
/// already decided where every line breaks, which gutter cell it carries and how
/// far it is indented; this view puts those on screen at the cell it was
/// measured against. That is the whole reason the transcript's heights are exact
/// rather than estimated — see `TerminalPlan.swift`.
///
/// The consequence worth stating: **every `TermLine` is exactly one rendered
/// line**, so each is drawn in a fixed-height box with wrapping switched off.
/// No `lineSpacing` arithmetic, no font-metric guessing, no row that measures
/// 18pt and lays out at 18.4pt. A line that somehow overflowed its box would be
/// clipped rather than pushing the grid out of alignment, which is the failure
/// this theme exists to prevent.

extension TerminalTypography {
  /// The measured face, in the weight and slant a line asked for.
  ///
  /// Derived from `uiFont` rather than built afresh from a size, so the renderer
  /// cannot resolve a different face than the cell was measured against — which
  /// would put every glyph a fraction off the column and no test would see it.
  /// Bold and italic are *metric-compatible* here: the system monospace face
  /// advances the same for all of them, which is what makes it safe for the
  /// planner to count cells without knowing a row's weight.
  func font(bold: Bool, italic: Bool) -> Font {
    var resolved = Font(uiFont)
    if bold { resolved = resolved.weight(.semibold) }
    if italic { resolved = resolved.italic() }
    return resolved
  }
}

/// One planned row, with the blank line above it when the spacing rule asks for
/// one.
struct TerminalRowView: View {
  let lines: [TermLine]
  let typography: TerminalTypography
  let metrics: TerminalMetrics
  /// The theme's only spacing: a blank *line*, never padding, so a row's height
  /// stays an integer number of lines.
  let gapAbove: Bool
  /// One cell of air at each edge, so the gutter marker is not flush against the
  /// screen. Applied *inside* the band, which therefore still runs full width —
  /// a prompt or an output wash that stopped short of the edge would read as a
  /// box, which is the thing this theme exists not to have.
  let bleed: CGFloat
  /// What a tap on a line asks for. The planner decided which lines carry which
  /// press; this only routes it.
  var onPress: (TermPress) -> Void = { _ in }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if gapAbove { Color.clear.frame(height: metrics.line) }
      ForEach(pressGroups) { group in
        let block = VStack(alignment: .leading, spacing: 0) {
          ForEach(group.range, id: \.self) { offset in
            TermLineView(
              line: lines[offset], typography: typography, metrics: metrics, bleed: bleed)
          }
        }
        if let press = group.press {
          // `contentShape` because a line's body is text in a box and the gaps
          // between glyphs are not hit-testable without it — half a tap target
          // is worse than none.
          block
            .contentShape(Rectangle())
            .onTapGesture { onPress(press) }
        } else {
          block
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Consecutive lines that answer to the same press, as one target.
  ///
  /// Grouped rather than one recognizer per line for two reasons: an expanded
  /// tool result is fifty lines and fifty gesture recognizers is fifty too
  /// many, and a group is the unit any future press feedback would highlight.
  private var pressGroups: [PressGroup] {
    var groups: [PressGroup] = []
    for (offset, line) in lines.enumerated() {
      if var last = groups.last, last.press == line.press {
        last.range = last.range.lowerBound..<(offset + 1)
        groups[groups.count - 1] = last
        continue
      }
      groups.append(PressGroup(range: offset..<(offset + 1), press: line.press))
    }
    return groups
  }

  private struct PressGroup: Identifiable {
    var range: Range<Int>
    var press: TermPress?
    var id: Int { range.lowerBound }
  }
}

/// Exactly one line: a gutter cell and the body beside it.
///
/// The gutter being its own column is what gives every wrapped line its hanging
/// indent — the body physically cannot flow under the marker — and it is why the
/// planner pads gutters to a cell count rather than prefixing the text.
struct TermLineView: View {
  let line: TermLine
  let typography: TerminalTypography
  let metrics: TerminalMetrics
  let bleed: CGFloat

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if line.nested {
        // Drawn *inside* the padding, so the two cells stay exactly two cells.
        Rectangle()
          .fill(TerminalPalette.nestedRule)
          .frame(width: 1, height: metrics.line)
        Color.clear.frame(width: TerminalPlanner.nestedIndentCells * metrics.cell - 1)
      }
      if line.indent > 0 {
        Color.clear.frame(width: CGFloat(line.indent) * metrics.cell)
      }
      gutter
      bodyText
    }
    .padding(.horizontal, bleed)
    .frame(height: metrics.line, alignment: .topLeading)
    .background(TerminalPalette.band(line.band))
    // Under the band, and full-bleed: an expansion that runs past the top of
    // the screen otherwise leaves no mark of where it began, and the reader is
    // left guessing which row they opened. The web client's `.term-open`.
    .background(line.inOpen ? TerminalPalette.openWash : .clear)
  }

  @ViewBuilder private var gutter: some View {
    // Always rendered, even when empty, so an unmarked row's text still starts
    // on the column every marker sits on.
    Group {
      if line.pulsing {
        TerminalPulse(typography: typography)
      } else if !line.gutter.isEmpty {
        Text(line.gutter)
          .font(typography.font)
          .foregroundStyle(TerminalPalette.color(line.gutterTone))
      } else {
        Color.clear
      }
    }
    .frame(width: CGFloat(line.columns) * metrics.cell, height: metrics.line, alignment: .topLeading)
    .accessibilityHidden(true)
  }

  @ViewBuilder private var bodyText: some View {
    Group {
      if let attributed = line.attributed {
        Text(attributed)
      } else {
        Text(line.text)
      }
    }
    .font(typography.font(bold: line.bold, italic: line.italic))
    .foregroundStyle(TerminalPalette.color(line.tone))
    // Pre-wrapped by construction: the planner already broke this line to fit,
    // so re-wrapping here could only disagree with the height that was measured.
    .lineLimit(1)
    .fixedSize(horizontal: false, vertical: true)
    .frame(height: metrics.line, alignment: .topLeading)
    .frame(maxWidth: .infinity, alignment: .leading)
    .clipped()
  }
}

/// The working marker: the brand mark's own pulse.
///
/// `⋄ ◇ ◈ ◆` at 150ms is one 0.6s cycle — the same clock as `icon-loading.svg`,
/// so the transcript's working row and the brand mark beat together. It rests on
/// `◆` under Reduce Motion, which costs nothing: the last frame *is* the mark.
///
/// Safe only because the glyph sits in a fixed-width cell — U+25C6–8 are East
/// Asian *ambiguous* width, so in a real terminal the ASCII set would be needed
/// instead.
struct TerminalPulse: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let typography: TerminalTypography

  var body: some View {
    Group {
      if reduceMotion {
        Text(TermGlyph.pulseRest)
      } else {
        TimelineView(.periodic(from: .now, by: TermGlyph.pulseInterval)) { context in
          let step = Int(
            context.date.timeIntervalSinceReferenceDate / TermGlyph.pulseInterval)
          Text(TermGlyph.pulseFrames[step % TermGlyph.pulseFrames.count])
        }
      }
    }
    .font(typography.font)
    .foregroundStyle(TerminalPalette.color(.mark))
  }
}
