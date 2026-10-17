import XCTest

// The core screen's row extras over the in-process fixtures: the long-press menu, pictures and the viewer, the full
// fetch of a truncated result, the empty state and Sleep. The catch-up bar and the takeover's menu ride along in
// `CoreTranscriptUITests`.
final class CoreRowsUITests: XCTestCase {
  @MainActor
  func testRowMenuImagesAndFullFetch() throws {
    let app = launchPreview("core", ["UIPREVIEW_CORE": "media"])
    let running = text(app, containing: "npm run watch")
    XCTAssertTrue(running.waitForExistence(timeout: 20), "the media fixture did not open")
    snap(app, "media-1-open")

    // The first press opens the truncated result, the second fetches the rest.
    let head = app.textViews.matching(NSPredicate(format: "label CONTAINS ' chars'")).firstMatch
    XCTAssertTrue(head.waitForExistence(timeout: 5), "the truncated result has no tail line")
    head.tap()
    let fetch = app.textViews.matching(NSPredicate(format: "label CONTAINS 'fetch the rest'")).firstMatch
    XCTAssertTrue(fetch.waitForExistence(timeout: 5), "the open result offers no fetch")
    fetch.tap()
    XCTAssertTrue(text(app, containing: "full output line 3").waitForExistence(timeout: 5), "the full result never landed")
    snap(app, "media-4-full")

    running.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Move to background"].waitForExistence(timeout: 3), "no row menu on the running call")
    XCTAssertTrue(app.buttons["Copy"].exists)
    app.buttons["Bookmark"].tap()
    XCTAssertTrue(app.buttons["Bookmark"].waitForNonExistence(timeout: 3))

    for _ in 0..<3 where !app.buttons["Copy"].exists {
      running.press(forDuration: 1.0)
      _ = app.buttons["Copy"].waitForExistence(timeout: 3)
    }
    if !app.buttons["Remove bookmark"].exists { attach(app.debugDescription, "second-menu") }
    XCTAssertTrue(app.buttons["Remove bookmark"].exists, "the bookmark did not stick")
    snap(app, "media-3-bookmarked")
    app.buttons["Remove bookmark"].tap()

    let read = text(app, containing: "shot.png")
    XCTAssertTrue(scroll(app, until: read, swipes: 10), "the Read row is gone")
    read.tap()
    let viewer = app.descendants(matching: .any)["image-viewer"]
    let box = read.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0)).withOffset(CGVector(dx: 0, dy: 60))
    for _ in 0..<5 where !viewer.exists {
      box.tap()
      _ = viewer.waitForExistence(timeout: 1)
    }
    if !viewer.exists { attach(app.debugDescription, "no-viewer") }
    XCTAssertTrue(viewer.exists, "tapping the picture opened no viewer")
    snap(app, "media-6-viewer")
    app.buttons["Done"].tap()
  }

  @MainActor
  func testEmptyStateAndSleep() throws {
    let app = launchPreview("core", ["UIPREVIEW_CORE": "empty"])
    XCTAssertTrue(app.staticTexts["Tell me what to do"].waitForExistence(timeout: 20), "no empty state")
    XCTAssertTrue(app.staticTexts["/work/fixture"].exists, "the empty state names no cwd")
    snap(app, "empty-1")

    app.navigationBars.buttons["Session"].tap()
    XCTAssertTrue(app.buttons["Sleep"].waitForExistence(timeout: 3), "no Sleep for an idle session that can sleep")
    app.buttons["Sleep"].tap()
    app.navigationBars.buttons["Session"].tap()
    XCTAssertTrue(app.buttons["Close session"].waitForExistence(timeout: 3))
    XCTAssertFalse(app.buttons["Sleep"].exists, "Sleep stayed offered after it was sent")
  }
}
