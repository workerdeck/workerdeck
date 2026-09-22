import Foundation
import Testing

@testable import WorkerDeckKit

/// The tracked shell: the record, the row it draws as, the list rule and the
/// composer's `$`. The mirrors of `packages/protocol`'s `ShellInfo` +
/// `promotedShells`, `packages/react`'s shell item and
/// `packages/ui`'s `shell-row.ts`.
@Suite("Shells")
struct ShellTests {
  private func shell(
    id: String = "sh_abc123", status: ShellStatus = .running, startedAt: Double = 1_000,
    endedAt: Double? = nil, exitCode: Int? = nil, endReason: ShellEndReason? = nil,
    command: String = "npm test", label: String = "npm test"
  ) -> ShellInfo {
    ShellInfo(
      id: id, sessionId: "sess-1", ordinal: 3, command: command, label: label, cwd: "/work",
      status: status, startedAt: startedAt, endedAt: endedAt, exitCode: exitCode,
      endReason: endReason, bytes: 42)
  }

  private func event(_ seq: Int, uuid: String, text: String, shell: ShellInfo, replay: Bool? = nil)
    -> SessionEvent
  {
    SessionEvent(
      seq: seq, ts: 1_722_300_000_000,
      body: .userMessage(
        UserMessageEvent(
          message: ApiMessage(role: "user", content: .text(text)), replay: replay,
          synthetic: true, uuid: uuid, shell: shell)))
  }

  private func row(_ state: TranscriptState) -> ShellItem? {
    for item in state.items {
      if case .shell(let row) = item { return row }
    }
    return nil
  }

  // MARK: - The record

  @Test func decodesAShellRecordOffAUserMessage() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(
        #"""
        {"type":"user_message","seq":9,"ts":1722300000000,"uuid":"row-1","synthetic":true,
         "message":{"role":"user","content":"<local-command-stdout>$ ls\nREADME.md\n[exit 0]</local-command-stdout>"},
         "shell":{"id":"sh_abc","sessionId":"sess-1","ordinal":1,"command":"ls","label":"ls",
          "cwd":"/work","owner":"user","status":"exited","startedAt":1000,"endedAt":1200,
          "exitCode":0,"endReason":"exit","bytes":11,"cols":120,"rows":40}}
        """#.utf8))
    guard case .userMessage(let payload) = event.body, let shell = payload.shell else {
      Issue.record("expected a user_message carrying a shell, got \(event.body)")
      return
    }
    #expect(shell.id == "sh_abc")
    #expect(shell.ordinal == 1)
    #expect(shell.owner == .user)
    #expect(shell.status == .exited)
    #expect(shell.endReason == .exit)
    #expect(shell.exitCode == 0)
    #expect(shell.capped == nil)
  }

  /// The one lenient union in the mirror. A reason this build has never heard of
  /// must read as `.unknown`, because the alternative is a failed decode that
  /// takes the whole message down - and widening the Swift side later would cost
  /// a `PROTOCOL_VERSION` bump.
  @Test func anUnknownEndReasonFallsBackRatherThanThrowing() throws {
    let decoded = try JSONDecoder().decode(
      ShellInfo.self,
      from: Data(
        #"""
        {"id":"sh_x","sessionId":"sess-1","ordinal":2,"command":"sleep 9","label":"sleep 9",
         "cwd":"/work","owner":"agent","status":"exited","startedAt":1000,"endedAt":2000,
         "endReason":"evicted_by_the_future","bytes":0,"cols":120,"rows":40}
        """#.utf8))
    #expect(decoded.endReason == .unknown)
    #expect(decoded.owner == .agent)
    let item = ShellItem(id: "row", shell: decoded, text: "")
    #expect(TerminalShell.statusText(item) == "ended")
  }

  /// A record this build cannot parse at all degrades to the local-command
  /// notice every older client already draws - never to a lost message.
  @Test func anUndecodableShellLeavesTheMessageStanding() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(
        #"""
        {"type":"user_message","seq":9,"ts":1722300000000,"uuid":"row-1","synthetic":true,
         "message":{"role":"user","content":"<local-command-stdout>hi</local-command-stdout>"},
         "shell":{"id":"sh_abc","status":"suspended"}}
        """#.utf8))
    guard case .userMessage(let payload) = event.body else {
      Issue.record("expected a user_message, got \(event.body)")
      return
    }
    #expect(payload.shell == nil)
    let state = applyEvent(.initial, event)
    #expect(state.items == [.notice(id: "row-1", level: .info, text: "hi")])
  }

  // MARK: - The row

  @Test func theRowDropsTheCommandLineTheEndLineAndTheOmissionLine() {
    let text = """
      <local-command-stdout>$ npm test
      one
      two [...]
      [... more output ...]
      three
      [exit 1]</local-command-stdout>
      """
    let extracted = shellRowText(
      shell(status: .exited, endedAt: 2_000, exitCode: 1, endReason: .exit), text)
    #expect(extracted.text == "one\ntwo [...]\nthree")
    #expect(extracted.truncated)
  }

  /// A running shell has no end line yet, and nothing may be eaten in its place.
  @Test func aRunningRowKeepsEveryLineItWasGiven() {
    let extracted = shellRowText(
      shell(), "<local-command-stdout>$ npm run dev\nready\n[exit 0]</local-command-stdout>")
    #expect(extracted.text == "ready\n[exit 0]")
    #expect(!extracted.truncated)
  }

  @Test func theRowUpsertsUnderOneUuidAcrossReEmits() {
    var state = applyEvent(
      .initial,
      event(1, uuid: "row-1", text: "<local-command-stdout>$ npm test\nstarting</local-command-stdout>", shell: shell()))
    #expect(state.items.count == 1)
    #expect(row(state)?.shell.status == .running)

    state = applyEvent(
      state,
      event(
        2, uuid: "row-1",
        text: "<local-command-stdout>$ npm test\nstarting\ndone\n[exit 0]</local-command-stdout>",
        shell: shell(status: .exited, endedAt: 2_000, exitCode: 0, endReason: .exit)))
    // One row, not two: the second emission settles the first in place.
    #expect(state.items.count == 1)
    #expect(row(state)?.shell.status == .exited)
    #expect(row(state)?.text == "starting\ndone")
  }

  @Test func aReEmitCarriesWhatTheReaderExpanded() {
    var state = applyEvent(
      .initial,
      event(1, uuid: "row-1", text: "<local-command-stdout>$ npm test\nhead</local-command-stdout>", shell: shell()))
    state = hydrateShellOutput(state, shellId: "sh_abc123", text: "head\nand\neverything")
    #expect(row(state)?.expanded == "head\nand\neverything")

    state = applyEvent(
      state,
      event(
        2, uuid: "row-1", text: "<local-command-stdout>$ npm test\nhead\nmore</local-command-stdout>",
        shell: shell()))
    #expect(state.items.count == 1)
    #expect(row(state)?.text == "head\nmore")
    #expect(row(state)?.expanded == "head\nand\neverything")
  }

  @Test func aVerifiedRowTakesTheGatewaysRecordAndA404SaysSo() {
    var state = applyEvent(
      .initial, event(1, uuid: "row-1", text: "<local-command-stdout>$ npm test\n</local-command-stdout>", shell: shell()))
    state = hydrateShellRow(
      state, shellId: "sh_abc123",
      shell: shell(status: .exited, endedAt: 2_000, endReason: .serverRestarted))
    #expect(row(state)?.shell.endReason == .serverRestarted)
    #expect(row(state)?.missing == false)

    state = hydrateShellRow(state, shellId: "sh_abc123", shell: nil)
    #expect(row(state)?.missing == true)
    #expect(
      TerminalShell.footerText(row(state)!, open: false, shown: 0) == TerminalShell.missing)
  }

  @Test func aHydrationForAnUnknownShellChangesNothing() {
    let state = applyEvent(
      .initial, event(1, uuid: "row-1", text: "<local-command-stdout>$ npm test\n</local-command-stdout>", shell: shell()))
    #expect(hydrateShellRow(state, shellId: "sh_other", shell: nil) == state)
    #expect(hydrateShellOutput(state, shellId: "sh_other", text: "x") == state)
  }

  // MARK: - What the row says

  @Test func theHeaderNamesTheCommandAndTheStatus() {
    let running = ShellItem(id: "row", shell: shell(), text: "")
    #expect(TerminalShell.headerText(running) == "npm test · running")
    #expect(!TerminalShell.failed(running))

    let failed = ShellItem(
      id: "row", shell: shell(status: .exited, endedAt: 2_000, exitCode: 1, endReason: .exit),
      text: "")
    #expect(TerminalShell.headerText(failed) == "npm test · exit 1")
    #expect(TerminalShell.failed(failed))
  }

  /// A gateway that stopped cleanly killed the process; one that was restarted
  /// underneath it did not, and the copy must not claim otherwise.
  @Test func theLifecycleReasonsReadHonestly() {
    func text(_ reason: ShellEndReason) -> String {
      TerminalShell.statusText(
        ShellItem(
          id: "row", shell: shell(status: .exited, endedAt: 2_000, endReason: reason), text: ""))
    }
    #expect(text(.killed) == "killed")
    #expect(text(.timeout) == "timed out")
    #expect(text(.serverStopped) == "killed: the gateway stopped")
    #expect(text(.serverRestarted).contains("may still be running"))
    #expect(text(.spawnFailed) == "failed to start")
  }

  @Test func aLabellessRecordFallsBackToTheCommandsFirstLine() {
    let item = ShellItem(
      id: "row", shell: shell(command: "npm test\n--watch", label: ""), text: "")
    #expect(TerminalShell.label(item) == "npm test")
  }

  /// The ordinal is what "shell #3" means to a person, and the long reading is
  /// the only place there is room for it.
  @Test func theTitleCarriesTheOrdinal() {
    #expect(TerminalShell.title(shell()) == "#3 npm test")
  }

  @Test func theFooterSaysWhatExpandingWillDoAndWhatItClipped() {
    let head = ShellItem(id: "row", shell: shell(), text: "one\ntwo", truncated: true)
    #expect(TerminalShell.footerText(head, open: false, shown: 2)?.contains("expand") == true)
    #expect(TerminalShell.footerText(head, open: true, shown: 2)?.contains("fetching") == true)

    var expanded = head
    expanded.expanded = "one\ntwo\nthree\nfour"
    #expect(TerminalShell.bodyLines(expanded, open: true).count == 4)
    #expect(TerminalShell.footerText(expanded, open: true, shown: 2) == "… +2 lines not shown")
    #expect(TerminalShell.footerText(expanded, open: true, shown: 4) == nil)

    let whole = ShellItem(id: "row", shell: shell(), text: "one")
    #expect(TerminalShell.footerText(whole, open: false, shown: 1) == nil)
  }

  // MARK: - The plan

  private var metrics: TerminalMetrics { TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13) }

  @Test func theRowDrawsAHeaderTheInlineLinesAndOneAffordance() {
    let body = (1...20).map { "line \($0)" }.joined(separator: "\n")
    let item = ShellItem(id: "row", shell: shell(), text: body, truncated: true)
    let lines = TerminalPlanner.plan(
      item: .shell(item), metrics: metrics, expansion: TerminalExpansion(), inOpen: false)
    #expect(lines.first?.gutter == TerminalShell.glyph)
    #expect(lines.first?.text == "npm test · running")
    // Header + SHELL_INLINE_LINES of body + the affordance + the kill line.
    #expect(lines.count == 1 + WorkerProtocol.shellInlineLines + 2)
    #expect(lines.last?.text == TerminalShell.killActionText)
  }

  /// A running row's header opens the live terminal - the useful move, and the
  /// place the reader can watch what they are about to stop - while the kill is
  /// a line of its own. Two intents never share one line: this renderer presses
  /// whole wrapped lines, so a second target inside one would be a coin toss.
  /// Everything between them toggles, so an open row is still reachable.
  @Test func theRunningHeaderOpensTheTerminalAndTheLastLineKills() {
    let item = ShellItem(id: "row", shell: shell(), text: "one", truncated: false)
    let running = TerminalPlanner.plan(
      item: .shell(item), metrics: metrics, expansion: TerminalExpansion(), inOpen: false)
    #expect(running.first?.press == .openShell(shellId: "sh_abc123"))
    #expect(running.last?.press == .killShell(shellId: "sh_abc123"))
    #expect(running.dropFirst().dropLast().allSatisfy { $0.press == .toggle(.shell("sh_abc123")) })

    var exited = item
    exited.shell = shell(status: .exited, endedAt: 2_000, exitCode: 0, endReason: .exit)
    let settled = TerminalPlanner.plan(
      item: .shell(exited), metrics: metrics, expansion: TerminalExpansion(), inOpen: false)
    // No terminal to open and no process to stop: an ended row is uniform.
    #expect(settled.allSatisfy { $0.press == .toggle(.shell("sh_abc123")) })
    #expect(!settled.contains { $0.text == TerminalShell.killActionText })
  }

  @Test func anOpenRowDrawsTheFetchedTextAndTheBlockCarriesItsKey() {
    var item = ShellItem(id: "row", shell: shell(), text: "one", truncated: true)
    item.expanded = (1...40).map { "line \($0)" }.joined(separator: "\n")
    let expansion = TerminalExpansion(open: [.shell("sh_abc123")])
    let lines = TerminalPlanner.plan(
      item: .shell(item), metrics: metrics, expansion: expansion, inOpen: false)
    // Header + the 40 fetched lines + the running row's kill line.
    #expect(lines.count == 1 + 40 + 1)
    #expect(lines.allSatisfy { $0.inOpen })

    let blocks = terminalBlocks([.shell(item)])
    #expect(expansionKeys(of: blocks[0]) == [.shell("sh_abc123")])
  }

  // MARK: - The session list

  @Test func promotedShellsKeepsWhatIsWorthALine() {
    func info(_ shells: [ShellInfo]) -> SessionInfo {
      SessionInfo(
        id: "sess-1", status: .idle, cwd: "/work", createdAt: 0, lastSeq: 0,
        pendingPermissionCount: 0, shells: shells)
    }
    let now: Double = 100_000
    let young = shell(id: "young", startedAt: now - 500)
    let long = shell(id: "long", startedAt: now - 10_000)
    let quickFail = shell(
      id: "quick", status: .exited, startedAt: now - 1_500, endedAt: now - 1_000, exitCode: 1)
    let slowFail = shell(
      id: "slow", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000, exitCode: 1)
    let oldFail = shell(
      id: "old", status: .exited, startedAt: now - 200_000, endedAt: now - 90_000, exitCode: 1)
    let cleanExit = shell(
      id: "clean", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000, exitCode: 0)
    let killed = shell(
      id: "killed", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
      endReason: .killed)

    let restarted = shell(
      id: "restarted", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
      endReason: .serverRestarted)

    let promoted = promotedShells(
      info([young, long, quickFail, slowFail, oldFail, cleanExit, killed, restarted]), now: now)
    #expect(promoted.map(\.id) == ["long", "slow"])
    #expect(promotedShells(info([]), now: now).isEmpty)
  }

  /// The linger is for a failure the operator has not been told about. A shell
  /// they killed, and one a restart reconciled, both report **no exit code at
  /// all** - and reading "not zero" as "failed" kept each of them on the card
  /// for a minute wearing a failure's colour.
  @Test func neitherAKillNorARestartLingersOnTheCard() {
    func info(_ shells: [ShellInfo]) -> SessionInfo {
      SessionInfo(
        id: "sess-1", status: .idle, cwd: "/work", createdAt: 0, lastSeq: 0,
        pendingPermissionCount: 0, shells: shells)
    }
    let now: Double = 100_000
    for reason in [ShellEndReason.killed, .serverStopped, .serverRestarted] {
      let ended = shell(
        id: "sh", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
        endReason: reason)
      #expect(promotedShells(info([ended]), now: now).isEmpty)
    }
  }

  // MARK: - The composer

  @Test func dollarEntersShellModeAndBangIsJustText() {
    #expect(
      TerminalShell.composerTrigger(character: "$", isShellMode: false, canRunShell: true)
        == .enter)
    #expect(
      TerminalShell.composerTrigger(character: "!", isShellMode: false, canRunShell: true)
        == .pass)
    // Nothing to enter when the gateway does not offer it.
    #expect(
      TerminalShell.composerTrigger(character: "$", isShellMode: false, canRunShell: false)
        == .pass)
    // Already in the mode, a typed `$` is the first character of the command.
    #expect(
      TerminalShell.composerTrigger(character: "$", isShellMode: true, canRunShell: true) == .pass)
  }

  @Test func backspaceOnAnEmptyPromptLeavesTheModeAndTheFieldEmpty() {
    #expect(
      TerminalShell.composerTrigger(character: "", isShellMode: true, canRunShell: true) == .leave)
    #expect(
      TerminalShell.composerTrigger(character: "", isShellMode: false, canRunShell: true) == .pass)
  }

  /// The deliberate exit is the other one: Escape on a keyboard, the gutter `$`
  /// on a phone, and it puts the swallowed character back.
  @Test func theDeliberateExitPutsTheDollarBack() {
    #expect(TerminalShell.exitDraft("ls -la") == "$ls -la")
    #expect(TerminalShell.exitDraft("") == "$")
  }
}
