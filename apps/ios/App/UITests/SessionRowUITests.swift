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
}
