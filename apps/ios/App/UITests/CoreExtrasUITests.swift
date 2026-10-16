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
    app.buttons["Done"].tap()

    app.buttons["Session info"].tap()
    XCTAssertTrue(app.navigationBars["Session info"].waitForExistence(timeout: 10))
    snap(app, "info")
  }

  @MainActor
  private func snap(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
