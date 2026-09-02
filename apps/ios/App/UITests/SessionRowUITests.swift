import XCTest

final class SessionRowUITests: XCTestCase {
  @MainActor
  func testDisclosureAndRowAreSeparateTargets() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "sessions"
    app.launch()

    let closed = app.descendants(matching: .any).matching(identifier: "Show 1 of 3 agents running")
    let open = app.descendants(matching: .any).matching(identifier: "Hide 1 of 3 agents running")
    XCTAssertTrue(closed.firstMatch.waitForExistence(timeout: 8))
    XCTAssertEqual(closed.count, 2)
    XCTAssertEqual(open.count, 1)

    closed.firstMatch.tap()
    XCTAssertTrue(open.element(boundBy: 1).waitForExistence(timeout: 3), "the disclosure did not toggle")
    XCTAssertTrue(app.navigationBars["Sessions"].exists, "the disclosure pushed the row")

    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Session 2 Title'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 3))
    row.tap()
    let pushed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sessionId: \"2\"'")).firstMatch
    XCTAssertTrue(pushed.waitForExistence(timeout: 5), "the row did not push its session")
  }

  // The overflow control's whole failure mode is silent: a press that misses it
  // opens the session instead, and a screenshot of the pushed screen looks like
  // a screenshot of a working app. So the claim is both halves — the menu came
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

  // The two kinds of step go to two destinations, and getting it wrong is
  // invisible from the outside: a task routed as a sub-agent frames an id that
  // selects nothing (the web's 0.21.0 bug), and a task that loses its `reveal`
  // opens the transcript at the tail, which looks exactly like a press that
  // never landed. So this presses one of each and reads the route back.
  @MainActor
  func testStepKindsPressToDifferentDestinations() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "steps"
    app.launch()

    let agent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Explore'")).firstMatch
    XCTAssertTrue(agent.waitForExistence(timeout: 8))
    agent.tap()
    let framed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'subagent: Optional(\"a1\")'")).firstMatch
    XCTAssertTrue(framed.waitForExistence(timeout: 5), "the agent step did not frame its agent")
    app.navigationBars.buttons.firstMatch.tap()

    let task = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'rewrite the height budget'")).firstMatch
    XCTAssertTrue(task.waitForExistence(timeout: 5))
    task.tap()
    let revealed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'reveal: Optional(\"t1\")'")).firstMatch
    XCTAssertTrue(revealed.waitForExistence(timeout: 5), "the task step did not travel to its row")
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'subagent: Optional'")).firstMatch.exists,
      "a task must not be framed as an agent")
  }
}
