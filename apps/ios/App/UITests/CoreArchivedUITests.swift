import XCTest

// A past agent conversation reads as one: the dated banner over the transcript, and no composer to type into.
final class CoreArchivedUITests: XCTestCase {
  @MainActor
  func testAnArchivedConversationIsReadOnly() throws {
    let app = launchPreview("corearchived")
    let banner = app.descendants(matching: .any).matching(identifier: "archived-banner").firstMatch
    XCTAssertTrue(banner.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Past conversation")).firstMatch.exists)
    XCTAssertTrue(text(app, containing: "Archived turn").waitForExistence(timeout: 5))
    XCTAssertFalse(app.textViews["Message"].exists)
    snap(app, "archived")
  }
}
