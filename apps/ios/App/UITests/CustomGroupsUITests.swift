import XCTest

// `UIPREVIEW=list` grouped by Custom with one empty group, Release; every session starts Ungrouped.
final class CustomGroupsUITests: XCTestCase {
  @MainActor
  func testMenuMovesASessionIntoAGroupAndOut() throws {
    let app = launchPreview("list", ["UIPREVIEW_GROUP": "custom"])
    let docs = card(app, "WD-Docs")
    XCTAssertTrue(docs.waitForExistence(timeout: 8))
    XCTAssertTrue(heading(app, "Release").exists)
    XCTAssertTrue(app.staticTexts["Hold a session and drag it here"].exists, "the empty group draws no drop box")

    docs.press(forDuration: 1.2)
    app.buttons["Move to group"].tap()
    app.buttons["Release"].tap()
    XCTAssertTrue(wait { self.between(docs, self.heading(app, "Release"), self.heading(app, "Ungrouped")) }, "WD-Docs is not in Release")
    XCTAssertFalse(app.staticTexts["Hold a session and drag it here"].exists)

    docs.press(forDuration: 1.2)
    app.buttons["Move to group"].tap()
    app.buttons["Ungrouped"].tap()
    XCTAssertTrue(wait { self.above(self.heading(app, "Ungrouped"), docs) }, "WD-Docs did not go back to Ungrouped")
  }

  @MainActor
  func testDragDropsASessionIntoAnEmptyGroup() throws {
    let app = launchPreview("list", ["UIPREVIEW_GROUP": "custom"])
    let plain = card(app, "Fix the relay drop")
    let box = app.staticTexts["Hold a session and drag it here"]
    XCTAssertTrue(plain.waitForExistence(timeout: 8) && box.exists)
    plain.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      .press(forDuration: 0.4, thenDragTo: box.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.6)
    XCTAssertTrue(wait { self.between(plain, self.heading(app, "Release"), self.heading(app, "Ungrouped")) }, "the drop did not land in Release")
  }

  @MainActor
  func testNewGroupIsNamedEditedAndDeleted() throws {
    let app = launchPreview("list", ["UIPREVIEW_GROUP": "custom"])
    let button = app.buttons["NewGroup"]
    XCTAssertTrue(button.waitForExistence(timeout: 8))
    button.tap()
    let name = app.textFields["GroupName"]
    XCTAssertTrue(name.waitForExistence(timeout: 3), "New group opened no sheet")
    name.tap()
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "Ops")
    app.buttons["Colour #3f8f6b"].tap()
    app.navigationBars.buttons["Done"].tap()
    XCTAssertTrue(heading(app, "Ops").waitForExistence(timeout: 3), "the new group is not named Ops")

    XCTAssertTrue(app.textFields["GroupName"].waitForNonExistence(timeout: 3))
    app.buttons["Actions for Ops"].tap()
    let delete = app.buttons["Delete group"]
    if !delete.waitForExistence(timeout: 3) {
      let tree = XCTAttachment(string: app.debugDescription)
      tree.lifetime = .keepAlways
      add(tree)
      print(app.debugDescription)
    }
    delete.tap()
    XCTAssertTrue(heading(app, "Ops").waitForNonExistence(timeout: 3), "the group was not deleted")
    XCTAssertTrue(heading(app, "Release").exists)
  }

  @MainActor
  private func wait(_ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if condition() { return true }
      usleep(200_000)
    }
    return false
  }

  @MainActor
  private func above(_ first: XCUIElement, _ second: XCUIElement) -> Bool {
    first.exists && second.exists && first.frame.minY < second.frame.minY
  }

  @MainActor
  private func between(_ element: XCUIElement, _ top: XCUIElement, _ bottom: XCUIElement) -> Bool {
    above(top, element) && above(element, bottom)
  }

  @MainActor
  private func card(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
  }

  @MainActor
  private func heading(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label ENDSWITH[c] %@", " \(name)")).firstMatch
  }
}
