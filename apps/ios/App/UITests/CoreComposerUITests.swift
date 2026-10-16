import UIKit
import XCTest

// The core composer over `CoreReplayFixture`: its commands, skills, peers and files are canned, and an upload lands
// after a short wait under an id that names the file.
final class CoreComposerUITests: XCTestCase {
  @MainActor
  func testCompletionsInsertTokens() throws {
    let app = launch()
    let field = app.textViews["Message"]
    field.tap()

    app.typeText("/rev")
    let review = app.buttons.matching(identifier: "Suggestion").firstMatch
    XCTAssertTrue(review.waitForExistence(timeout: 3), "no command suggestion for /rev")
    snap(app, "completion-1-command")
    review.tap()
    XCTAssertEqual(field.value as? String, "/review ")

    app.typeText("#rel")
    let peer = app.buttons.matching(identifier: "Suggestion").firstMatch
    XCTAssertTrue(peer.waitForExistence(timeout: 3), "no peer suggestion for #rel")
    peer.tap()
    XCTAssertEqual(field.value as? String, "/review #Release-Lead ")

    app.typeText("@field")
    let file = app.buttons.matching(identifier: "Suggestion").firstMatch
    XCTAssertTrue(file.waitForExistence(timeout: 3), "no file suggestion for @field")
    snap(app, "completion-2-file")
    file.tap()
    XCTAssertEqual(field.value as? String, "/review #Release-Lead @src/composer/field.swift ")

    app.typeText("/pd")
    XCTAssertTrue(app.buttons.matching(identifier: "Suggestion").firstMatch.waitForExistence(timeout: 3), "no skill")
    app.buttons.matching(identifier: "Suggestion").firstMatch.tap()
    XCTAssertEqual(field.value as? String, "/review #Release-Lead @src/composer/field.swift $pdf ")
    snap(app, "completion-3-styled")
  }

  @MainActor
  func testPastedImageUploadsAndSends() throws {
    let app = launch()
    UIPasteboard.general.image = Self.swatch()
    let field = app.textViews["Message"]
    field.tap()
    field.press(forDuration: 1.2)
    let paste = app.menuItems["Paste"]
    XCTAssertTrue(paste.waitForExistence(timeout: 5), "no Paste item for an image clipboard")
    paste.tap()
    let chip = app.descendants(matching: .any)["Attachment"]
    XCTAssertTrue(chip.waitForExistence(timeout: 5), "the pasted image was not staged")
    snap(app, "attach-1-staged")
    app.typeText("see the picture")
    let send = app.buttons["Send"]
    let deadline = Date().addingTimeInterval(5)
    while !send.isEnabled && Date() < deadline { usleep(200_000) }
    send.tap()
    XCTAssertTrue(text(app, containing: "see the picture").waitForExistence(timeout: 5), "the message never landed")
    XCTAssertTrue(text(app, containing: "pasted.png").exists, "the sent row does not name its attachment")
    XCTAssertFalse(chip.exists, "the staging strip did not clear on send")
    snap(app, "attach-2-sent")

    app.buttons["Add media"].tap()
    XCTAssertTrue(app.buttons["Photos"].waitForExistence(timeout: 3), "no media sheet")
    XCTAssertTrue(app.buttons["Files"].exists)
    snap(app, "attach-3-sheet")
    app.buttons["Close"].tap()
  }

  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launch()
    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open")
    return app
  }

  private static func swatch() -> UIImage {
    UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
    }
  }

  private func text(_ app: XCUIApplication, containing needle: String) -> XCUIElement {
    app.textViews.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", needle, needle)).firstMatch
  }

  private func snap(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
