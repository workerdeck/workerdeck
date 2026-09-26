import XCTest

final class SessionRowUITests: XCTestCase {
  // Steps are drawn without asking, and the filter menu's "Show under each
  // session" section is the only thing that changes how many. Rows that need a
  // press to appear look identical in a screenshot to rows that are simply there.
  @MainActor
  func testStepRowsDrawWithoutAPressAndFollowTheFilterMenu() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "sessions"
    app.launch()

    // Three cards carry a running agent; under the default only the running one
    // of each draws, so a completed sweep does not bury the list.
    let steps = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Explore · Fix base-url'"))
    XCTAssertTrue(steps.firstMatch.waitForExistence(timeout: 8), "no sub-agent row drew on its own")
    XCTAssertEqual(steps.count, 3)

    choose(app, display: "Agents", value: "All")
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'fable'")).firstMatch.waitForExistence(timeout: 3))

    choose(app, display: "Agents", value: "Hide")
    XCTAssertFalse(steps.firstMatch.waitForExistence(timeout: 3), "hiding left sub-agent rows behind")
    XCTAssertTrue(app.navigationBars["Sessions"].exists, "the menu pushed a row")

    let task = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Update the docs'"))
    XCTAssertTrue(task.firstMatch.waitForExistence(timeout: 3))
    choose(app, display: "Tasks", value: "Hide")
    XCTAssertFalse(task.firstMatch.waitForExistence(timeout: 3), "hiding left task rows behind")

    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Session 2 Title'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 3))
    row.tap()
    let pushed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sessionId: \"2\"'")).firstMatch
    XCTAssertTrue(pushed.waitForExistence(timeout: 5), "the row did not push its session")
  }

  // The stop button sits inside a row that navigates. A press that falls
  // through to the row would open the session instead of stopping the task.
  @MainActor
  func testStopDoesNotOpenTheRow() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "sessions"
    app.launch()

    let stop = app.buttons["Stop node packages/cli/cli.ts --port 4179"]
    XCTAssertTrue(stop.waitForExistence(timeout: 8), "a stoppable task drew no stop button")
    XCTAssertTrue(app.buttons["Kill pnpm dev --port 4179"].exists)
    stop.tap()
    XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 2))
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sessionId'")).firstMatch
        .waitForExistence(timeout: 2),
      "the stop press opened the row")
  }

  private func choose(_ app: XCUIApplication, display: String, value: String) {
    let filter = app.buttons["Filter"]
    XCTAssertTrue(filter.waitForExistence(timeout: 3))
    filter.tap()
    let submenu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", display)).firstMatch
    XCTAssertTrue(submenu.waitForExistence(timeout: 3), "no \(display) display in the filter menu")
    if let path = ProcessInfo.processInfo.environment["WD_MENU_SHOT"], display == "Tasks" {
      try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: path))
    }
    submenu.tap()
    let option = app.buttons[value]
    XCTAssertTrue(option.waitForExistence(timeout: 3), "no \(value) under \(display)")
    option.tap()
  }

  // The overflow control's whole failure mode is silent: a press that misses it
  // opens the session instead, and a screenshot of the pushed screen looks like
  // a screenshot of a working app. So the claim is both halves - the menu came
  // up AND the list is still what we are looking at.
  @MainActor
  func testOverflowOpensAMenuInsteadOfTheSession() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "sessions"
    app.launch()

    let overflow = app.descendants(matching: .any).matching(identifier: "Session actions")
    XCTAssertTrue(overflow.firstMatch.waitForExistence(timeout: 8))
    XCTAssertEqual(overflow.count, 6, "every card carries the affordance, hover or no hover")

    overflow.firstMatch.tap()
    XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 3), "no menu came up")
    XCTAssertTrue(app.buttons["Close"].exists)
    XCTAssertTrue(app.navigationBars["Sessions"].exists, "the overflow pushed the row")
  }

  // An agent frames its takeover and a task reveals its tool call: the two
  // kinds go to two destinations. An id that frames nothing selects no items
  // (the web's 0.21.0 bug), so a task must never route as an agent.
  @MainActor
  func testStepsPressToTheirOwnDestination() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "steps"
    app.launch()

    let agent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Explore'")).firstMatch
    XCTAssertTrue(agent.waitForExistence(timeout: 8))
    agent.tap()
    let framed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'subagent: Optional(\"a1\")'")).firstMatch
    XCTAssertTrue(framed.waitForExistence(timeout: 5), "the step did not frame its agent")
    app.navigationBars.buttons.firstMatch.tap()

    let task = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'check a capture'")).firstMatch
    XCTAssertTrue(task.waitForExistence(timeout: 5))
    task.tap()
    let revealed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'reveal: Optional(\"t2\")'")).firstMatch
    XCTAssertTrue(revealed.waitForExistence(timeout: 5), "the task did not reveal its tool call")
  }
}
