import XCTest

// The status line's meters over `CoreReplayFixture`: a 62% context reading, the replay's 5h and weekly windows, and
// the fixture gateway's account reading, which wins the weekly window and adds a per-model one.
final class CoreUsageUITests: XCTestCase {
  @MainActor
  func testMetersOpenTheContextAndUsageSheets() throws {
    let app = launchPreview("core")

    let ring = app.buttons["Context ring"]
    XCTAssertTrue(ring.waitForExistence(timeout: 20), "no context ring on the status line")
    XCTAssertEqual(ring.label, "Context 62% used")
    let usage = app.buttons["Plan usage"]
    XCTAssertTrue(usage.waitForExistence(timeout: 5))
    let merged = NSPredicate(format: "label == %@", "5h 34%, 7d 71%, 7d opus 12%")
    expectation(for: merged, evaluatedWith: usage)
    waitForExpectations(timeout: 10)
    snap(app, "1-hud")

    ring.tap()
    XCTAssertTrue(app.navigationBars["Context"].waitForExistence(timeout: 5))
    XCTAssertTrue(has(app, "124.0k / 200.0k"))
    XCTAssertTrue(app.staticTexts["System tools"].exists)
    snap(app, "2-context")
    app.buttons["Done"].tap()

    usage.tap()
    XCTAssertTrue(app.navigationBars["Usage"].waitForExistence(timeout: 5))
    XCTAssertTrue(has(app, "$1.62"), "the gateway's own cost is not the one shown")
    XCTAssertTrue(app.staticTexts["Claude Code reports $1.84 for the same tokens."].exists)
    XCTAssertTrue(app.staticTexts["claude-opus-4-6"].exists)
    snap(app, "3-usage")
    app.swipeUp()
    XCTAssertTrue(app.staticTexts["Last 7 days"].waitForExistence(timeout: 3))
    snap(app, "4-usage-spend")
  }

  // A `LabeledContent` row reads as one element whose label joins both halves.
  private func has(_ app: XCUIApplication, _ needle: String) -> Bool {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", needle)).firstMatch.exists
  }
}
