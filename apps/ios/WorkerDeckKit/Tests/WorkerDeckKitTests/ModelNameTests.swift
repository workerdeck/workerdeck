import Testing

@testable import WorkerDeckKit

/// The port's fidelity is the point: these are the same cases the TS doc
/// comment states, so a drift in either direction fails here rather than being
/// noticed as "the phone spells the model differently".
@Suite("friendlyModel")
struct ModelNameTests {
  @Test("the documented examples, verbatim")
  func documented() {
    #expect(friendlyModel("claude-opus-5[1m]") == "Opus 5")
    #expect(friendlyModel("claude-haiku-4-5-20251001") == "Haiku 4.5")
    #expect(friendlyModel("gpt-5.6-luna") == "GPT-5.6 Luna")
    #expect(friendlyModel("gemini-2.5-pro") == "Gemini 2.5 Pro")
    #expect(friendlyModel("o3-mini") == "o3 Mini")
  }

  @Test("a family with no entry is capitalised, and a known one keeps its casing")
  func families() {
    #expect(friendlyModel("deepseek-3.2") == "DeepSeek 3.2")
    #expect(friendlyModel("glm-4.6") == "GLM 4.6")
    // GPT joins with a hyphen; everything else with a space.
    #expect(friendlyModel("gpt-5") == "GPT-5")
    #expect(friendlyModel("sonoma-2") == "Sonoma 2")
  }

  @Test("nothing in, nothing out — and an id it cannot parse comes back whole")
  func degenerate() {
    #expect(friendlyModel(nil) == nil)
    #expect(friendlyModel("") == nil)
    // 'claude' alone leaves no family token: better the raw id than an empty
    // string where a model name should be.
    #expect(friendlyModel("claude") == "claude")
  }

  @Test("a snapshot date is dropped, a version is not")
  func snapshots() {
    #expect(friendlyModel("claude-sonnet-4-20250514") == "Sonnet 4")
    // Eight digits is the rule; seven is a version-ish token and survives as one.
    #expect(friendlyModel("claude-sonnet-4-2025051") == "Sonnet 4.2025051")
  }
}
