import XCTest

// The real `SessionListView` over `PreviewListGateway` (`UIPREVIEW=list`), grouped by state: Needs attention (WD-Lead
// with its Member WD-Review), Working (Codex parity sweep), Idle (BOX-Lead, WD-Docs, Fix the relay drop).
final class ListDragUITests: XCTestCase {
  @MainActor
  func testHeadingsReorderBothWays() throws {
    let app = launchPreview("list")
    XCTAssertTrue(heading(app, "Idle").waitForExistence(timeout: 8))

    drag(app, heading(app, "Idle"), toY: 150, shots: "idle-up")
    XCTAssertTrue(above(heading(app, "Idle"), heading(app, "Needs attention")), "Idle did not move to the top")
    XCTAssertTrue(above(heading(app, "Needs attention"), heading(app, "Working")))

    drag(app, heading(app, "Needs attention"), toY: 700, shots: "attention-down")
    XCTAssertTrue(above(heading(app, "Working"), heading(app, "Needs attention")), "Needs attention did not move last")
    XCTAssertTrue(above(heading(app, "Idle"), heading(app, "Working")))
    XCTAssertTrue(card(app, "WD-Docs").exists, "the cards did not come back after the drop")
  }

  @MainActor
  func testAgentDroppedOnALeadJoinsItsTeam() throws {
    let app = launchPreview("list")
    XCTAssertTrue(card(app, "WD-Docs").waitForExistence(timeout: 8))
    drag(app, card(app, "WD-Docs"), onto: card(app, "WD-Lead"), shots: "join")
    XCTAssertTrue(inTeam(app, "WD-Docs"), "WD-Docs is not in WD-Lead's team")
  }

  @MainActor
  func testUnnamedSessionDroppedOnASoloAgentStartsATeam() throws {
    let app = launchPreview("list")
    XCTAssertTrue(card(app, "Fix the relay drop").waitForExistence(timeout: 8))
    drag(app, card(app, "Fix the relay drop"), onto: card(app, "BOX-Lead"), shots: "start-team")
    XCTAssertTrue(
      card(app, "BOX-Lead, LEAD").waitForExistence(timeout: 5), "BOX-Lead did not become a lead")
    XCTAssertFalse(card(app, "Fix the relay drop").exists, "the session is still drawn as an unnamed card")
  }

  @MainActor
  func testMemberDraggedOutLeavesItsTeam() throws {
    let app = launchPreview("list")
    XCTAssertTrue(card(app, "WD-Review").waitForExistence(timeout: 8))
    XCTAssertTrue(card(app, "WD-Lead, LEAD").exists)
    drag(app, card(app, "WD-Review"), onto: card(app, "BOX-Lead"), shots: "leave")
    XCTAssertTrue(card(app, "WD-Lead, Opus").waitForExistence(timeout: 5), "WD-Lead still leads a team")
    XCTAssertTrue(card(app, "WD-Review").exists)
  }

  @MainActor
  func testHoldWithoutMovingStillOpensTheMenu() throws {
    let app = launchPreview("list")
    let docs = card(app, "WD-Docs")
    XCTAssertTrue(docs.waitForExistence(timeout: 8))
    docs.press(forDuration: 1.2)
    XCTAssertTrue(app.buttons["Rename agent"].waitForExistence(timeout: 3), "a still hold no longer opens the menu")
    XCTAssertFalse(app.otherElements["Lifted"].exists, "the menu left a lifted card behind")
  }

  @MainActor
  func testSwipeStillOffersRowActions() throws {
    let app = launchPreview("list")
    let docs = card(app, "WD-Docs")
    XCTAssertTrue(docs.waitForExistence(timeout: 8))
    docs.swipeLeft()
    XCTAssertTrue(app.buttons["Delete agent"].waitForExistence(timeout: 3), "the trailing swipe is gone")
  }

  @MainActor
  func testTapStillOpensTheSession() throws {
    let app = launchPreview("list")
    let docs = card(app, "WD-Docs")
    XCTAssertTrue(docs.waitForExistence(timeout: 8))
    docs.tap()
    XCTAssertTrue(app.navigationBars["Sessions"].waitForNonExistence(timeout: 5), "a tap no longer opens the card")
  }

  // A hold past the lift, then a slow move; screenshots taken off the main thread while the drag blocks it.
  @MainActor
  private func drag(_ app: XCUIApplication, _ element: XCUIElement, toY y: CGFloat, shots name: String) {
    let to = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: element.frame.midX, dy: y))
    drag(element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), to: to, shots: name)
  }

  @MainActor
  private func drag(_ app: XCUIApplication, _ element: XCUIElement, onto target: XCUIElement, shots name: String) {
    drag(
      element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)),
      to: target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), shots: name)
  }

  @MainActor
  private func drag(_ from: XCUICoordinate, to: XCUICoordinate, shots name: String) {
    let shots = Shots()
    if ProcessInfo.processInfo.environment["WD_UI_SNAPS"] == "1" { shots.start(every: 0.25, count: 10) }
    from.press(forDuration: 0.4, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
    for (index, shot) in shots.take().enumerated() {
      let attachment = XCTAttachment(screenshot: shot)
      attachment.name = "\(name)-\(index)"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }

  @MainActor
  private func above(_ first: XCUIElement, _ second: XCUIElement) -> Bool {
    first.exists && second.exists && first.frame.minY < second.frame.minY
  }

  @MainActor
  private func card(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
  }

  // Drawn inside the Needs attention team's card, or as a face in its lead's tray.
  @MainActor
  private func inTeam(_ app: XCUIApplication, _ name: String) -> Bool {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if app.buttons["Open \(name)"].exists || above(card(app, name), heading(app, "Working")) { return true }
      usleep(200_000)
    }
    attach(app.debugDescription, "tree")
    return false
  }

  @MainActor
  private func heading(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label ENDSWITH[c] %@", " \(name)")).firstMatch
  }
}

final class Shots: @unchecked Sendable {
  private let lock = NSLock()
  private var taken: [XCUIScreenshot] = []

  func start(every interval: TimeInterval, count: Int) {
    Thread.detachNewThread {
      for _ in 0..<count {
        Thread.sleep(forTimeInterval: interval)
        let shot = XCUIScreen.main.screenshot()
        self.lock.withLock { self.taken.append(shot) }
      }
    }
  }

  func take() -> [XCUIScreenshot] { lock.withLock { taken } }
}
