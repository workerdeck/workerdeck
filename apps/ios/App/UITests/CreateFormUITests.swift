import XCTest

final class CreateFormUITests: XCTestCase {
  // The modes on offer come from the chosen profile's engine (a Rust test); this checks the picker drives the form.
  @MainActor
  func testSwitchingProfileChangesTheOfferedModes() throws {
    let app = launchPreview("createform")

    let mode = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mode'")).firstMatch
    XCTAssertTrue(mode.waitForExistence(timeout: 8), "no mode row")
    XCTAssertTrue(mode.label.contains("Plan"), "the profile's default mode was not adopted: \(mode.label)")
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Profile'")).firstMatch.exists, "no profile picker")

    app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Profile'")).firstMatch.tap()
    let codex = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'openai'")).firstMatch
    XCTAssertTrue(codex.waitForExistence(timeout: 3), "the profile menu did not open")
    codex.tap()

    XCTAssertTrue(mode.waitForExistence(timeout: 3))
    XCTAssertTrue(mode.label.contains("Manual"), "plan survived into a codex profile: \(mode.label)")
    let codexModes = offeredModes(app, mode)
    XCTAssertFalse(codexModes.contains("Plan"))
    XCTAssertTrue(codexModes.contains("Auto"))
  }

  @MainActor
  private func offeredModes(_ app: XCUIApplication, _ row: XCUIElement) -> [String] {
    row.tap()
    let title = app.staticTexts["Select mode"]
    XCTAssertTrue(title.waitForExistence(timeout: 3), "the mode sheet did not open")
    let names = ["Manual", "Accept edits", "Plan", "Don't ask", "Auto", "Bypass permissions"]
    let offered = names.filter { name in
      app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists
    }
    app.buttons["Close"].tap()
    XCTAssertTrue(title.waitForNonExistence(timeout: 3), "the mode sheet did not close")
    return offered
  }
}
