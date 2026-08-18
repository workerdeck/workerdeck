import Foundation

/// Turns one row into the lines it draws.
///
/// Every string here comes from the shared summary/preview functions rather
/// than being spelled locally, because the string *is* the height. See
/// `TerminalPlan.swift` for the design note.
public enum TerminalPlanner {

  // MARK: - Entry points

  /// The lines a row draws in its **collapsed** state — which is the only state
  /// that has to be predicted, since an expanded row is on screen by definition.
  public static func plan(_ row: TranscriptRow, metrics: TerminalMetrics) -> [TermLine] {
    switch row {
    case .recap(let label):
      return wrapBody(
        "\(TermGlyph.recap) \(label)", metrics: metrics, gutter: "", tone: .faint, columns: 0)
    case .block(let block):
      return plan(block, metrics: metrics)
    }
  }

  public static func plan(_ block: TerminalBlock, metrics: TerminalMetrics) -> [TermLine] {
    switch block {
    case .item(let leaf):
      return plan(item: leaf.item, metrics: metrics)
    case .run(let leaf):
      return planRun(leaf.run, metrics: metrics)
    case .task(let leaf):
      return planTask(leaf, metrics: metrics)
    }
  }

  // MARK: - Folded rows

  /// One row for a whole run of tool calls. No glyph once settled: a run is an
  /// aside, and a bullet would give it the weight of something the model said.
  ///
  /// **A run of one is drawn as the call itself**, and this is a deliberate
  /// divergence from the web client, which summarises it as `Ran 1 tool · 1
  /// roam-code`. The fold's entire justification is row-count compression — six
  /// calls bury the sentence you came back to read — and at one call there is no
  /// compression to be had: the summary occupies exactly the same single row
  /// while throwing away the tool's name, its input and its result preview. It
  /// is the same complaint that widened the fold's membership from shell-only
  /// ("a count for every gap it could not group, which is worse than not
  /// folding"); widening made it rarer without removing it. The block model is
  /// untouched — this is a rendering rule, so keys, indices and
  /// `rowIndex(forItem:)` all stay exactly as they were.
  static func planRun(_ run: [ToolCallItem], metrics: TerminalMetrics) -> [TermLine] {
    if run.count == 1, let only = run.first { return planToolCall(only, metrics: metrics) }
    let busy = run.contains(where: callBusy)
    let failed = run.contains(where: callFailed)
    let nested = run.first?.parentToolUseId != nil
    return wrapBody(
      runSummary(run, busy: busy), metrics: metrics,
      gutter: busy ? TermGlyph.pulseRest : "", gutterTone: .mark,
      tone: failed ? .red : .dim, nested: nested, pulsing: busy)
  }

  /// One row for a `Task` and everything its subagent produced.
  ///
  /// **Always collapsed when unmounted**, and that is load-bearing rather than
  /// tidy: the live signal is *in* the collapsed line — the pulse, and a
  /// climbing tool count — never an auto-expansion that would resize the row
  /// under the reader.
  static func planTask(_ block: TerminalTaskBlock, metrics: TerminalMetrics) -> [TermLine] {
    let children = taskChildItems(block)
    let busy = taskBusy(block.task, children)
    let failed = taskFailed(block.task, children)
    return wrapBody(
      taskSummary(block.task, children), metrics: metrics,
      gutter: busy ? TermGlyph.pulseRest : TermGlyph.bullet,
      gutterTone: failed ? .red : (busy ? .mark : .dim),
      tone: failed ? .red : .fg, pulsing: busy)
  }

  // MARK: - Items

  static func plan(item: TranscriptItem, metrics: TerminalMetrics) -> [TermLine] {
    let nested = parentToolUseId(of: item) != nil

    switch item {
    case .user(_, let text, let attachments, _):
      var lines: [TermLine] = []
      if let attachments, !attachments.isEmpty {
        lines += wrapBody(
          attachments.map(\.name).joined(separator: ", "), metrics: metrics,
          gutter: TermGlyph.prompt, gutterTone: .dim, tone: .dim, band: .user, nested: nested)
      }
      // One row per hard line, with the marker on the first only — a pasted
      // twenty-line prompt is one prompt, not twenty.
      let markerOnFirst = lines.isEmpty
      lines += wrapBody(
        text.isEmpty ? " " : text, metrics: metrics,
        gutter: markerOnFirst ? TermGlyph.prompt : "", gutterTone: .dim, tone: .fg,
        band: .user, nested: nested)
      return lines

    case .assistantText(_, let text, _, _):
      return planMarkdown(
        text, metrics: metrics, gutter: TermGlyph.bullet, gutterTone: .fg, nested: nested)

    case .thinking(_, let text, _):
      return wrapBody(
        text, metrics: metrics, gutter: TermGlyph.thinking, gutterTone: .dim, tone: .dim,
        italic: true, nested: nested)

    case .toolCall(let call):
      return planToolCall(call, metrics: metrics)

    case .turnResult(_, let subtype, let isError, let durationMs, let totalCostUsd, let errors):
      // No glyph: a turn ending is not something anyone said.
      let head =
        "\(isError ? subtype : "done") · \(TermFmt.duration(ms: durationMs)) · \(TermFmt.cost(totalCostUsd))"
      var lines = wrapBody(head, metrics: metrics, gutter: "", tone: isError ? .red : .faint)
      for message in errors ?? [] {
        lines += wrapBody(message, metrics: metrics, gutter: "", tone: .red)
      }
      return lines

    case .notice(_, let level, let text):
      return wrapBody(
        text, metrics: metrics, gutter: TermGlyph.notice,
        gutterTone: level == .error ? .red : .yellow, tone: level == .error ? .red : .dim)

    case .fileDelivered(_, let path, let bytes, let description):
      var body = "\(path) · \(TermFmt.bytes(bytes))"
      if let description, !description.isEmpty { body += " · \(description)" }
      return wrapBody(
        body, metrics: metrics, gutter: TermGlyph.file, gutterTone: .blue, tone: .dim)
    }
  }

  /// A tool call: its header, then either the diff it produced or a clipped
  /// preview of its result.
  static func planToolCall(_ call: ToolCallItem, metrics: TerminalMetrics) -> [TermLine] {
    let nested = call.parentToolUseId != nil
    let busy = callBusy(call)
    let tone = toolTone(call)

    var header = "\(call.name)(\(TermFmt.toolInputPreview(call.input)))"
    if let backend = call.backend, backend != "server" { header += " · \(backend)" }

    var lines = wrapBody(
      header, metrics: metrics, gutter: busy ? TermGlyph.pulseRest : TermGlyph.bullet,
      gutterTone: tone, tone: .fg, bold: true, nested: nested, pulsing: busy)

    if let patch = call.patch {
      lines += planDiff(patch, metrics: metrics, nested: nested)
      return lines
    }

    guard let text = call.result?.text, !text.isEmpty else { return lines }
    let failed = callFailed(call)
    // The preview rows sit one level in behind the `⎿` marker: three gutter
    // cells and one indent level, six cells in all.
    // The preview rows lose six cells to the marker and the indent, so the
    // budget is measured against the width they actually get.
    let previewCols = metrics.columns(
      gutter: 3, indent: 1, extra: nested ? nestedIndentCells * metrics.cell : 0)
    let collapsed = ResultPreview.collapsed(
      text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        .components(separatedBy: "\n"), cols: previewCols)
    for (offset, line) in collapsed.shown.enumerated() {
      lines += wrapBody(
        line.isEmpty ? " " : line, metrics: metrics,
        gutter: offset == 0 ? TermGlyph.output : "", gutterTone: failed ? .red : .dim,
        tone: failed ? .red : .dim, columns: 3, indent: 1, band: .output, nested: nested)
    }
    if let more = collapsed.more {
      lines += wrapBody(
        more, metrics: metrics, gutter: "", tone: .faint, columns: 3, indent: 1, band: .output,
        nested: nested)
    }
    return lines
  }

  /// Failure first, because a failed write is not a green write; then the
  /// mutation colour, which answers "what did it change" at a glance; then the
  /// status.
  public static func toolTone(_ call: ToolCallItem) -> TermTone {
    if callFailed(call) { return .red }
    if call.status == .settled && isMutatingTool(call.name) { return .green }
    switch call.status {
    case .running, .pending: return .blue
    case .deferred: return .yellow
    case .settled: return .dim
    case .failed: return .red
    }
  }

  // MARK: - Diffs

  /// A `FilePatch` with the **engine's own** line numbers. A patch whose hunks
  /// all start at 0 is a preview of an edit that has not happened — this client
  /// has never read the file, so the number column is dropped rather than
  /// invented.
  static func planDiff(_ patch: FilePatch, metrics: TerminalMetrics, nested: Bool) -> [TermLine] {
    let numbered = patch.hunks.contains { $0.newStart > 0 }
    var widest = 1
    if numbered {
      for hunk in patch.hunks {
        widest = max(widest, hunk.newStart + hunk.newLines, hunk.oldStart + hunk.oldLines)
      }
    }
    let numberWidth = numbered ? String(widest).count : 0
    let columns = numbered ? numberWidth + 3 : 2

    var lines: [TermLine] = []
    for (index, hunk) in patch.hunks.enumerated() {
      if index > 0 {
        lines.append(
          TermLine(
            gutter: String(repeating: " ", count: numberWidth) + " " + TermGlyph.hunkGap,
            gutterTone: .faint, text: "", tone: .faint, columns: columns, indent: 2,
            nested: nested))
      }
      var oldNumber = hunk.oldStart
      var newNumber = hunk.newStart
      for raw in hunk.lines {
        let marker = raw.first ?? " "
        let body = String(raw.dropFirst())
        let tone: TermTone
        let band: TermBand
        let shownNumber: Int
        switch marker {
        case "+":
          tone = .diffAdd
          band = .diffAdd
          shownNumber = newNumber
          newNumber += 1
        case "-":
          tone = .diffRemove
          band = .diffRemove
          shownNumber = oldNumber
          oldNumber += 1
        default:
          tone = .diffContext
          band = .none
          shownNumber = newNumber
          newNumber += 1
          oldNumber += 1
        }
        let gutter =
          numbered
          ? String(String(shownNumber).leftPadded(to: numberWidth)) + " " + String(marker)
          : String(marker)
        lines += wrapBody(
          body.isEmpty ? " " : body, metrics: metrics, gutter: gutter, gutterTone: .diffNumber,
          tone: tone, columns: columns, indent: 2, band: band, nested: nested)
      }
    }
    if patch.truncated == true {
      lines += wrapBody(
        "… hunks omitted", metrics: metrics, gutter: "", tone: .faint, columns: columns, indent: 2,
        nested: nested)
    }
    return lines
  }

  // MARK: - Markdown

  /// Assistant prose, block by block, with one blank line between blocks — the
  /// theme's only spacing.
  static func planMarkdown(
    _ source: String, metrics: TerminalMetrics, gutter: String, gutterTone: TermTone, nested: Bool
  ) -> [TermLine] {
    var lines: [TermLine] = []
    var first = true

    func emit(_ produced: [TermLine]) {
      guard !produced.isEmpty else { return }
      if !first { lines.append(TermLine(text: "", tone: .fg, nested: nested)) }
      first = false
      lines += produced
    }

    for block in MarkdownBlocks.parse(source) {
      switch block {
      case .prose(let text):
        emit(inlineBody(text, metrics: metrics, tone: .fg, nested: nested))
      case .heading(_, let text):
        // A terminal marks a heading by weight, never by size: there is one line
        // height, and a bigger glyph would break the grid it is drawn on.
        emit(inlineBody(text, metrics: metrics, tone: .bright, bold: true, nested: nested))
      case .blockquote(let text):
        emit(inlineBody(text, metrics: metrics, tone: .dim, indent: 1, nested: nested))
      case .thematicBreak:
        emit([TermLine(text: "", tone: .faint, nested: nested)])
      case .code(let language, let text, _):
        _ = language
        var produced: [TermLine] = []
        for line in text.components(separatedBy: "\n") {
          produced += wrapBody(
            line.isEmpty ? " " : line, metrics: metrics, gutter: "", tone: .dim, indent: 1,
            band: .output, nested: nested)
        }
        emit(produced.isEmpty ? [TermLine(text: " ", tone: .dim, band: .output, nested: nested)] : produced)
      case .list(let items):
        emit(planList(items, metrics: metrics, nested: nested))
      }
    }

    guard !lines.isEmpty else {
      return [TermLine(gutter: gutter, gutterTone: gutterTone, text: "", tone: .fg, nested: nested)]
    }
    lines[0].gutter = gutter
    lines[0].gutterTone = gutterTone
    return lines
  }

  /// List items, with the marker in the gutter so a wrapped item hangs under its
  /// own text rather than under the bullet.
  ///
  /// The indent of a nested item is the **sum of its ancestors' gutters**, not
  /// its depth times a constant: `1. ` is three cells and `- ` is two, so a
  /// bullet nested under an ordered item starts one cell further in than one
  /// nested under a bullet. Tracked while walking, since a `MarkdownListItem`
  /// knows its depth but not what its ancestors were.
  static func planList(
    _ items: [MarkdownListItem], metrics: TerminalMetrics, nested: Bool
  ) -> [TermLine] {
    var lines: [TermLine] = []
    var gutterAtDepth: [Int] = []

    for item in items {
      let gutterCells = item.ordinal != nil ? 3 : 2
      if gutterAtDepth.count > item.depth { gutterAtDepth.removeSubrange(item.depth...) }
      while gutterAtDepth.count < item.depth { gutterAtDepth.append(2) }
      gutterAtDepth.append(gutterCells)
      let indent = gutterAtDepth.prefix(item.depth).reduce(0, +)

      let marker = item.ordinal.map { "\($0)." } ?? "-"
      lines += inlineBody(
        item.text, metrics: metrics, tone: .fg, columns: gutterCells, indent: indent,
        gutter: marker, gutterTone: .faint, nested: nested)
    }
    return lines
  }

  // MARK: - Wrapping

  /// Wrap a plain string into lines, marker on the first only.
  static func wrapBody(
    _ text: String, metrics: TerminalMetrics, gutter: String, gutterTone: TermTone = .dim,
    tone: TermTone = .fg, columns: Int = 2, indent: Int = 0, band: TermBand = .none,
    bold: Bool = false, italic: Bool = false, nested: Bool = false, pulsing: Bool = false
  ) -> [TermLine] {
    let extra = nested ? nestedIndentCells * metrics.cell : 0
    let cols = metrics.columns(gutter: columns, indent: indent, extra: extra)
    let wrapped = TerminalCells.wrapped(text, cols: cols)
    return wrapped.enumerated().map { offset, line in
      TermLine(
        gutter: offset == 0 ? gutter : "", gutterTone: gutterTone, text: line, tone: tone,
        columns: columns, indent: indent, band: band, bold: bold, italic: italic, nested: nested,
        pulsing: offset == 0 && pulsing)
    }
  }

  /// Wrap a string that carries inline markdown.
  ///
  /// The plain characters are what wraps and what is measured; the styled run is
  /// sliced at the *same* offsets, so the two can never describe different text.
  static func inlineBody(
    _ source: String, metrics: TerminalMetrics, tone: TermTone, columns: Int = 2, indent: Int = 0,
    gutter: String = "", gutterTone: TermTone = .dim, bold: Bool = false, nested: Bool = false
  ) -> [TermLine] {
    let styled = MarkdownInline.attributed(source)
    let plain = String(styled.characters)
    let extra = nested ? nestedIndentCells * metrics.cell : 0
    let cols = metrics.columns(gutter: columns, indent: indent, extra: extra)

    var out: [TermLine] = []
    var consumed = 0
    for (offset, line) in TerminalCells.wrapped(plain, cols: cols).enumerated() {
      let start = styled.index(styled.startIndex, offsetByCharacters: consumed)
      let end = styled.index(start, offsetByCharacters: line.count)
      out.append(
        TermLine(
          gutter: offset == 0 ? gutter : "", gutterTone: gutterTone, text: line,
          attributed: AttributedString(styled[start..<end]), tone: tone, columns: columns,
          indent: indent, bold: bold, nested: nested))
      // The wrap consumes the line plus whatever separated it from the next —
      // a newline, or the space a soft wrap fell on.
      consumed += line.count
      if consumed < plain.count { consumed += separatorLength(plain, at: consumed, next: line) }
    }
    return out
  }

  /// Wrapping drops nothing: a hard newline is one character, and a soft wrap
  /// falls on run of spaces that hangs at the end of the line. Walk forward over
  /// exactly what the wrapper skipped so the styled slice stays in step.
  private static func separatorLength(_ plain: String, at offset: Int, next: String) -> Int {
    let index = plain.index(plain.startIndex, offsetBy: offset)
    guard index < plain.endIndex else { return 0 }
    if plain[index] == "\n" { return 1 }
    var cursor = index
    var skipped = 0
    while cursor < plain.endIndex, plain[cursor] == " " {
      cursor = plain.index(after: cursor)
      skipped += 1
    }
    return skipped
  }

  /// A subagent's rows are stepped in behind a rule. Two cells, on the grid —
  /// the web client spends 14px here (a 2px border plus 12px of padding), which
  /// is the one place its own `ch` rule is set aside; on a grid we own outright
  /// there is no reason to inherit that.
  public static let nestedIndentCells: CGFloat = 2
}

extension String {
  /// Right-align a line number in its column.
  func leftPadded(to width: Int) -> String {
    count >= width ? self : String(repeating: " ", count: width - count) + self
  }
}
