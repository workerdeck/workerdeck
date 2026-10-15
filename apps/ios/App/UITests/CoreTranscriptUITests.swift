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
