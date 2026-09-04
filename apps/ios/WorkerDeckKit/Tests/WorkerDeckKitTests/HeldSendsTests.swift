import Foundation
import Testing

@testable import WorkerDeckKit

/// Catch-up mode off: what the reader typed mid-turn waits here, and the order
/// it waits in is the order it is sent in.
@Suite("HeldSends")
struct HeldSendsTests {
  private func message(_ text: String, _ attachmentIds: [String] = []) -> HeldSend {
    HeldSend(text: text, attachmentIds: attachmentIds)
  }

  @Test("catch-up on sends straight through, however busy")
  func catchUpSendsThrough() {
    var queue = HeldSendQueue()
    let now = queue.submit(message("go"), hold: false, busy: true)
    #expect(now == [message("go")])
    #expect(queue.held.isEmpty)
  }

  @Test("an idle session sends straight through even with the hold on")
  func idleSendsThrough() {
    var queue = HeldSendQueue()
    let now = queue.submit(message("go"), hold: true, busy: false)
    #expect(now == [message("go")])
    #expect(queue.held.isEmpty)
  }

  @Test("holds while busy, attachments and all")
  func holdsWhileBusy() {
    var queue = HeldSendQueue()
    let now = queue.submit(message("wait", ["att_1"]), hold: true, busy: true)
    #expect(now.isEmpty)
    #expect(queue.held == [message("wait", ["att_1"])])
    #expect(queue.summary == "1 message waiting for this turn to end — wait")
  }

  @Test("flushes in order when the turn ends")
  func flushesInOrder() {
    var queue = HeldSendQueue()
    _ = queue.submit(message("first"), hold: true, busy: true)
    _ = queue.submit(message("second", ["att_2"]), hold: true, busy: true)
    #expect(queue.summary == "2 messages waiting for this turn to end — second")
    #expect(queue.sessionBusy(true).isEmpty)
    #expect(queue.sessionBusy(false) == [message("first"), message("second", ["att_2"])])
    #expect(queue.held.isEmpty)
    #expect(queue.summary == nil)
    #expect(queue.sessionBusy(false).isEmpty)
  }

  @Test("Send now flushes before the turn ends")
  func sendNowFlushesEarly() {
    var queue = HeldSendQueue()
    _ = queue.submit(message("first"), hold: true, busy: true)
    _ = queue.submit(message("second"), hold: true, busy: true)
    #expect(queue.flush() == [message("first"), message("second")])
    #expect(queue.isEmpty)
    // The turn is still running: what is typed next holds again rather than
    // riding the flush that just happened.
    #expect(queue.submit(message("third"), hold: true, busy: true).isEmpty)
    #expect(queue.held == [message("third")])
  }
}
