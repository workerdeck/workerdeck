import XCTest

// The Rust core preview over `CoreReplayFixture` (60 turns, Bash output folded at 30 lines), no gateway behind it.
// Jumps go through the catch-up bar and the rail, never long swipe runs; what a jump lands on is a Rust test.
final class CoreTranscriptUITests: XCTestCase {
  @MainActor
  func testCatchUpRailStickyAndPress() throws {
    let app = launchPreview("core", ["UIPREVIEW_RECAP": "147"])

    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open on its tail")
    let bar = app.descendants(matching: .any)["catch-up-bar"]
    XCTAssertTrue(bar.waitForExistence(timeout: 5), "no catch-up bar over a recap")
    snap(app, "1-tail")
    bar.buttons["jump"].tap()
    XCTAssertTrue(text(app, containing: "※").waitForExistence(timeout: 3), "jump did not reach the seam")
    snap(app, "2-recap")
    bar.buttons["dismiss"].tap()
    XCTAssertTrue(bar.waitForNonExistence(timeout: 3), "dismiss left the bar up")

    let rail = app.descendants(matching: .any)["scrubber-rail"].firstMatch
    XCTAssertTrue(rail.exists, "no rail beside the transcript")
    rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    XCTAssertTrue(text(app, containing: "Turn 1:").waitForExistence(timeout: 5), "a press at the rail's top did not reach turn 1")
    snap(app, "3-top")

    for _ in 0..<6 { app.swipeUp(velocity: .slow) }
    let sticky = app.descendants(matching: .any)["Go to this prompt"]
    XCTAssertTrue(sticky.waitForExistence(timeout: 3), "no sticky prompt mid-transcript")
    snap(app, "4-sticky")

    let call = app.textViews.matching(NSPredicate(format: "value CONTAINS 'ls batch-'")).allElementsBoundByIndex
      .first { $0.isHittable && $0.frame.minY > 160 }
    let row = try XCTUnwrap(call, "no Bash row on screen")
    let value = row.value as? String ?? ""
    let turn = try XCTUnwrap(
      value.firstMatch(of: /ls batch-(\d+)/).map { String($0.1) }, "no turn number in \(value)")
    XCTAssertFalse(text(app, containing: "output line 10 of turn \(turn)").exists)
    row.tap()
    XCTAssertTrue(
      text(app, containing: "output line 10 of turn \(turn)").waitForExistence(timeout: 5),
      "pressing the Bash row of turn \(turn) did not open it")
    snap(app, "5-opened")

    let pinned = try XCTUnwrap(
      (sticky.textViews.firstMatch.value as? String)?.firstMatch(of: /Turn \d+:/).map { String($0.0) },
      "the sticky strip carries no prompt")
    sticky.tap()
    XCTAssertTrue(text(app, containing: pinned).waitForExistence(timeout: 3))
    let moved = NSPredicate { _, _ in
      !(sticky.exists && (sticky.textViews.firstMatch.value as? String)?.contains(pinned) == true)
    }
    XCTAssertEqual(
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: moved, object: nil)], timeout: 3), .completed,
      "the strip still pins \(pinned) after jumping to it")
    snap(app, "6-sticky-tapped")
  }

  // The fixture's last row is a running shell answered in-process: an 80-line scrollback, echoed input, a listing on
  // Enter, and a kill that reports it exited.
  @MainActor
  func testCoreShellOpensTypesScrollsAndKills() throws {
    let app = launchPreview("core")

    let header = text(app, containing: "npm run dev ·")
    XCTAssertTrue(header.waitForExistence(timeout: 20), "no shell row at the tail")
    let screen = app.descendants(matching: .any)["shell-screen"]
    for _ in 0..<3 where !screen.exists {
      header.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 8)).tap()
      _ = screen.waitForExistence(timeout: 2)
    }
    XCTAssertTrue(screen.exists, "pressing the running shell did not open its screen")
    XCTAssertTrue(wait(screen, contains: "boot 080"), "the attach scrollback never drew")
    XCTAssertEqual(app.staticTexts["shell-status"].label, "running")
    snap(app, "shell-2-open")

    screen.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "tapping the shell raised no keyboard")
    app.typeText("ls\n")
    XCTAssertTrue(wait(screen, contains: "file-a"), "typed input never reached the fixture shell")

    app.buttons["Hide keyboard"].tap()
    for _ in 0..<8 where !(screen.value as? String ?? "").contains("boot 001") {
      screen.swipeDown(velocity: .fast)
    }
    XCTAssertTrue(wait(screen, contains: "boot 001"), "dragging down never reached the top of the scrollback")
    snap(app, "shell-4-scrolled")

    app.navigationBars.buttons["Kill"].tap()
    app.sheets.buttons["Kill"].firstMatch.tap()
    let status = app.staticTexts["shell-status"]
    let ended = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != 'running'"), object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [ended], timeout: 5), .completed, "the kill never ended the shell")

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(header.waitForExistence(timeout: 5), "back did not return to the transcript")
    XCTAssertFalse(screen.exists)
  }

  // Turn 56 hands its work to a sub-agent with 40 Bash steps (step 25 fails): the takeover folds them, its rail jumps,
  // and its rows carry the same long-press menu as the session's.
  @MainActor
  func testCoreSubagentTakeover() throws {
    let app = launchPreview("core")

    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open on its tail")
    let task = text(app, containing: "Survey every batch")
    XCTAssertTrue(scroll(app, until: task, swipes: 20), "no Task row near the tail")
    let frame = app.descendants(matching: .any)["frame-screen"]
    for _ in 0..<3 where !frame.exists {
      task.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 8)).tap()
      _ = frame.waitForExistence(timeout: 2)
    }
    XCTAssertTrue(frame.exists, "pressing the Task row opened no takeover")
    let folded = text(app, containing: "Ran 40 shell commands")
    XCTAssertTrue(folded.waitForExistence(timeout: 5), "the takeover shows no folded steps")
    let brief = text(app, containing: "Count the files in every batch")
    XCTAssertTrue(brief.exists, "the takeover shows no brief")
    XCTAssertFalse(text(app, containing: "Turn 60:").exists, "the takeover shows session rows")
    snap(app, "frame-1-open")

    brief.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3), "no row menu inside the takeover")
    app.buttons["Copy"].tap()

    folded.tap()
    XCTAssertTrue(text(app, containing: "agent step 1)").waitForExistence(timeout: 5), "pressing the fold did not open the steps")
    XCTAssertTrue(
      scroll(app, until: text(app, containing: "agent step 40"), swipes: 20, down: false),
      "the opened steps do not reach step 40")
    snap(app, "frame-2-expanded-tail")

    let frameRail = frame.descendants(matching: .any)["scrubber-rail"].firstMatch
    XCTAssertTrue(frameRail.exists, "no rail in the takeover")
    frameRail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    XCTAssertTrue(brief.waitForExistence(timeout: 5) && brief.isHittable, "a press at the takeover rail's top did not reach the brief")

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(task.waitForExistence(timeout: 5), "back did not return to the session")
    XCTAssertFalse(frame.exists)
  }

  // `$` in an empty draft enters shell mode (the fixture attaches with `shell: true`); the `$` cell leaves it, and a
  // command runs as one more shell row.
  @MainActor
  func testCoreComposerShellMode() throws {
    let app = launchPreview("core")

    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open on its tail")
    let message = app.textViews["Message"]
    XCTAssertTrue(message.waitForExistence(timeout: 5), "no composer")
    message.tap()
    app.typeText("$")
    let leave = app.buttons["Leave shell mode"]
    XCTAssertTrue(leave.waitForExistence(timeout: 3), "a $ did not enter shell mode")
    app.typeText("pwd")
    leave.tap()
    XCTAssertFalse(leave.exists, "the $ cell did not leave shell mode")
    let draft = app.descendants(matching: .any)["Message"].firstMatch
    XCTAssertEqual(draft.value as? String, "$pwd", "leaving shell mode did not keep the draft behind a $")

    draft.tap()
    app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
    app.typeText("$ls -la")
    XCTAssertTrue(leave.waitForExistence(timeout: 3), "a $ in a cleared draft did not enter shell mode")
    app.buttons["Run"].tap()
    XCTAssertTrue(text(app, containing: "ran-ok").waitForExistence(timeout: 5), "the command never landed as a shell row")
    XCTAssertFalse(leave.exists, "running a command did not leave shell mode")
    snap(app, "composer-3-ran")
  }
}
