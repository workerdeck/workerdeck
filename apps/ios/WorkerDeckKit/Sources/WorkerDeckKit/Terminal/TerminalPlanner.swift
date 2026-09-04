import Foundation

/// Turns one row into the lines it draws.
///
/// Every string here comes from the shared summary/preview functions rather
/// than being spelled locally, because the string *is* the height. See
/// `TerminalPlan.swift` for the design note.
public enum TerminalPlanner {

  // MARK: - Entry points

  /// The lines a row draws, in whatever state `expansion` says it is in.
  ///
  /// The expanded state is planned here rather than measured on screen — see
  /// `TerminalExpansion.swift` for why that inversion is forced on this
  /// renderer and not on the web one.
  ///
  /// **Called concurrently**, by `TerminalHeightBook.lineCounts`'s cold path
  /// (`DispatchQueue.concurrentPerform` over disjoint row indices). Everything
  /// below it must stay a pure function of `(row, metrics, expansion)` — no
  /// memo, no shared formatter or regex, no static `var`. That holds today and
  /// nothing but this sentence pins it; a cache added here would make the
  /// parallel build racy with no test that could see it.
  /// - Parameter frameParentId: set when these rows are a sub-agent's frame —
  ///   the takeover — and it is the id everything in them was produced inside.
  ///   Only the `nested` inset reads it (the port of web `Transcript.tsx`'s
  ///   `nestedClass`): inside the frame those items *are* the top level, and
  ///   stepping every row in would draw a rule down the whole surface saying
  ///   "this happened somewhere else" about the only thing on screen. It flows
  ///   through the planner rather than being a view concern because `nested`
  ///   spends cells, so it changes the wrap — and therefore the height.
  public static func plan(
    _ row: TranscriptRow, metrics: TerminalMetrics,
    expansion: TerminalExpansion = TerminalExpansion(), frameParentId: String? = nil
  ) -> [TermLine] {
    switch row {
    case .recap(let label):
      return wrapBody(
        "\(TermGlyph.recap) \(label)", metrics: metrics, gutter: "", tone: .faint, columns: 0)
    case .brief(let id, let text):
      // The frame's first row is the frame's own top level: never nested, and
      // `frameParentId` has nothing to say about a row no item produced.
      return planBrief(
        id: id, text: text, metrics: metrics, expansion: expansion, nested: false, inOpen: false)
    case .block(let block):
      return plan(block, metrics: metrics, expansion: expansion, frameParentId: frameParentId)
    }
  }

  public static func plan(
    _ block: TerminalBlock, metrics: TerminalMetrics,
    expansion: TerminalExpansion = TerminalExpansion(), inOpen: Bool = false,
    frameParentId: String? = nil
  ) -> [TermLine] {
    switch block {
    case .item(let leaf):
      return plan(
        item: leaf.item, metrics: metrics, expansion: expansion, inOpen: inOpen,
        frameParentId: frameParentId)
    case .run(let leaf):
      return planRun(
        leaf, metrics: metrics, expansion: expansion, inOpen: inOpen,
        frameParentId: frameParentId)
    case .task(let leaf):
      return planTask(leaf, metrics: metrics, expansion: expansion, inOpen: inOpen)
    }
  }

  /// A block that can sit inside a `Task`. Absorption is one level deep, so a
  /// leaf is all a task's child can be. No `frameParentId` here: a task never
  /// occurs inside a frame (nothing in a frame is top-level, so nothing
  /// absorbs), and a task's children are nested by definition.
  static func plan(
    leaf: TerminalLeafBlock, metrics: TerminalMetrics, expansion: TerminalExpansion, inOpen: Bool
  ) -> [TermLine] {
    switch leaf {
    case .item(let block):
      return plan(item: block.item, metrics: metrics, expansion: expansion, inOpen: inOpen)
    case .run(let block):
      return planRun(block, metrics: metrics, expansion: expansion, inOpen: inOpen)
    }
  }

  /// Is an item drawn stepped in behind the sub-agent rule? Its parent must
  /// exist — and not be the frame the row is already inside.
  static func isNested(_ parent: String?, frameParentId: String?) -> Bool {
    guard let parent else { return false }
    return parent != frameParentId
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
  static func planRun(
    _ block: TerminalRunBlock, metrics: TerminalMetrics, expansion: TerminalExpansion,
    inOpen: Bool, frameParentId: String? = nil
  ) -> [TermLine] {
    let run = block.run
    // The absence of a key *is* the run-of-one case: `expansionKey` is `nil`
    // exactly when there is no summary line to press, so the branch and the
    // rule are one thing rather than two that have to be kept in step.
    guard let key = block.expansionKey else {
      return run.first.map {
        planToolCall(
          $0, metrics: metrics, expansion: expansion, inOpen: inOpen,
          frameParentId: frameParentId)
      } ?? []
    }
    let busy = run.contains(where: callBusy)
    let failed = runFailed(run)
    let nested = isNested(run.first?.parentToolUseId, frameParentId: frameParentId)
    let open = expansion.isOpen(key)
    let wash = inOpen || open

    var lines = wrapBody(
      runSummary(run, busy: busy), metrics: metrics,
      gutter: busy ? TermGlyph.pulseRest : "", gutterTone: .mark,
      tone: failed ? .red : .dim, nested: nested, pulsing: busy,
      press: .toggle(key), inOpen: wash)
    guard open else { return lines }
    // No blank between them: `needsBlank` says two tool calls sit flush, and
    // that is exactly what the run is made of.
    for call in run {
      lines += planToolCall(
        call, metrics: metrics, expansion: expansion, inOpen: true,
        frameParentId: frameParentId)
    }
    return lines
  }

  /// One row for a `Task` and everything its subagent produced.
  ///
  /// **Always collapsed when unmounted**, and that is load-bearing rather than
  /// tidy: the live signal is *in* the collapsed line — the pulse, and a
  /// climbing tool count — never an auto-expansion that would resize the row
  /// under the reader.
  ///
  /// **The press is the takeover, not the toggle** — see
  /// ``TermPress/openSubagent(taskId:)`` for the divergence from the web
  /// client (there the row toggles and the takeover is a hover action; a thumb
  /// gets one target, and it gets the deliberate move). The open state is
  /// still planned in full: the audit checks both states, and a surface with
  /// nowhere to push (the preview harness) falls back to the inline toggle.
  static func planTask(
    _ block: TerminalTaskBlock, metrics: TerminalMetrics, expansion: TerminalExpansion,
    inOpen: Bool
  ) -> [TermLine] {
    let children = taskChildItems(block)
    let busy = taskBusy(block.task, children)
    let failed = taskFailed(block.task)
    let key = block.expansionKey
    let open = expansion.isOpen(key)
    let wash = inOpen || open

    // Green means sub-agent, exactly as it does on the scrubber's rail (see
    // `TerminalScrubberView`, and the argument in `packages/ui`'s
    // `terminal.css`): every other colour is already spoken for — blue is you,
    // white is the answer, red is an alarm, magenta is your bookmark, yellow is
    // the session waiting on you. The **body** takes it and the marker does
    // not: a green glyph already means "wrote to the workspace" on a settled
    // mutating tool, and one colour cannot mean two things in the same gutter.
    // Failure still outranks it — an alarm is not a category.
    var lines = wrapBody(
      taskSummary(block.task, children), metrics: metrics,
      gutter: busy ? TermGlyph.pulseRest : TermGlyph.bullet,
      gutterTone: failed ? .red : (busy ? .mark : .dim),
      tone: failed ? .red : .green, pulsing: busy,
      press: .openSubagent(taskId: block.task.id), inOpen: wash)
    guard open else { return lines }

    // The brief leads the children for the same reason it leads the frame: the
    // instruction, then the work (web `TaskRow` draws `BriefRow` first). Flush
    // under the header, as on the web — and absent entirely when the engine
    // gave none, which is the codex case: no row, not an empty one.
    let childHasBrief = taskChildItems(block).contains {
      if case .user = $0 { return true } else { return false }
    }
    if !childHasBrief, let brief = taskBrief(block.task) {
      lines += planBrief(
        id: block.task.id, text: brief, metrics: metrics, expansion: expansion, nested: true,
        inOpen: true)
    }

    // The children step themselves in: every one of them carries a
    // `parentToolUseId`, which is what `nested` is read from, so nothing here
    // has to know it is drawing inside a frame.
    for (position, child) in block.children.enumerated() {
      if position > 0, leafNeedsBlank(block.children[position - 1], child) {
        lines.append(TermLine(text: "", tone: .fg, nested: true, inOpen: true))
      }
      lines += plan(leaf: child, metrics: metrics, expansion: expansion, inOpen: true)
    }
    return lines
  }

  /// How many wrapped lines of a sub-agent's brief the collapsed row shows —
  /// the web's `BRIEF_LINES`, and the same judgement: a brief runs to thousands
  /// of characters, and an uncapped one buries the work it was asking for under
  /// its own instructions. Four is enough to recognise the task and short
  /// enough that the agent's first line stays on screen beside it.
  ///
  /// A **line** count, not a character budget — the divergence-from-the-web
  /// that `ResultPreview.collapsed(_:cols:)` needed does not arise here,
  /// because both clients already clip the brief on wrapped lines (the web with
  /// `line-clamp`, cutting on the very lines `briefPx` counts).
  public static let briefLines = 4

  /// **What the agent was asked** — the sub-agent's brief, clipped to
  /// ``briefLines`` and pressable for the whole of it. The port of web
  /// `BriefRow` (`TerminalTranscript.tsx`), drawn in the same two places: the
  /// takeover frame's first row (`TranscriptRow.brief`) and the head of the
  /// inline task expansion (``planTask``), with **one** open state between them
  /// (`ExpansionKey.brief`) where the web has two local `useState`s — this
  /// renderer's book must know every height, so the state lives beside the rows.
  ///
  /// The prompt's own marker in the sub-agent's colour, body dim: it is
  /// somebody's instruction, one level in, and not the human's turn — which is
  /// also why `promptRows` never indexes it.
  ///
  /// The clip is a slice of the **planner's own wrap**, so the collapsed and
  /// expanded heights are both exact by construction and the two states share
  /// every line they both show. Where the web's `line-clamp` fades the fourth
  /// line, a thumb needs a target that says what it does, so the clip is
  /// spelled the way a collapsed tool result spells it: a faint `… +N lines`
  /// carrying the same press. An unclipped brief draws no press at all — a
  /// target that visibly does nothing teaches the reader the theme is broken.
  static func planBrief(
    id: String, text: String, metrics: TerminalMetrics, expansion: TerminalExpansion,
    nested: Bool, inOpen: Bool
  ) -> [TermLine] {
    let extra = nested ? nestedIndentCells * metrics.cell : 0
    let cols = metrics.columns(gutter: 2, indent: 0, extra: extra)
    let all = TerminalCells.wrapped(text, cols: cols)

    let key = ExpansionKey.brief(id)
    let open = expansion.isOpen(key)
    let wash = inOpen || open
    let clipped = !open && all.count > briefLines
    let press: TermPress? = clipped || open ? .toggle(key) : nil
    let shown = clipped ? Array(all.prefix(briefLines)) : all

    var lines = shown.enumerated().map { offset, line in
      TermLine(
        gutter: offset == 0 ? TermGlyph.prompt : "", gutterTone: .dim,
        text: line.isEmpty ? " " : line, tone: .dim, nested: nested, press: press, inOpen: wash)
    }
    if clipped {
      let hidden = all.count - briefLines
      lines += wrapBody(
        "… +\(hidden) line\(hidden == 1 ? "" : "s")", metrics: metrics, gutter: "", tone: .faint,
        nested: nested, press: press, inOpen: wash)
    }
    return lines
  }

  // MARK: - Items

  static func plan(
    item: TranscriptItem, metrics: TerminalMetrics, expansion: TerminalExpansion, inOpen: Bool,
    frameParentId: String? = nil
  ) -> [TermLine] {
    let nested = isNested(parentToolUseId(of: item), frameParentId: frameParentId)

    switch item {
    case .user(_, let text, let attachments, _):
      var lines: [TermLine] = []
      if let attachments, !attachments.isEmpty {
        lines += wrapBody(
          attachments.map(\.name).joined(separator: ", "), metrics: metrics,
          gutter: TermGlyph.prompt, gutterTone: .dim, tone: .dim, band: .user, nested: nested,
          inOpen: inOpen)
      }
      // One row per hard line, with the marker on the first only — a pasted
      // twenty-line prompt is one prompt, not twenty.
      let markerOnFirst = lines.isEmpty
      lines += wrapBody(
        text.isEmpty ? " " : text, metrics: metrics,
        gutter: markerOnFirst ? TermGlyph.prompt : "", gutterTone: .dim, tone: .fg,
        band: .user, nested: nested, inOpen: inOpen)
      return lines

    case .assistantText(_, let text, _, _):
      return planMarkdown(
        text, metrics: metrics, gutter: TermGlyph.bullet, gutterTone: .fg, nested: nested,
        inOpen: inOpen)

    case .thinking(_, let text, _):
      return wrapBody(
        text, metrics: metrics, gutter: TermGlyph.thinking, gutterTone: .dim, tone: .dim,
        italic: true, nested: nested, inOpen: inOpen)

    case .toolCall(let call):
      return planToolCall(
        call, metrics: metrics, expansion: expansion, inOpen: inOpen,
        frameParentId: frameParentId)

    case .turnResult(_, let subtype, let isError, let durationMs, let totalCostUsd, let errors):
      // No glyph: a turn ending is not something anyone said.
      let head =
        "\(isError ? subtype : "done") · \(TermFmt.duration(ms: durationMs)) · \(TermFmt.cost(totalCostUsd))"
      var lines = wrapBody(
        head, metrics: metrics, gutter: "", tone: isError ? .red : .faint, inOpen: inOpen)
      for message in errors ?? [] {
        lines += wrapBody(message, metrics: metrics, gutter: "", tone: .red, inOpen: inOpen)
      }
      return lines

    case .notice(_, let level, let text):
      return wrapBody(
        text, metrics: metrics, gutter: TermGlyph.notice,
        gutterTone: level == .error ? .red : .yellow, tone: level == .error ? .red : .dim,
        inOpen: inOpen)

    case .compaction:
      return wrapBody(
        TermFmt.compaction, metrics: metrics, gutter: TermGlyph.compaction, gutterTone: .yellow,
        tone: .faint, nested: nested, inOpen: inOpen)

    case .fileDelivered(_, let path, let bytes, let description):
      var body = "\(path) · \(TermFmt.bytes(bytes))"
      if let description, !description.isEmpty { body += " · \(description)" }
      return wrapBody(
        body, metrics: metrics, gutter: TermGlyph.file, gutterTone: .blue, tone: .dim,
        inOpen: inOpen)
    }
  }

  /// A tool call: its header, then either the diff it produced or a preview of
  /// its result.
  ///
  /// **Three states, not two**, ported from the web client's `ToolRow` — and the
  /// middle one is the reason the budget exists at all. Collapsed shows a few
  /// lines; open shows the output up to ``ResultPreview/expandedChars``; `full`
  /// lifts that budget. A tool result can be a hundred thousand characters (a
  /// test run, a `find /`) and the whole of it lands in **one** virtual row —
  /// the collection view recycles rows, so it cannot help with what is inside a
  /// single one. Here the guard bites harder than it does on the web, because
  /// every one of those lines is planned and wrapped before anything is drawn.
  static func planToolCall(
    _ call: ToolCallItem, metrics: TerminalMetrics, expansion: TerminalExpansion, inOpen: Bool,
    frameParentId: String? = nil
  ) -> [TermLine] {
    let nested = isNested(call.parentToolUseId, frameParentId: frameParentId)
    let busy = callBusy(call)
    let tone = toolTone(call)
    let openKey = ExpansionKey.call(call.id)
    // Only a result has anything folded behind it. A call that produced none —
    // and a file edit that produced only a patch, which is already drawn — must
    // not advertise a press: a target that visibly does nothing when pressed is
    // worse than no target, because the reader concludes the whole theme is
    // broken rather than that this row is empty.
    let expandable = call.result.map { !$0.text.isEmpty } ?? false
    let open = expandable && expansion.isOpen(openKey)
    let full = expansion.isFull(callId: call.id)
    let wash = inOpen || open
    let press: TermPress? = expandable ? .toggle(openKey) : nil

    // `TodoWrite`'s parenthetical counts the checklist instead of echoing its
    // input: the input is the whole list, and "3/7 done" is what the reader
    // wants from a row they are not going to open.
    let todos = TerminalTodos.preview(name: call.name, input: call.input)
    let inputPreview = todos?.summary ?? TermFmt.toolInputPreview(call.input)
    // The title leads and the wire name follows it open, mirroring the web
    // terminal row: the label is what the reader is looking for, the name is
    // what a permission rule or an `allowedTools` entry has to spell.
    var header = "\(call.title ?? call.name)(\(inputPreview))"
    if call.title != nil, open { header += " · \(call.name)" }
    if let backend = call.backend, backend != "server" { header += " · \(backend)" }

    var lines = wrapBody(
      header, metrics: metrics, gutter: busy ? TermGlyph.pulseRest : TermGlyph.bullet,
      gutterTone: tone, tone: .fg, bold: true, nested: nested, pulsing: busy, press: press,
      inOpen: wash)

    // The pictures first, under the header and above whatever the call said in
    // words — the web client's order, and the one that reads right: a
    // screenshot is the result, and the prose beside it is a caption.
    //
    // Planned in **every** state, collapsed and expanded alike. That is a
    // deliberate divergence from the web client, where an expanded row is
    // mounted and self-measures so an image may reveal its intrinsic size; here
    // nothing self-measures, so a box that grew on expansion would be a frame
    // the layout got wrong. See `TerminalDivergences`.
    for (offset, image) in (call.result?.images ?? []).enumerated() {
      lines += planImageBox(
        image, callId: call.id, first: offset == 0, metrics: metrics, nested: nested,
        press: press, inOpen: wash)
    }

    // A file edit shows its diff, not its result prose: "The file has been
    // updated" is what the *model* needed to hear, and the change is what the
    // reader did. Opening the row is how you reach the text underneath.
    if let patch = call.patch, !open {
      lines += planDiff(patch, metrics: metrics, nested: nested, press: press, inOpen: wash)
      return lines
    }

    // The checklist stands in for the result preview, and only while collapsed —
    // opening the row is how you reach the prose underneath, exactly as a diff
    // gives way. Unlike the web client this is planned on the *same* condition
    // it is drawn on: here the plan is the height, so a checklist counted while
    // open would be a frame around lines nobody paints.
    if let todos, !open {
      for (offset, todo) in todos.shown.enumerated() {
        lines += wrapBody(
          TerminalTodos.line(todo), metrics: metrics,
          gutter: offset == 0 ? TermGlyph.output : "", gutterTone: .dim,
          tone: TerminalTodos.tone(todo.status), columns: 3, indent: 1, band: .output,
          nested: nested, press: press, inOpen: wash)
      }
      if let more = todos.more {
        lines += wrapBody(
          more, metrics: metrics, gutter: "", tone: .faint, columns: 3, indent: 1, band: .output,
          nested: nested, press: press, inOpen: wash)
      }
      return lines
    }

    guard let text = call.result?.text, !text.isEmpty else { return lines }
    let failed = callFailed(call)
    // The preview rows sit one level in behind the `⎿` marker: three gutter
    // cells and one indent level, six cells in all, so the character budget is
    // measured against the width they actually get.
    let previewCols = metrics.columns(
      gutter: 3, indent: 1, extra: nested ? nestedIndentCells * metrics.cell : 0)
    let all =
      text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
      .components(separatedBy: "\n")

    // The replay delivered a head. `full` then means "fetch the rest" rather than
    // "lift the clip", and the marker outlives the clip — a head short enough to
    // fit the open budget still is not the result.
    let truncated = call.result?.truncated == true
    let totalChars = call.result?.totalChars
    let fetching = truncated && expansion.isFetching(callId: call.id)

    var shown: [String]
    var more: String?
    var morePress: TermPress?
    if open {
      shown = full ? all : ResultPreview.clipToChars(all)
      let hidden = all.count - shown.count
      if fetching {
        // Never a row that visibly does nothing: while the rest is in flight it
        // says so, and names the size, because at this size the honest answer is
        // sometimes "don't". No press — a second one would open a second fetch.
        more = "… fetching \(TermFmt.grouped(totalChars ?? text.count)) chars"
      } else if truncated {
        more =
          "… +\(TermFmt.grouped(max(0, (totalChars ?? text.count) - text.count))) chars — fetch the rest"
        morePress = .expandFull(callId: call.id)
      } else if hidden > 0 {
        // The affordance says what pressing it costs, because at this size the
        // honest answer is sometimes "don't".
        more =
          "… +\(hidden) line\(hidden == 1 ? "" : "s") — show all \(TermFmt.grouped(text.count)) chars"
        morePress = .expandFull(callId: call.id)
      }
    } else {
      let collapsed = ResultPreview.collapsed(all, cols: previewCols, totalChars: totalChars)
      shown = collapsed.shown
      // Collapsed, the count is a label and not a second control: the header
      // above is already the toggle, and this line carries the same press so
      // the block stays one target.
      more = collapsed.more
      morePress = press
    }

    for (offset, line) in shown.enumerated() {
      lines += wrapBody(
        line.isEmpty ? " " : line, metrics: metrics,
        gutter: offset == 0 ? TermGlyph.output : "", gutterTone: failed ? .red : .dim,
        tone: failed ? .red : .dim, columns: 3, indent: 1, band: .output, nested: nested,
        press: press, inOpen: wash)
    }
    if let more {
      lines += wrapBody(
        more, metrics: metrics, gutter: "", tone: .faint, columns: 3, indent: 1, band: .output,
        nested: nested, press: morePress, inOpen: wash)
    }
    return lines
  }

  /// One image's box: exactly ``TermImage/boxLines`` planned lines, the first
  /// carrying the address and the rest reserving the grid under it.
  ///
  /// The lines hold a space rather than an empty string for the reason the
  /// result preview does: a trailing empty paragraph is a line fragment the
  /// text system may or may not produce, and the height claim cannot rest on
  /// which. Nothing of them is visible — the box is drawn over them — but they
  /// are what makes `lines.count × line` the box's height by construction, so
  /// the placeholder, the picture and the failure notice are the same size and
  /// a fetch landing can never reflow the transcript.
  ///
  /// `⎿` on the first box only: it says "this call produced output", and one
  /// marker per screenshot would be a column of them down a call that returned
  /// four.
  static func planImageBox(
    _ image: ToolResultImageRef, callId: String, first: Bool, metrics: TerminalMetrics,
    nested: Bool, press: TermPress?, inOpen: Bool
  ) -> [TermLine] {
    let box = TermImageBox(
      toolUseId: callId, sourceSeq: image.sourceSeq, partIndex: image.partIndex,
      mediaType: image.mediaType, bytes: image.bytes)
    return (0..<box.lines).map { offset in
      TermLine(
        gutter: first && offset == 0 ? TermGlyph.output : "", gutterTone: .dim, text: " ",
        tone: .dim, columns: 3, indent: 1, nested: nested, press: press,
        image: offset == 0 ? box : nil, inOpen: inOpen)
    }
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
  static func planDiff(
    _ patch: FilePatch, metrics: TerminalMetrics, nested: Bool, press: TermPress? = nil,
    inOpen: Bool = false
  ) -> [TermLine] {
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
            nested: nested, press: press, inOpen: inOpen))
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
          tone: tone, columns: columns, indent: 2, band: band, nested: nested, press: press,
          inOpen: inOpen)
      }
    }
    if patch.truncated == true {
      lines += wrapBody(
        "… hunks omitted", metrics: metrics, gutter: "", tone: .faint, columns: columns,
        indent: 2, nested: nested, press: press, inOpen: inOpen)
    }
    return lines
  }

  // MARK: - Markdown

  /// Assistant prose, block by block, with one blank line between blocks — the
  /// theme's only spacing.
  static func planMarkdown(
    _ source: String, metrics: TerminalMetrics, gutter: String, gutterTone: TermTone,
    nested: Bool, inOpen: Bool = false
  ) -> [TermLine] {
    var lines: [TermLine] = []
    var first = true

    func emit(_ produced: [TermLine]) {
      guard !produced.isEmpty else { return }
      if !first { lines.append(TermLine(text: "", tone: .fg, nested: nested, inOpen: inOpen)) }
      first = false
      lines += produced
    }

    for block in MarkdownBlocks.parse(source) {
      switch block {
      case .prose(let text):
        emit(inlineBody(text, metrics: metrics, tone: .fg, nested: nested, inOpen: inOpen))
      case .heading(_, let text):
        // A terminal marks a heading by weight, never by size: there is one line
        // height, and a bigger glyph would break the grid it is drawn on.
        emit(
          inlineBody(
            text, metrics: metrics, tone: .bright, bold: true, nested: nested, inOpen: inOpen))
      case .blockquote(let text):
        emit(
          inlineBody(
            text, metrics: metrics, tone: .dim, indent: 1, nested: nested, inOpen: inOpen))
      case .thematicBreak:
        emit([TermLine(text: "", tone: .faint, nested: nested, inOpen: inOpen)])
      case .code(let language, let text, _):
        _ = language
        var produced: [TermLine] = []
        for line in text.components(separatedBy: "\n") {
          produced += wrapBody(
            line.isEmpty ? " " : line, metrics: metrics, gutter: "", tone: .dim, indent: 1,
            band: .output, nested: nested, inOpen: inOpen)
        }
        emit(
          produced.isEmpty
            ? [TermLine(text: " ", tone: .dim, band: .output, nested: nested, inOpen: inOpen)]
            : produced)
      case .list(let items):
        emit(planList(items, metrics: metrics, nested: nested, inOpen: inOpen))
      }
    }

    guard !lines.isEmpty else {
      return [
        TermLine(
          gutter: gutter, gutterTone: gutterTone, text: "", tone: .fg, nested: nested,
          inOpen: inOpen)
      ]
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
    _ items: [MarkdownListItem], metrics: TerminalMetrics, nested: Bool, inOpen: Bool = false
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
        gutter: marker, gutterTone: .faint, nested: nested, inOpen: inOpen)
    }
    return lines
  }

  // MARK: - Wrapping

  /// Wrap a plain string into lines, marker on the first only.
  static func wrapBody(
    _ text: String, metrics: TerminalMetrics, gutter: String, gutterTone: TermTone = .dim,
    tone: TermTone = .fg, columns: Int = 2, indent: Int = 0, band: TermBand = .none,
    bold: Bool = false, italic: Bool = false, nested: Bool = false, pulsing: Bool = false,
    press: TermPress? = nil, inOpen: Bool = false
  ) -> [TermLine] {
    let extra = nested ? nestedIndentCells * metrics.cell : 0
    let cols = metrics.columns(gutter: columns, indent: indent, extra: extra)
    let wrapped = TerminalCells.wrapped(text, cols: cols)
    return wrapped.enumerated().map { offset, line in
      TermLine(
        gutter: offset == 0 ? gutter : "", gutterTone: gutterTone, text: line, tone: tone,
        columns: columns, indent: indent, band: band, bold: bold, italic: italic, nested: nested,
        pulsing: offset == 0 && pulsing, press: press, inOpen: inOpen)
    }
  }

  /// Wrap a string that carries inline markdown.
  ///
  /// The plain characters are what wraps and what is measured; the styled run is
  /// sliced at the *same* offsets, so the two can never describe different text.
  static func inlineBody(
    _ source: String, metrics: TerminalMetrics, tone: TermTone, columns: Int = 2, indent: Int = 0,
    gutter: String = "", gutterTone: TermTone = .dim, bold: Bool = false, nested: Bool = false,
    press: TermPress? = nil, inOpen: Bool = false
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
          indent: indent, bold: bold, nested: nested, press: press, inOpen: inOpen))
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
