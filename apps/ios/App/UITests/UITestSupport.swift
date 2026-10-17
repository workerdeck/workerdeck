import XCTest

// Every UI test launches a `UIPREVIEW` screen with animations off (`UIPREVIEW_STILL`). Screenshots are taken only when
// the runner sees `WD_UI_SNAPS=1` (`TEST_RUNNER_WD_UI_SNAPS=1 xcodebuild test ...`); a failure records its own.
extension XCTestCase {
  @MainActor
  func launchPreview(_ variant: String, _ env: [String: String] = [:]) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["UIPREVIEW"] = variant
    app.launchEnvironment["UIPREVIEW_STILL"] = "1"
    for (key, value) in env { app.launchEnvironment[key] = value }
    app.launch()
    return app
  }

  @MainActor
  func text(_ app: XCUIApplication, containing needle: String) -> XCUIElement {
    // A row's lines are also exposed one by one, by label; on the device a long row's value stops short of its tail.
    app.textViews.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", needle, needle)).firstMatch
  }

  @MainActor
  func scroll(_ app: XCUIApplication, until element: XCUIElement, swipes: Int, down: Bool = true) -> Bool {
    for _ in 0..<swipes {
      if element.exists && element.isHittable { return true }
      if down { app.swipeDown(velocity: .fast) } else { app.swipeUp(velocity: .fast) }
    }
    return element.exists
  }

  @MainActor
  func wait(_ element: XCUIElement, contains needle: String, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if (element.value as? String ?? "").contains(needle) { return true }
      usleep(200_000)
    }
    return false
  }

  @MainActor
  func snap(_ app: XCUIApplication, _ name: String) {
    guard ProcessInfo.processInfo.environment["WD_UI_SNAPS"] == "1" else { return }
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  func attach(_ text: String, _ name: String) {
    let note = XCTAttachment(string: text)
    note.name = name
    note.lifetime = .keepAlways
    add(note)
  }
}
