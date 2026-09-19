import Foundation
import Testing

@testable import WorkerDeckKit

private func usage(
  input: Int = 0, output: Int = 0, cacheWrite5m: Int = 0, cacheWrite1h: Int = 0, cacheRead: Int = 0
) -> TokenUsage {
  TokenUsage(
    input: input, output: output, cacheWrite5m: cacheWrite5m, cacheWrite1h: cacheWrite1h,
    cacheRead: cacheRead)
}

@Suite("canonicalModel")
struct PricingCanonicalModelTests {
  @Test("strips a context marker, a date snapshot and a provider prefix")
  func strips() {
    #expect(Pricing.canonicalModel("claude-opus-5[1m]") == "claude-opus-5")
    #expect(Pricing.canonicalModel("claude-haiku-4-5-20251001") == "claude-haiku-4-5")
    #expect(Pricing.canonicalModel("claude-sonnet-4-5@20250929") == "claude-sonnet-4-5")
    #expect(Pricing.canonicalModel("us.anthropic.claude-opus-5") == "claude-opus-5")
    #expect(Pricing.canonicalModel("anthropic/claude-opus-5") == "claude-opus-5")
    #expect(Pricing.canonicalModel("openai/gpt-5.6-sol") == "gpt-5.6-sol")
  }

  @Test("leaves a model that differs only by suffix distinct")
  func suffixesStayDistinct() {
    #expect(Pricing.canonicalModel("gpt-5.6-luna") != Pricing.canonicalModel("gpt-5.6-sol"))
  }
}

@Suite("rateFor")
struct PricingRateTests {
  @Test("derives anthropic cache tiers off base input")
  func anthropicTiers() {
    let rate = Pricing.rateFor("claude-opus-5")
    #expect(
      rate
        == ModelRate(
          input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5))
  }

  @Test("honours the fable flat cache-read rate rather than the 0.1x ladder")
  func fableFlatCacheRead() {
    #expect(Pricing.rateFor("claude-fable-5-1")?.cacheRead == 0.25)
    #expect(Pricing.rateFor("claude-fable-5")?.cacheRead == 1)
  }

  @Test("prices an openai cache write at plain input, since there is no write premium")
  func openaiWrites() {
    let rate = Pricing.rateFor("gpt-5.6-sol")
    #expect(rate?.cacheWrite5m == 4)
    #expect(rate?.cacheWrite1h == 4)
    #expect(rate?.cacheRead == 0.4)
  }

  @Test("returns nil for an unknown model rather than a default rate")
  func unknownModel() {
    #expect(Pricing.rateFor("some-model-nobody-priced") == nil)
    #expect(Pricing.rateFor(nil) == nil)
  }
}

@Suite("costOf")
struct PricingCostOfTests {
  @Test("prices each token kind at its own rate")
  func perKind() {
    let cost = Pricing.costOf(
      usage(
        input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000,
        cacheRead: 1_000_000), model: "claude-opus-5")
    #expect(abs(cost.input - 5) < 0.0001)
    #expect(abs(cost.output - 25) < 0.0001)
    #expect(abs(cost.cacheWrite - 16.25) < 0.0001)
    #expect(abs(cost.cacheRead - 0.5) < 0.0001)
    #expect(abs(cost.total - 46.75) < 0.0001)
    #expect(cost.unpriced == false)
  }

  @Test("reports an unknown model as unpriced with its whole token count, never a real-looking zero")
  func unknownIsUnpriced() {
    let cost = Pricing.costOf(
      usage(input: 100, output: 50, cacheRead: 1000), model: "mystery-model")
    #expect(cost.total == 0)
    #expect(cost.unpriced)
    #expect(cost.unpricedTokens == 1150)
    #expect(cost.unpricedShare == 1)
  }

  @Test("treats a cache read as an order of magnitude cheaper than fresh input")
  func cacheReadIsCheap() {
    let read = Pricing.costOf(usage(cacheRead: 1_000_000), model: "claude-opus-5").total
    let fresh = Pricing.costOf(usage(input: 1_000_000), model: "claude-opus-5").total
    #expect(abs(fresh / read - 10) < 0.0001)
  }
}

@Suite("costOfByModel")
struct PricingByModelTests {
  private let mixed: ByModel = [
    "claude-opus-5": TokenUsage(input: 1_000_000),
    "mystery-model": TokenUsage(input: 1_000_000),
  ]

  @Test("sums each model at its own rate")
  func sums() {
    let byModel: ByModel = [
      "claude-opus-5": TokenUsage(input: 1_000_000),
      "claude-haiku-4-5": TokenUsage(input: 1_000_000),
    ]
    #expect(abs(Pricing.costOfByModel(byModel).total - 6) < 0.0001)
  }

  @Test("surfaces the unpriced share rather than understating silently")
  func unpricedShare() {
    let cost = Pricing.costOfByModel(mixed)
    #expect(abs(cost.total - 5) < 0.0001)
    #expect(cost.unpriced == false)
    #expect(abs(cost.unpricedShare - 0.5) < 0.0001)
    #expect(cost.unpricedShare > Pricing.unpricedWarnShare)
    #expect(Pricing.unpricedModels(mixed) == ["mystery-model"])
  }

  @Test("marks the whole breakdown unpriced when nothing in scope carried a rate")
  func allUnpriced() {
    let cost = Pricing.costOfByModel(["mystery-model": TokenUsage(input: 10)])
    #expect(cost.unpriced)
  }

  @Test("is not unpriced when there is simply nothing to price")
  func emptyIsNotUnpriced() {
    #expect(Pricing.costOfByModel([:]).unpriced == false)
  }
}

@Suite("tokenUsageFromWire")
struct PricingWireTests {
  @Test("reads the claude-shaped aggregate every engine emits")
  func aggregate() {
    let wire = JSONValue.object([
      "input_tokens": .number(10), "output_tokens": .number(20),
      "cache_creation_input_tokens": .number(30), "cache_read_input_tokens": .number(40),
    ])
    #expect(
      Pricing.tokenUsageFromWire(wire)
        == usage(input: 10, output: 20, cacheWrite5m: 30, cacheRead: 40))
  }

  @Test("prefers the explicit 5m/1h split when the engine provided one")
  func split() {
    let wire = JSONValue.object([
      "input_tokens": .number(1), "cache_creation_input_tokens": .number(30),
      "cache_creation": .object([
        "ephemeral_5m_input_tokens": .number(10), "ephemeral_1h_input_tokens": .number(20),
      ]),
    ])
    let parsed = Pricing.tokenUsageFromWire(wire)
    #expect(parsed.cacheWrite5m == 10)
    #expect(parsed.cacheWrite1h == 20)
  }

  @Test("survives junk without inventing tokens")
  func junk() {
    #expect(Pricing.tokenUsageFromWire(nil) == .empty)
    #expect(Pricing.tokenUsageFromWire(.string("nope")) == .empty)
    #expect(
      Pricing.tokenUsageFromWire(
        .object(["input_tokens": .number(-5), "output_tokens": .number(.nan)])) == .empty)
  }
}

@Suite("pricing accumulation")
struct PricingAccumulationTests {
  @Test("adds usage without mutating either operand")
  func adds() {
    let a = usage(input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5)
    let b = usage(input: 10, output: 20, cacheWrite5m: 30, cacheWrite1h: 40, cacheRead: 50)
    #expect(
      a.adding(b) == usage(input: 11, output: 22, cacheWrite5m: 33, cacheWrite1h: 44, cacheRead: 55))
    #expect(a.input == 1)
  }

  @Test("merges per-model records model by model")
  func merges() {
    let base: ByModel = ["claude-opus-5": TokenUsage(input: 5)]
    let add: ByModel = [
      "claude-opus-5": TokenUsage(input: 7), "claude-haiku-4-5": TokenUsage(output: 3),
    ]
    let merged = Pricing.merge(base, add)
    #expect(merged["claude-opus-5"]?.input == 12)
    #expect(merged["claude-haiku-4-5"]?.output == 3)
    #expect(base["claude-opus-5"]?.input == 5)
  }

  @Test("counts every token kind in the total")
  func total() {
    #expect(usage(input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5).total == 15)
    #expect(Pricing.totalTokens(["a": TokenUsage(input: 2), "b": TokenUsage(output: 3)]) == 5)
  }
}

@Suite("meteredCost")
struct PricingMeteredTests {
  @Test("excludes cache reads, which a plan window does not meter")
  func excludesReads() {
    let cost = Pricing.costOf(
      usage(input: 1_000_000, output: 1_000_000, cacheRead: 100_000_000), model: "claude-opus-5")
    #expect(abs(Pricing.meteredCost(cost) - 30) < 0.0001)
    #expect(cost.total > Pricing.meteredCost(cost))
  }
}

@Suite("subscriptionComparison")
struct PricingSubscriptionTests {
  @Test("compares a week of spend against the weekly share of a monthly fee")
  func compares() {
    let result = Pricing.subscriptionComparison(weeklyUsd: 92.31, monthlyUsd: 200)
    #expect(abs((result?.weeklyShareUsd ?? 0) - 46.15) < 0.1)
    #expect(abs((result?.ratio ?? 0) - 2) < 0.1)
  }

  @Test("declines to compare against an unset fee")
  func declines() {
    #expect(Pricing.subscriptionComparison(weeklyUsd: 10, monthlyUsd: 0) == nil)
    #expect(Pricing.subscriptionComparison(weeklyUsd: 10, monthlyUsd: .nan) == nil)
  }
}

@Suite("the bundled table")
struct PricingTableTests {
  @Test("prices every model the codex catalog can select")
  func codexModels() {
    for model in ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"]
    {
      #expect(Pricing.defaultTable[model] != nil, "\(model)")
    }
  }

  @Test("never prices output below input")
  func outputNeverBelowInput() {
    for (model, rate) in Pricing.defaultTable {
      #expect(rate.output >= rate.input, "\(model)")
      #expect(rate.cacheRead < rate.input, "\(model)")
    }
  }
}
