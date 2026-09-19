import Foundation

public struct TokenUsage: Codable, Sendable, Equatable {
  public var input: Int
  public var output: Int
  public var cacheWrite5m: Int
  public var cacheWrite1h: Int
  public var cacheRead: Int

  public init(
    input: Int = 0, output: Int = 0, cacheWrite5m: Int = 0, cacheWrite1h: Int = 0,
    cacheRead: Int = 0
  ) {
    self.input = input
    self.output = output
    self.cacheWrite5m = cacheWrite5m
    self.cacheWrite1h = cacheWrite1h
    self.cacheRead = cacheRead
  }

  public static let empty = TokenUsage()

  public var total: Int { input + output + cacheWrite5m + cacheWrite1h + cacheRead }

  public func adding(_ other: TokenUsage) -> TokenUsage {
    TokenUsage(
      input: input + other.input, output: output + other.output,
      cacheWrite5m: cacheWrite5m + other.cacheWrite5m,
      cacheWrite1h: cacheWrite1h + other.cacheWrite1h, cacheRead: cacheRead + other.cacheRead)
  }

  private enum CodingKeys: String, CodingKey {
    case input, output, cacheWrite5m, cacheWrite1h, cacheRead
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    func count(_ key: CodingKeys) -> Int {
      guard let value = try? container.decodeIfPresent(Double.self, forKey: key) else { return 0 }
      return Pricing.tokenCount(value)
    }
    input = count(.input)
    output = count(.output)
    cacheWrite5m = count(.cacheWrite5m)
    cacheWrite1h = count(.cacheWrite1h)
    cacheRead = count(.cacheRead)
  }
}

public typealias ByModel = [String: TokenUsage]

public struct ModelRate: Sendable, Equatable {
  public let input: Double
  public let output: Double
  public let cacheWrite5m: Double
  public let cacheWrite1h: Double
  public let cacheRead: Double

  public init(
    input: Double, output: Double, cacheWrite5m: Double, cacheWrite1h: Double, cacheRead: Double
  ) {
    self.input = input
    self.output = output
    self.cacheWrite5m = cacheWrite5m
    self.cacheWrite1h = cacheWrite1h
    self.cacheRead = cacheRead
  }
}

public struct CostBreakdown: Sendable, Equatable {
  public var input: Double
  public var output: Double
  public var cacheWrite: Double
  public var cacheRead: Double
  public var total: Double
  public var unpriced: Bool
  public var unpricedTokens: Int
  public var unpricedShare: Double

  public init(
    input: Double = 0, output: Double = 0, cacheWrite: Double = 0, cacheRead: Double = 0,
    total: Double = 0, unpriced: Bool = false, unpricedTokens: Int = 0, unpricedShare: Double = 0
  ) {
    self.input = input
    self.output = output
    self.cacheWrite = cacheWrite
    self.cacheRead = cacheRead
    self.total = total
    self.unpriced = unpriced
    self.unpricedTokens = unpricedTokens
    self.unpricedShare = unpricedShare
  }
}

public struct SubscriptionComparison: Codable, Sendable, Equatable {
  public let weeklyUsd: Double
  public let monthlyUsd: Double
  public let weeklyShareUsd: Double
  public let ratio: Double

  public init(weeklyUsd: Double, monthlyUsd: Double, weeklyShareUsd: Double, ratio: Double) {
    self.weeklyUsd = weeklyUsd
    self.monthlyUsd = monthlyUsd
    self.weeklyShareUsd = weeklyShareUsd
    self.ratio = ratio
  }
}

/// A profile's rolling spend as the gateway's ledger serves it. Every figure is
/// what the same tokens would have cost on the pay-as-you-go API, never a bill.
public struct ProfileSpend: Codable, Sendable, Equatable {
  public let weekUsd: Double
  public let monthUsd: Double
  public let weekByModel: ByModel
  public let unpricedShare: Double
  public let monthlySubscriptionUsd: Double?
  public let subscription: SubscriptionComparison?

  public init(
    weekUsd: Double, monthUsd: Double, weekByModel: ByModel = [:], unpricedShare: Double = 0,
    monthlySubscriptionUsd: Double? = nil, subscription: SubscriptionComparison? = nil
  ) {
    self.weekUsd = weekUsd
    self.monthUsd = monthUsd
    self.weekByModel = weekByModel
    self.unpricedShare = unpricedShare
    self.monthlySubscriptionUsd = monthlySubscriptionUsd
    self.subscription = subscription
  }

  private enum CodingKeys: String, CodingKey {
    case weekUsd, monthUsd, weekByModel, unpricedShare, monthlySubscriptionUsd, subscription
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    weekUsd = try container.decodeIfPresent(Double.self, forKey: .weekUsd) ?? 0
    monthUsd = try container.decodeIfPresent(Double.self, forKey: .monthUsd) ?? 0
    weekByModel = try container.decodeIfPresent(ByModel.self, forKey: .weekByModel) ?? [:]
    unpricedShare = try container.decodeIfPresent(Double.self, forKey: .unpricedShare) ?? 0
    monthlySubscriptionUsd = try container.decodeIfPresent(
      Double.self, forKey: .monthlySubscriptionUsd)
    subscription = try container.decodeIfPresent(SubscriptionComparison.self, forKey: .subscription)
  }
}

/// A 1:1 port of `packages/protocol/src/pricing.ts`. It has to stay one: the
/// phone prices the same tokens the dashboard does, and a table that drifts
/// shows a different dollar figure for one session on two screens.
public enum Pricing {
  public static let asOf = "2026-09-19"

  public static let sources = "platform.claude.com and developers.openai.com list prices, bundled"

  public static let note =
    "List rates as of \(Pricing.asOf). A subscription is a flat fee, so this is what the same tokens would have cost on the pay-as-you-go API, not a bill."

  public static let unpricedWarnShare = 0.005

  private static let mtok = 1_000_000.0

  private static let weeksPerMonth = 52.0 / 12.0

  private static func anthropicRate(_ input: Double, _ output: Double, _ cacheRead: Double? = nil)
    -> ModelRate
  {
    ModelRate(
      input: input, output: output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2,
      cacheRead: cacheRead ?? input * 0.1)
  }

  private static func openaiRate(_ input: Double, _ output: Double, _ cacheRead: Double)
    -> ModelRate
  {
    ModelRate(
      input: input, output: output, cacheWrite5m: input, cacheWrite1h: input, cacheRead: cacheRead)
  }

  public static let defaultTable: [String: ModelRate] = [
    "claude-fable-5-1": anthropicRate(10, 50, 0.25),
    "claude-fable-5": anthropicRate(10, 50),
    "claude-mythos-5-1": anthropicRate(10, 50, 0.25),
    "claude-mythos-5": anthropicRate(10, 50),
    "claude-opus-5": anthropicRate(5, 25),
    "claude-opus-4-8": anthropicRate(5, 25),
    "claude-opus-4-7": anthropicRate(5, 25),
    "claude-opus-4-6": anthropicRate(5, 25),
    "claude-opus-4-5": anthropicRate(5, 25),
    "claude-sonnet-5": anthropicRate(2, 10),
    "claude-sonnet-4-6": anthropicRate(3, 15),
    "claude-sonnet-4-5": anthropicRate(3, 15),
    "claude-haiku-4-5": anthropicRate(1, 5),
    "gpt-6-astra": openaiRate(10, 50, 1),
    "gpt-5.6-sol": openaiRate(4, 20, 0.4),
    "gpt-5.6-terra": openaiRate(2, 12, 0.2),
    "gpt-5.6-luna": openaiRate(0.2, 1.2, 0.02),
    "gpt-5.5": openaiRate(5, 30, 0.5),
    "gpt-5.4": openaiRate(2.5, 15, 0.25),
    "gpt-5.2": openaiRate(1.75, 14, 0.175),
    "gpt-5.1": openaiRate(1.25, 10, 0.125),
    "gpt-5": openaiRate(1.25, 10, 0.125),
  ]

  public static func canonicalModel(_ model: String) -> String {
    let withoutProvider = model.split(separator: "/").last.map(String.init) ?? model
    var out = withoutProvider.lowercased()
    for pattern in [
      "\\[[^\\]]*\\]$", "^(?:[a-z]+\\.)*anthropic\\.", "[@-][0-9]{8}$", "-v[0-9]+:[0-9]+$",
    ] {
      out = out.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }
    return out
  }

  public static func rateFor(_ model: String?, in pricing: [String: ModelRate] = Pricing.defaultTable)
    -> ModelRate?
  {
    guard let model else { return nil }
    return pricing[canonicalModel(model)]
  }

  public static func totalTokens(_ byModel: ByModel) -> Int {
    byModel.values.reduce(0) { $0 + $1.total }
  }

  public static func merge(_ into: ByModel, _ add: ByModel) -> ByModel {
    var out = into
    for (model, usage) in add {
      out[model] = (out[model] ?? .empty).adding(usage)
    }
    return out
  }

  static func tokenCount(_ value: Double) -> Int {
    guard value.isFinite, value > 0 else { return 0 }
    return Int(value.rounded())
  }

  public static func tokenUsageFromWire(_ usage: JSONValue?) -> TokenUsage {
    guard case .object(let wire)? = usage else { return .empty }
    func count(_ value: JSONValue?) -> Int {
      guard let number = value?.numberValue else { return 0 }
      return tokenCount(number)
    }
    var split: [String: JSONValue]?
    if case .object(let fields)? = wire["cache_creation"] { split = fields }
    let write1h = count(split?["ephemeral_1h_input_tokens"])
    let write5m =
      split.map { count($0["ephemeral_5m_input_tokens"]) }
      ?? count(wire["cache_creation_input_tokens"])
    return TokenUsage(
      input: count(wire["input_tokens"]), output: count(wire["output_tokens"]),
      cacheWrite5m: write5m, cacheWrite1h: write1h,
      cacheRead: count(wire["cache_read_input_tokens"]))
  }

  public static func costOf(
    _ usage: TokenUsage, model: String?, pricing: [String: ModelRate] = Pricing.defaultTable
  ) -> CostBreakdown {
    guard let rate = rateFor(model, in: pricing) else {
      let tokens = usage.total
      return CostBreakdown(unpriced: true, unpricedTokens: tokens, unpricedShare: tokens > 0 ? 1 : 0)
    }
    let input = (Double(usage.input) / mtok) * rate.input
    let output = (Double(usage.output) / mtok) * rate.output
    let cacheWrite =
      (Double(usage.cacheWrite5m) / mtok) * rate.cacheWrite5m
      + (Double(usage.cacheWrite1h) / mtok) * rate.cacheWrite1h
    let cacheRead = (Double(usage.cacheRead) / mtok) * rate.cacheRead
    return CostBreakdown(
      input: input, output: output, cacheWrite: cacheWrite, cacheRead: cacheRead,
      total: input + output + cacheWrite + cacheRead)
  }

  public static func costOfByModel(
    _ byModel: ByModel, pricing: [String: ModelRate] = Pricing.defaultTable
  ) -> CostBreakdown {
    var acc = CostBreakdown()
    var anyPriced = false
    var tokens = 0
    for (model, usage) in byModel {
      tokens += usage.total
      let cost = costOf(usage, model: model, pricing: pricing)
      if cost.unpriced {
        acc.unpricedTokens += cost.unpricedTokens
        continue
      }
      anyPriced = true
      acc.input += cost.input
      acc.output += cost.output
      acc.cacheWrite += cost.cacheWrite
      acc.cacheRead += cost.cacheRead
      acc.total += cost.total
    }
    acc.unpriced = !anyPriced && !byModel.isEmpty
    acc.unpricedShare = tokens > 0 ? Double(acc.unpricedTokens) / Double(tokens) : 0
    return acc
  }

  public static func unpricedModels(
    _ byModel: ByModel, pricing: [String: ModelRate] = Pricing.defaultTable
  ) -> [String] {
    byModel.keys.filter { rateFor($0, in: pricing) == nil }.sorted()
  }

  // Rate limits meter fresh input, output and cache writes; a cache read is nearly free to serve
  // and does not count against a plan window, which is why quota burn and API-equivalent cost
  // diverge on an agentic workload.
  public static func meteredCost(_ cost: CostBreakdown) -> Double {
    cost.input + cost.output + cost.cacheWrite
  }

  public static func subscriptionComparison(weeklyUsd: Double, monthlyUsd: Double)
    -> SubscriptionComparison?
  {
    guard monthlyUsd > 0, weeklyUsd.isFinite, weeklyUsd >= 0 else { return nil }
    let weeklyShareUsd = monthlyUsd / weeksPerMonth
    return SubscriptionComparison(
      weeklyUsd: weeklyUsd, monthlyUsd: monthlyUsd, weeklyShareUsd: weeklyShareUsd,
      ratio: weeklyUsd / weeklyShareUsd)
  }
}
