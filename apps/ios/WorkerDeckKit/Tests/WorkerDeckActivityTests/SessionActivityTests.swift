import Foundation
import Testing

@testable import WorkerDeckActivity

/// The Live Activity payload contract, pinned against the exact JSON the CLI's
/// forwarder sends.
///
/// The fixtures in `Fixtures/` are whole APNs payloads, written by
/// `packages/cli/test/live-activity.test.ts` - running that test with
/// `UPDATE_FIXTURES=1` rewrites them. Decoding them here with the real types is
/// the only place the two languages are made to agree; a forwarder change that
/// renames a field fails on this side.
///
/// Decoding uses a **default** `JSONDecoder`, deliberately: that is what
/// ActivityKit itself uses for a pushed content state, so a test that
/// configured a key or date strategy would prove something the device does not
/// do.
@Suite("SessionActivity")
struct SessionActivityTests {
  private struct Envelope: Decodable {
    struct Aps: Decodable {
      let event: String
      let attributesType: String?
      let attributes: SessionActivityAttributes?
      let contentState: SessionActivityAttributes.ContentState

      enum CodingKeys: String, CodingKey {
        case event
        case attributesType = "attributes-type"
        case attributes
        case contentState = "content-state"
      }
    }
    let aps: Aps
  }

  private func load(_ name: String) throws -> Envelope {
    let url = try #require(
      Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
  }

  @Test("a start payload carries the attributes the card is keyed by")
  func startCarriesAttributes() throws {
    let envelope = try load("start-running")
    #expect(envelope.aps.event == "start")
    // A wire-contract string in the same family as PERMISSION_REQUEST: the
    // system matches it against the registered ActivityAttributes type name.
    #expect(envelope.aps.attributesType == "SessionActivityAttributes")
    let attributes = try #require(envelope.aps.attributes)
    #expect(attributes.sessionId == "ses_7f3a")
    #expect(attributes.engine == "claude")
    #expect(attributes.cwdLeaf == "workerdeck")

    let state = envelope.aps.contentState
    #expect(state.phase == SessionActivityPhase.running)
    #expect(state.headline == "Reading packages/cli/src/apns/client.ts")
    #expect(state.steps == SessionActivityAttributes.Steps(done: 2, total: 7))
    #expect(state.request == nil)
  }

  @Test("an update carries only the content state")
  func updateOmitsAttributes() throws {
    let envelope = try load("update-approval")
    #expect(envelope.aps.event == "update")
    #expect(envelope.aps.attributes == nil)
  }

  @Test("timestamps decode as epoch milliseconds, not as Dates from 2001")
  func datesAreEpochMillis() throws {
    let state = try load("update-approval").aps.contentState
    #expect(state.startedAtMs == 1_757_764_800_000)
    let expires = try #require(state.expiresAtMs)
    // The trap this pins: a Date field would read 1757765230 as seconds since
    // 2001 and draw a countdown 31 years off. As a number the value is exact,
    // and the gap to startedAt is the 5 minutes the gateway actually set.
    #expect(expires - state.startedAtMs == 430_000)
  }

  @Test("a permission request has no choices and needs no input")
  func permissionRequest() throws {
    let state = try load("update-approval").aps.contentState
    #expect(state.phase == SessionActivityPhase.approval)
    #expect(SessionActivityPhase.isWaiting(state.phase))
    let request = try #require(state.request)
    #expect(request.kind == SessionActivityRequestKind.permission)
    #expect(request.choices.isEmpty)
    #expect(request.inputJSON == nil)
    #expect(state.pendingCount == 1)
  }

  @Test("a question carries its options and the original input to answer with")
  func questionRequest() throws {
    let state = try load("update-question").aps.contentState
    #expect(state.phase == SessionActivityPhase.question)
    let request = try #require(state.request)
    #expect(request.kind == SessionActivityRequestKind.question)
    #expect(request.choices.map(\.index) == [0, 1, 2])
    #expect(request.choices.count <= SessionActivityLimits.choices)
    #expect(request.choices.first?.label == "Shared Keychain group")
    // Without the original input there is nothing to rewrite, so the card would
    // have to fall back to "Answer in app" - the buttons depend on this field.
    let inputJSON = try #require(request.inputJSON)
    #expect(inputJSON.contains("\"header\":\"Auth method\""))
  }

  @Test("a final state is recognisable as one")
  func endIsFinal() throws {
    let envelope = try load("end-done")
    #expect(envelope.aps.event == "end")
    let state = envelope.aps.contentState
    #expect(SessionActivityPhase.isFinal(state.phase))
    #expect(!SessionActivityPhase.isWaiting(state.phase))
  }

  @Test("an unknown phase decodes and degrades instead of dropping the update")
  func unknownPhaseDegrades() throws {
    // The whole reason `phase` and `kind` are Strings. A Codable enum would
    // throw here, ActivityKit would discard the update, and the card would sit
    // frozen on whatever a newer gateway last managed to say in the old
    // vocabulary.
    let state = try load("update-unknown-phase").aps.contentState
    #expect(state.phase == "compacting")
    #expect(!SessionActivityPhase.isWaiting(state.phase))
    #expect(!SessionActivityPhase.isFinal(state.phase))
    #expect(state.request?.kind == "handshake")
  }

  @Test("every server push clears the optimistic decision an intent wrote")
  func decisionIsAlwaysNilOnTheWire() throws {
    for name in [
      "start-running", "update-approval", "update-question", "end-done", "update-unknown-phase",
    ] {
      #expect(try load(name).aps.contentState.decision == nil, "\(name) must not set decision")
    }
  }

  @Test("the content state round-trips through the encoder the app uses locally")
  func roundTrips() throws {
    let original = try load("update-question").aps.contentState
    let data = try JSONEncoder().encode(original)
    #expect(try JSONDecoder().decode(
      SessionActivityAttributes.ContentState.self, from: data) == original)
  }
}
