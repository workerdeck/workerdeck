import XCTest

final class SessionRowUITests: XCTestCase {
  @MainActor
  func testChipsFoldStepRowsUntilPressed() throws {
    let app = launchPreview("sessions")

    let chips = app.buttons.matching(NSPredicate(format: "label == 'Show 1 agent'"))
    XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 8), "no agents chip drew")
    let steps = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Explore · Fix base-url'"))
    XCTAssertEqual(steps.count, 0, "step rows drew before their chip was pressed")

    chips.firstMatch.tap()
    XCTAssertTrue(steps.firstMatch.waitForExistence(timeout: 3), "the chip opened no rows")
    XCTAssertTrue(app.buttons["Hide 1 agent"].exists)
    XCTAssertTrue(app.navigationBars["Sessions"].exists, "the chip pushed the row")

    app.buttons["Hide 1 agent"].tap()
    XCTAssertTrue(steps.firstMatch.waitForNonExistence(timeout: 3), "hiding left the rows behind")

    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Session 2 Title'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 3))
    row.tap()
    let pushed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sessionId: \"2\"'")).firstMatch
    XCTAssertTrue(pushed.waitForExistence(timeout: 5), "the row did not push its session")
  }

  @MainActor
  func testStopDoesNotOpenTheRow() throws {
    let app = launchPreview("sessions")

    let stop = app.buttons["Stop node packages/cli/cli.ts --port 4179"]
    let chips = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Show '"))
    XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 8), "no chip drew")
    while chips.firstMatch.exists { chips.firstMatch.tap() }
    XCTAssertTrue(stop.waitForExistence(timeout: 3), "a stoppable task drew no stop button")
    XCTAssertTrue(app.buttons["Kill pnpm dev --port 4179"].exists)
    stop.tap()
    XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 2))
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sessionId'")).firstMatch
        .waitForExistence(timeout: 2),
      "the stop press opened the row")
  }

  @MainActor
  func testStepsPressToTheirOwnDestination() throws {
    let app = launchPreview("steps")

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
