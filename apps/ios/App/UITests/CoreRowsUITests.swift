import XCTest

// The core screen's row extras over the in-process fixtures: the long-press menu, pictures and the viewer, the full
// fetch of a truncated result, the empty state, Sleep, and the catch-up bar.
final class CoreRowsUITests: XCTestCase {
  @MainActor
  func testRowMenuImagesAndFullFetch() throws {
    let app = launch(core: "media")
    let running = text(app, containing: "npm run watch")
    XCTAssertTrue(running.waitForExistence(timeout: 20), "the media fixture did not open")
    sleep(1)
    snap(app, "media-1-open")

    // The first press opens the truncated result, the second fetches the rest.
    let head = app.textViews.matching(NSPredicate(format: "label CONTAINS ' chars'")).firstMatch
    XCTAssertTrue(head.waitForExistence(timeout: 5), "the truncated result has no tail line")
    head.tap()
    let fetch = app.textViews.matching(NSPredicate(format: "label CONTAINS 'fetch the rest'")).firstMatch
    XCTAssertTrue(fetch.waitForExistence(timeout: 5), "the open result offers no fetch")
    snap(app, "media-4a-open")
    fetch.tap()
    XCTAssertTrue(text(app, containing: "full output line 3").waitForExistence(timeout: 5), "the full result never landed")
    snap(app, "media-4-full")

    running.press(forDuration: 1.2)
    XCTAssertTrue(app.buttons["Move to background"].waitForExistence(timeout: 3), "no row menu on the running call")
    XCTAssertTrue(app.buttons["Copy"].exists)
    snap(app, "media-2-menu")
    app.buttons["Bookmark"].tap()
    sleep(1)
    snap(app, "media-2b-rail-bookmark")

    for _ in 0..<3 where !app.buttons["Copy"].exists {
      running.press(forDuration: 1.2)
      _ = app.buttons["Copy"].waitForExistence(timeout: 3)
    }
    if !app.buttons["Remove bookmark"].exists { attach(app.debugDescription, "second-menu") }
    XCTAssertTrue(app.buttons["Remove bookmark"].exists, "the bookmark did not stick")
    snap(app, "media-3-bookmarked")
    app.buttons["Remove bookmark"].tap()

    let read = text(app, containing: "shot.png")
    XCTAssertTrue(scroll(app, until: read, swipes: 10), "the Read row is gone")
    read.tap()
    sleep(2)
    snap(app, "media-5-image")
    let box = read.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 60))
    box.tap()
    if !app.descendants(matching: .any)["image-viewer"].waitForExistence(timeout: 3) {
      attach(app.debugDescription, "no-viewer")
    }
    XCTAssertTrue(app.descendants(matching: .any)["image-viewer"].exists, "tapping the picture opened no viewer")
    snap(app, "media-6-viewer")
    app.buttons["Done"].tap()
  }

  @MainActor
  func testRowMenuInsideASubagentFrame() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launch()
    XCTAssertTrue(text(app, containing: "Turn 60:").waitForExistence(timeout: 20), "the session did not open")
    let task = text(app, containing: "Survey every batch")
    XCTAssertTrue(scroll(app, until: task, swipes: 20), "no Task row near the tail")
    sleep(1)
    task.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 8)).tap()
    XCTAssertTrue(app.descendants(matching: .any)["frame-screen"].waitForExistence(timeout: 5), "no takeover")
    let brief = text(app, containing: "Count the files in every batch")
    XCTAssertTrue(brief.waitForExistence(timeout: 5))
    sleep(1)
    brief.press(forDuration: 1.2)
    XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3), "no row menu inside the takeover")
    snap(app, "frame-menu")
    app.buttons["Copy"].tap()
  }

  @MainActor
  func testEmptyStateAndSleep() throws {
    let app = launch(core: "empty")
    XCTAssertTrue(app.staticTexts["Tell me what to do"].waitForExistence(timeout: 20), "no empty state")
    XCTAssertTrue(app.staticTexts["/work/fixture"].exists, "the empty state names no cwd")
    snap(app, "empty-1")

    app.navigationBars.buttons["Session"].tap()
    XCTAssertTrue(app.buttons["Sleep"].waitForExistence(timeout: 3), "no Sleep for an idle session that can sleep")
    snap(app, "empty-2-menu")
    app.buttons["Sleep"].tap()
    app.navigationBars.buttons["Session"].tap()
    XCTAssertTrue(app.buttons["Close session"].waitForExistence(timeout: 3))
    XCTAssertFalse(app.buttons["Sleep"].exists, "Sleep stayed offered after it was sent")
  }

  @MainActor
  func testCatchUpBarJumpsAndDismisses() throws {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launchEnvironment["UIPREVIEW_RECAP"] = "147"
    app.launch()
    let bar = app.descendants(matching: .any)["catch-up-bar"]
    XCTAssertTrue(bar.waitForExistence(timeout: 20), "no catch-up bar over a recap")
    snap(app, "catchup-1")
    bar.buttons["jump"].tap()
    XCTAssertTrue(text(app, containing: "※").waitForExistence(timeout: 3), "jump did not reach the seam")
    sleep(1)
    snap(app, "catchup-2-jumped")
    bar.buttons["dismiss"].tap()
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: bar)
    XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 3), .completed, "dismiss left the bar up")
  }

  private func launch(core: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = "core"
    app.launchEnvironment["UIPREVIEW_CORE"] = core
    app.launch()
    return app
  }

  private func text(_ app: XCUIApplication, containing needle: String) -> XCUIElement {
    app.textViews.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", needle, needle)).firstMatch
  }

  private func scroll(_ app: XCUIApplication, until element: XCUIElement, swipes: Int) -> Bool {
    for _ in 0..<swipes {
      if element.exists && element.isHittable { return true }
      app.swipeDown(velocity: .slow)
    }
    return element.exists
  }

  private func snap(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func attach(_ text: String, _ name: String) {
    let note = XCTAttachment(string: text)
    note.name = name
    note.lifetime = .keepAlways
    add(note)
  }
}
