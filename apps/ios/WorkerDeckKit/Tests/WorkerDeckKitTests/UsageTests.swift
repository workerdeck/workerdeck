import Foundation
import Testing

@testable import WorkerDeckKit

/// Mirror of `packages/react/test/usage.test.ts` — the merge is a shared
/// protocol rule, so the two suites must keep agreeing.
@Suite("Usage rules")
struct UsageTests {
  private func info(
    _ utilization: Double?, status: String = "allowed", type: String? = "five_hour"
  ) -> RateLimitInfo {
    RateLimitInfo(status: status, rateLimitType: type, utilization: utilization)
  }

  // MARK: - mergeUsage

  @Test func emptyWhenNeitherSideHasReported() {
    #expect(mergeUsage(SessionUsage(), nil).isEmpty)
    #expect(usageInfos(nil) == nil)
  }

  @Test func standsTheSessionsOwnReadingUpWhenTheGatewayHoldsNothing() {
    let merged = mergeUsage(
      SessionUsage(rateLimits: ["five_hour": info(40)], updatedAt: 1_000), nil)
    #expect(merged == ["five_hour": ProfileUsageWindow(info: info(40), updatedAt: 1_000)])
  }

  @Test func prefersTheProfileReadingOverTheSessionItCameFrom() {
    let profile: ProfileUsage = ["five_hour": ProfileUsageWindow(info: info(70), updatedAt: 5_000)]
    let merged = mergeUsage(
      SessionUsage(rateLimits: ["five_hour": info(40)], updatedAt: 1_000), profile)
    #expect(merged["five_hour"] == ProfileUsageWindow(info: info(70), updatedAt: 5_000))
  }

  /// Unconditional, deliberately not a timestamp comparison: the session's
  /// `updatedAt` is ONE scalar for its whole map (the ts of the newest
  /// `rate_limit` event of any window), so comparing it against a per-window
  /// profile stamp compares different things — and the gateway's tracker folds
  /// in every session's events, so it is never behind.
  @Test func prefersTheProfileReadingEvenWhenTheSessionStateLooksNewer() {
    let profile: ProfileUsage = ["five_hour": ProfileUsageWindow(info: info(70), updatedAt: 5_000)]
    let merged = mergeUsage(
      SessionUsage(
        rateLimits: ["five_hour": info(40), "seven_day": info(12, type: "seven_day")],
        updatedAt: 9_000),
      profile)
    #expect(merged["five_hour"]?.info.utilization == 70)
    #expect(
      merged["seven_day"]
        == ProfileUsageWindow(info: info(12, type: "seven_day"), updatedAt: 9_000))
  }

  @Test func carriesTheInferredResetFlagThroughUntouched() {
    let profile: ProfileUsage = [
      "five_hour": ProfileUsageWindow(info: info(0), updatedAt: 5_000, inferredReset: true)
    ]
    let merged = mergeUsage(
      SessionUsage(rateLimits: ["five_hour": info(93)], updatedAt: 5_000), profile)
    #expect(merged["five_hour"]?.inferredReset == true)
    #expect(merged["five_hour"]?.updatedAt == 5_000)
  }

  @Test func datesASessionOnlyWindowWithZeroWhenTheTranscriptHasNoClock() {
    let merged = mergeUsage(SessionUsage(rateLimits: ["five_hour": info(40)]), nil)
    #expect(merged["five_hour"]?.updatedAt == 0)
  }

  @Test func flattensBackToTheShapeEveryExistingMeterReads() {
    let merged = mergeUsage(
      SessionUsage(rateLimits: ["seven_day": info(12, type: "seven_day")], updatedAt: 1),
      ["five_hour": ProfileUsageWindow(info: info(70), updatedAt: 5_000)])
    #expect(
      usageInfos(merged) == ["five_hour": info(70), "seven_day": info(12, type: "seven_day")])
  }

  // MARK: - orderUsageWindows

  @Test func ordersNamedWindowsFirstThenPerModelSortedByKey() {
    let usage: ProfileUsage = [
      "seven_day_sonnet": ProfileUsageWindow(
        info: info(10, type: "seven_day_sonnet"), updatedAt: 1),
      "seven_day": ProfileUsageWindow(info: info(20, type: "seven_day"), updatedAt: 1),
      "seven_day_fable": ProfileUsageWindow(info: info(30, type: "seven_day_fable"), updatedAt: 1),
      "five_hour": ProfileUsageWindow(info: info(40), updatedAt: 1),
    ]
    #expect(
      orderUsageWindows(usage).map(\.key)
        == ["five_hour", "seven_day", "seven_day_fable", "seven_day_sonnet"])
  }

  /// A window with no utilization is unknown, not zero — dropped, never 0%.
  @Test func dropsWindowsWithoutAUtilizationReading() {
    let usage: ProfileUsage = [
      "five_hour": ProfileUsageWindow(info: info(nil), updatedAt: 1),
      "seven_day": ProfileUsageWindow(info: info(12, type: "seven_day"), updatedAt: 1),
    ]
    #expect(orderUsageWindows(usage).map(\.key) == ["seven_day"])
    #expect(orderUsageWindows(nil).isEmpty)
  }

  @Test func carriesEachWindowsOwnStampAndInferredResetOntoItsRow() {
    let usage: ProfileUsage = [
      "five_hour": ProfileUsageWindow(info: info(0), updatedAt: 5_000, inferredReset: true),
      "seven_day": ProfileUsageWindow(info: info(12, type: "seven_day"), updatedAt: 9_000),
    ]
    let rows = orderUsageWindows(usage)
    #expect(rows[0] == UsageWindowRow(key: "five_hour", info: info(0), updatedAt: 5_000, inferredReset: true))
    #expect(
      rows[1]
        == UsageWindowRow(key: "seven_day", info: info(12, type: "seven_day"), updatedAt: 9_000))
  }

  // MARK: - Wire shape

  /// `ProfileInfo.usage` off the `/profiles` route — the account reading the
  /// merge prefers.
  @Test func profileUsageDecodesOffTheProfilesRoute() throws {
    let json = #"""
      {"name":"personal","usage":{
        "five_hour":{"info":{"status":"allowed","rateLimitType":"five_hour","utilization":34},
                     "updatedAt":1722300000000},
        "seven_day":{"info":{"status":"allowed","rateLimitType":"seven_day","utilization":0},
                     "updatedAt":1722200000000,"inferredReset":true}}}
      """#
    let profile = try JSONDecoder().decode(ProfileInfo.self, from: Data(json.utf8))
    #expect(profile.usage?["five_hour"]?.info.utilization == 34)
    #expect(profile.usage?["five_hour"]?.updatedAt == 1_722_300_000_000)
    #expect(profile.usage?["five_hour"]?.inferredReset == nil)
    #expect(profile.usage?["seven_day"]?.inferredReset == true)
  }

  /// A profile without the field is a gateway predating it — unknown, never 0%.
  @Test func aProfileWithoutUsageStillDecodes() throws {
    let profile = try JSONDecoder().decode(
      ProfileInfo.self, from: Data(#"{"name":"personal"}"#.utf8))
    #expect(profile.usage == nil)
  }

  // The ring/number ramp, not the bar ramp: 80 and 95 are the turns, and the
  // boundaries are inclusive.
  @Test func meterSeverityTurnsAt80And95() {
    #expect(meterSeverity(nil) == .none)
    #expect(meterSeverity(0) == .none)
    #expect(meterSeverity(79.9) == .none)
    #expect(meterSeverity(80) == .warning)
    #expect(meterSeverity(94.9) == .warning)
    #expect(meterSeverity(95) == .error)
    #expect(meterSeverity(100) == .error)
  }
}
