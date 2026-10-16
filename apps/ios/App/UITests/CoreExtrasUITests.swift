import XCTest

// The session info, MCP servers and skills sheets over canned data, no gateway behind them.
final class CoreExtrasUITests: XCTestCase {
  @MainActor
  func testSheetsOpenWithTheirContent() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "coreextras"
    app.launch()

    app.buttons["Skills"].tap()
    XCTAssertTrue(app.staticTexts["wrapup"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Repo skill"].exists)
    snap(app, "skills")
    app.buttons["Done"].tap()

    app.buttons["MCP servers"].tap()
    XCTAssertTrue(app.staticTexts["workerdeck"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["figma"].exists)
    snap(app, "mcp")
    app.staticTexts["figma"].tap()
    snap(app, "mcp-detail")
    app.navigationBars.buttons["MCP servers"].tap()
    app.staticTexts["workerdeck"].tap()
    XCTAssertTrue(app.buttons["Disable"].waitForExistence(timeout: 5))
    app.staticTexts["Tools"].tap()
    app.staticTexts["peers_list"].tap()
    let fullName = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "mcp__workerdeck__peers_list", "mcp__workerdeck__peers_list"))
    XCTAssertTrue(fullName.firstMatch.waitForExistence(timeout: 5))
    snap(app, "mcp-tool")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.navigationBars.buttons["MCP servers"].tap()
    app.buttons["Done"].tap()

    app.buttons["Session info"].tap()
    XCTAssertTrue(app.navigationBars["Session info"].waitForExistence(timeout: 10))
    snap(app, "info")
  }

  // The host file browser over a canned gateway: the core lists the cwd and opens a file read for editing. Typing
  // into the SwiftUI TextEditor gets no keyboard focus under XCUITest here; the save and 409 rules are core tests.
  @MainActor
  func testHostFilesBrowseAndOpen() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "coreextras"
    app.launch()

    app.buttons["Files"].tap()
    XCTAssertTrue(app.staticTexts["workerdeck"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["scratch"].exists)
    XCTAssertTrue(app.staticTexts["notes.md"].exists)
    snap(app, "files")

    app.staticTexts["notes.md"].tap()
    let save = app.buttons["Save"]
    XCTAssertTrue(save.waitForExistence(timeout: 10))
    XCTAssertFalse(save.isEnabled)
    XCTAssertEqual(app.textViews.firstMatch.value as? String, "Notes\n")
    snap(app, "file")
  }

  // The folder picker keeps folders and symlinks only.
  @MainActor
  func testFolderPickerShowsOnlyFolders() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "folders"
    app.launch()

    XCTAssertTrue(app.staticTexts["workerdeck"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["scratch"].exists)
    XCTAssertFalse(app.staticTexts["notes.md"].exists)
    XCTAssertTrue(app.buttons["Use projects"].exists)
    snap(app, "folders")
  }

  @MainActor
  private func snap(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
