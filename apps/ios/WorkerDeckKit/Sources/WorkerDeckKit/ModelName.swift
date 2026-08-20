import Foundation

/// The name a person says, from a wire model id — a 1:1 port of
/// `friendlyModel` in `packages/ui/src/lib/format.ts`.
///
/// - `claude-opus-5[1m]` → "Opus 5"
/// - `claude-haiku-4-5-20251001` → "Haiku 4.5"
/// - `gpt-5.6-luna` → "GPT-5.6 Luna"
/// - `gemini-2.5-pro` → "Gemini 2.5 Pro"
/// - `o3-mini` → "o3 Mini"
///
/// **A port, and it has to stay one.** A sessions list is the one surface where
/// the same person reads all three clients, and a model spelled `claude-opus-5`
/// on the phone and `Opus 5` in the sidebar is the same class of drift the
/// shared list view model exists to prevent. It lives here rather than in the
/// app for the reason everything else in this package does: `swift test` can
/// reach it, and this is a rule with edges.
///
/// Three kinds of token after the family, because vendors mix them freely: a
/// **version** (`5`, `4-5`, `5.6` — joined with dots, since Anthropic splits
/// what OpenAI writes as one token), a **code name or tier** (`luna`, `codex`,
/// `pro`, `mini` — kept and capitalised, since it is often the only thing
/// telling two models apart), and a **snapshot date** (`20251001` — dropped; it
/// is a build, not a version).
public func friendlyModel(_ id: String?) -> String? {
  guard let id, !id.isEmpty else { return nil }
  // The context-window variant suffix (`[1m]`) is a wire detail, and a list line
  // has no room to spend on it.
  let withoutVariant = id.split(separator: "[", maxSplits: 1).first.map(String.init) ?? id
  var parts = withoutVariant.lowercased().split(separator: "-").map(String.init)
  if parts.first == "claude" { parts.removeFirst() }
  guard !parts.isEmpty else { return id }
  let familyToken = parts.removeFirst()
  let family = modelFamilies[familyToken]
  let name =
    family?.name
    // OpenAI's reasoning series is lower-case by its own convention ('o3-mini'),
    // and "O3" reads as a different product.
    ?? (isReasoningSeries(familyToken) ? familyToken : capitalizedFirst(familyToken))

  var version: [String] = []
  var words: [String] = []
  for part in parts {
    if isSnapshotDate(part) { continue }
    if isVersion(part) {
      version.append(part)
    } else {
      words.append(capitalizedFirst(part))
    }
  }
  let versioned =
    version.isEmpty ? name : "\(name)\(family?.joiner ?? " ")\(version.joined(separator: "."))"
  return ([versioned] + words).joined(separator: " ")
}

private struct ModelFamily {
  let name: String
  var joiner: String?
}

private let modelFamilies: [String: ModelFamily] = [
  "gpt": ModelFamily(name: "GPT", joiner: "-"),
  "deepseek": ModelFamily(name: "DeepSeek"),
  "glm": ModelFamily(name: "GLM"),
  "qwen": ModelFamily(name: "Qwen"),
  "kimi": ModelFamily(name: "Kimi"),
  "llama": ModelFamily(name: "Llama"),
  "mistral": ModelFamily(name: "Mistral"),
  "grok": ModelFamily(name: "Grok"),
]

/// `o3`, `o4` — a letter `o` followed by digits and nothing else.
private func isReasoningSeries(_ token: String) -> Bool {
  guard token.first == "o", token.count > 1 else { return false }
  return token.dropFirst().allSatisfy(\.isNumber)
}

/// Exactly eight digits: a build date, not a version.
private func isSnapshotDate(_ token: String) -> Bool {
  token.count == 8 && token.allSatisfy(\.isNumber)
}

/// `5`, `4`, `5.6` — digits with at most one dot between them.
private func isVersion(_ token: String) -> Bool {
  var seenDot = false
  var digits = 0
  for character in token {
    if character.isNumber {
      digits += 1
    } else if character == "." && !seenDot && digits > 0 {
      seenDot = true
    } else {
      return false
    }
  }
  // A trailing dot ('5.') is not a version, and neither is an empty token.
  return digits > 0 && token.last != "."
}

private func capitalizedFirst(_ token: String) -> String {
  guard let first = token.first else { return token }
  return first.uppercased() + token.dropFirst()
}
