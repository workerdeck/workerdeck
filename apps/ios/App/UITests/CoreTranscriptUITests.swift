import XCTest

// The Rust core preview over `CoreReplayFixture` (60 turns, Bash output folded at 30 lines), no gateway behind it.
final class CoreTranscriptUITests: XCTestCase {
  @MainActor
  func testCoreTranscriptScrollsFillsPressesAndPins() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launchEnvironment["UIPREVIEW_RECAP"] = "147"
    app.launch()

    let tail = text(app, containing: "Turn 60:")
    XCTAssertTrue(tail.waitForExistence(timeout: 20), "the session did not open on its tail")
    snap(app, "1-tail")
    attach(app.debugDescription, "tail-hierarchy")

    let recap = text(app, containing: "※")
    XCTAssertTrue(scroll(app, until: recap, swipes: 30, down: true), "no recap row above the tail")
    snap(app, "2-recap")

    let first = text(app, containing: "Turn 1:")
    XCTAssertTrue(scroll(app, until: first, swipes: 120, down: true), "scrolling up never reached the first turn")
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
    attach(value, "pressed-row")
    XCTAssertFalse(text(app, containing: "output line 10 of turn \(turn)").exists)
    row.tap()
    let opened = text(app, containing: "output line 10 of turn \(turn)")
    XCTAssertTrue(opened.waitForExistence(timeout: 5), "pressing the Bash row of turn \(turn) did not open it")
    snap(app, "5-opened")

    let pinned = try XCTUnwrap(
      (sticky.textViews.firstMatch.value as? String)?.firstMatch(of: /Turn \d+:/).map { String($0.0) },
      "the sticky strip carries no prompt")
    sticky.tap()
    let landed = text(app, containing: pinned)
    XCTAssertTrue(landed.waitForExistence(timeout: 3))
    sleep(1)
    snap(app, "6-sticky-tapped")
    XCTAssertFalse(sticky.exists && (sticky.textViews.firstMatch.value as? String)?.contains(pinned) == true,
      "the strip still pins \(pinned) after jumping to it")
  }

  // The fixture's last row is a running shell answered in-process: an 80-line scrollback, echoed input, a listing on
  // Enter, and a kill that reports it exited.
  @MainActor
  func testCoreShellOpensTypesScrollsAndKills() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launch()

    let header = text(app, containing: "npm run dev ·")
    XCTAssertTrue(header.waitForExistence(timeout: 20), "no shell row at the tail")
    snap(app, "shell-1-row")
    sleep(1)
    header.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 8)).tap()

    let screen = app.descendants(matching: .any)["shell-screen"]
    XCTAssertTrue(screen.waitForExistence(timeout: 5), "pressing the running shell did not open its screen")
    XCTAssertTrue(wait(screen, contains: "boot 080"), "the attach scrollback never drew")
    XCTAssertEqual(app.staticTexts["shell-status"].label, "running")
    snap(app, "shell-2-open")

    screen.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "tapping the shell raised no keyboard")
    app.typeText("ls\n")
    XCTAssertTrue(wait(screen, contains: "file-a"), "typed input never reached the fixture shell")
    snap(app, "shell-3-typed")

    app.buttons["Hide keyboard"].tap()
    for _ in 0..<8 where !(screen.value as? String ?? "").contains("boot 001") {
      screen.swipeDown(velocity: .slow)
    }
    XCTAssertTrue(wait(screen, contains: "boot 001"), "dragging down never reached the top of the scrollback")
    snap(app, "shell-4-scrolled")

    app.navigationBars.buttons["Kill"].tap()
    app.sheets.buttons["Kill"].firstMatch.tap()
    let status = app.staticTexts["shell-status"]
    let ended = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != 'running'"), object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [ended], timeout: 5), .completed, "the kill never ended the shell")
    snap(app, "shell-5-killed")
    attach(status.label, "status-after-kill")

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(header.waitForExistence(timeout: 5), "back did not return to the transcript")
    XCTAssertFalse(screen.exists)
    snap(app, "shell-6-back")
  }

  // Turn 56 hands its work to a sub-agent with 40 Bash steps (step 25 fails); the rail jumps on both surfaces.
  @MainActor
  func testCoreRailAndSubagentTakeover() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launch()

    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open on its tail")
    let rail = app.descendants(matching: .any)["scrubber-rail"].firstMatch
    XCTAssertTrue(rail.waitForExistence(timeout: 5), "no rail beside the transcript")
    snap(app, "rail-1-tail")

    rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    XCTAssertTrue(text(app, containing: "Turn 1:").waitForExistence(timeout: 5), "a press at the rail's top did not reach turn 1")
    snap(app, "rail-2-top")

    rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.995)).tap()
    let task = text(app, containing: "Survey every batch")
    XCTAssertTrue(scroll(app, until: task, swipes: 20, down: true), "no Task row near the tail")
    sleep(1)
    snap(app, "rail-3-task-row")
    attach(task.value as? String ?? "", "task-row")
    task.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 8)).tap()

    let frame = app.descendants(matching: .any)["frame-screen"]
    XCTAssertTrue(frame.waitForExistence(timeout: 5), "pressing the Task row opened no takeover")
    let folded = text(app, containing: "Ran 40 shell commands")
    XCTAssertTrue(folded.waitForExistence(timeout: 5), "the takeover shows no folded steps")
    XCTAssertTrue(text(app, containing: "Count the files in every batch").exists, "the takeover shows no brief")
    XCTAssertFalse(text(app, containing: "Turn 60:").exists, "the takeover shows session rows")
    snap(app, "frame-1-open")
    folded.tap()
    XCTAssertTrue(text(app, containing: "agent step 1)").waitForExistence(timeout: 5), "pressing the fold did not open the steps")
    for _ in 0..<12 { app.swipeUp(velocity: .fast) }
    XCTAssertTrue(text(app, containing: "agent step 40").waitForExistence(timeout: 3), "the opened steps do not reach step 40")
    snap(app, "frame-2-expanded-tail")
    attach(app.debugDescription, "frame-hierarchy")

    let frameRail = frame.descendants(matching: .any)["scrubber-rail"].firstMatch
    XCTAssertTrue(frameRail.exists, "no rail in the takeover")
    frameRail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap()
    let brief = text(app, containing: "Count the files in every batch")
    XCTAssertTrue(brief.waitForExistence(timeout: 5) && brief.isHittable, "a press at the takeover rail's top did not reach the brief")
    snap(app, "frame-3-top")

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(task.waitForExistence(timeout: 5), "back did not return to the session")
    XCTAssertFalse(frame.exists)
    snap(app, "frame-4-back")
  }

  // `$` in an empty draft enters shell mode (the fixture attaches with `shell: true`); the `$` cell leaves it, and a
  // command runs as one more shell row.
  @MainActor
  func testCoreComposerShellMode() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launch()

    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open on its tail")
    let message = app.textFields["Message"].exists ? app.textFields["Message"] : app.textViews["Message"]
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
    snap(app, "composer-1-left")

    draft.tap()
    app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
    app.typeText("$ls -la")
    XCTAssertTrue(leave.waitForExistence(timeout: 3), "a $ in a cleared draft did not enter shell mode")
    snap(app, "composer-2-shell")
    app.buttons["Run"].tap()
    XCTAssertTrue(text(app, containing: "ran-ok").waitForExistence(timeout: 5), "the command never landed as a shell row")
    XCTAssertTrue(text(app, containing: "ls -la").exists)
    XCTAssertFalse(leave.exists, "running a command did not leave shell mode")
    snap(app, "composer-3-ran")
  }

  private func wait(_ element: XCUIElement, contains needle: String, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if (element.value as? String ?? "").contains(needle) { return true }
      usleep(200_000)
    }
    return false
  }

  private func text(_ app: XCUIApplication, containing needle: String) -> XCUIElement {
    app.textViews.matching(NSPredicate(format: "value CONTAINS %@", needle)).firstMatch
  }

  private func scroll(_ app: XCUIApplication, until element: XCUIElement, swipes: Int, down: Bool) -> Bool {
    for _ in 0..<swipes {
      if element.exists && element.isHittable { return true }
      if down { app.swipeDown(velocity: .fast) } else { app.swipeUp(velocity: .fast) }
    }
    return element.exists
  }

  private func snap(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func attach(_ text: String, _ name: String) {
    let note = XCTAttachment(string: text)
    note.name = name
    note.lifetime = .keepAlways
    add(note)
  }
}
