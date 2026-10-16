import Foundation
import Observation
import SwiftUI
import WorkerDeckKit

// The suggestion list for the prompt tokens. `/` filters commands and skills locally, `#` the other sessions on the
// gateway, and `@` searches the host filesystem: debounced, single-flight, and switched off for the session after a
// 404, since a gateway without host files will not grow them while the screen is open.
@MainActor
@Observable
final class PromptCompletionModel {
  enum Suggestion: Identifiable, Equatable {
    case file(HostFileMatch)
    case command(SlashCommandInfo)
    case skill(SkillInfo)
    case session(PeerSession)

    var id: String {
      switch self {
      case .file(let match): "@\(match.relative)"
      case .command(let command): "/\(command.name)"
      case .skill(let skill): "skill:\(skill.name)"
      case .session(let peer): "session:\(peer.id)"
      }
    }

    // What replaces the token, without its sigil. A skill types its whole literal: the engine's own opener, else
    // codex's `$name`.
    var value: String {
      switch self {
      case .file(let match): return match.relative
      case .command(let command): return command.name
      case .skill(let skill):
        let opener = skill.defaultPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let base = opener.isEmpty ? "$\(skill.name)" : opener
        return base.hasSuffix(" ") ? base : base + " "
      case .session(let peer): return peer.slug
      }
    }
  }

  private(set) var suggestions: [Suggestion] = []
  private(set) var isActive = false
  var peers: [PeerSession] = []
  var commands: [SlashCommandInfo] = []
  var skills: [SkillInfo] = []
  var findFiles: (@Sendable (String) async throws -> [HostFileMatch])? {
    didSet {
      filesUnsupported = false
      cancel()
    }
  }

  var names: PromptTokenNames {
    PromptTokenNames(skills: Set(skills.map(\.name)), sessions: Set(peers.map { PeerMentions.key($0.slug) }))
  }

  var isOpen: Bool { isActive && !suggestions.isEmpty }

  private var task: Task<Void, Never>?
  private var filesUnsupported = false
  private var lastQuery: String?

  private nonisolated static let fileLimit = 8
  private static let debounce: Duration = .milliseconds(150)

  func update(for text: String, cursor: String.Index?) {
    guard let token = PromptTokens.active(in: text, at: cursor ?? text.endIndex) else {
      cancel()
      return
    }
    switch token.kind {
    case .command: showCommands(matching: token.query.lowercased())
    case .session: showSessions(matching: token.query.lowercased())
    case .file: searchFiles(matching: token.query)
    case .skill: cancel()
    }
  }

  // The token is re-read from the draft as it is now: replacing a range remembered from when the list was built
  // would corrupt a draft that moved on.
  func accept(_ suggestion: Suggestion, in text: String, cursor: String.Index?) -> (text: String, cursor: String.Index) {
    let caret = cursor ?? text.endIndex
    defer { cancel() }
    guard let token = PromptTokens.active(in: text, at: caret) else { return (text, caret) }
    if case .skill = suggestion { return PromptTokens.replace(with: suggestion.value, replacing: token, in: text) }
    return PromptTokens.apply(suggestion.value, replacing: token, in: text)
  }

  func cancel() {
    task?.cancel()
    task = nil
    lastQuery = nil
    suggestions = []
    isActive = false
  }

  private func showCommands(matching needle: String) {
    settleLocal()
    let commands = commands.filter { needle.isEmpty || $0.matches(prefix: needle) }.map(Suggestion.command)
    let skills = skills.filter { $0.enabled && (needle.isEmpty || $0.matches(prefix: needle)) }.map(Suggestion.skill)
    suggestions = Array((commands + skills).prefix(20))
  }

  private func showSessions(matching needle: String) {
    settleLocal()
    suggestions = peers.filter { needle.isEmpty || $0.matches(prefix: needle) }.prefix(20).map(Suggestion.session)
  }

  private func settleLocal() {
    task?.cancel()
    task = nil
    lastQuery = nil
    isActive = true
  }

  private func searchFiles(matching query: String) {
    guard !filesUnsupported, let findFiles else {
      cancel()
      return
    }
    guard query != lastQuery else { return }
    lastQuery = query
    isActive = true
    task?.cancel()
    task = Task {
      try? await Task.sleep(for: Self.debounce)
      guard !Task.isCancelled else { return }
      do {
        let matches = try await findFiles(query)
        guard !Task.isCancelled else { return }
        suggestions = matches.prefix(Self.fileLimit).map(Suggestion.file)
      } catch let error as WorkerClientError where error.statusCode == 404 {
        filesUnsupported = true
        cancel()
      } catch {
        suggestions = []
      }
    }
  }

  nonisolated static var fileSearchLimit: Int { 8 }

  // The gateway's sessions as `#` offers them: this one dropped, newest first.
  nonisolated static func peerSessions(_ rows: [SessionInfo], excluding sessionId: String) -> [PeerSession] {
    rows
      .filter { $0.id != sessionId }
      .sorted { ($0.lastActivityAt ?? $0.createdAt) > ($1.lastActivityAt ?? $1.createdAt) }
      .map {
        PeerSession(
          id: $0.id, slug: PeerMentions.slug(title: $0.title, id: $0.id), label: sessionLabel($0),
          detail: [$0.engine?.rawValue, $0.project?.name, $0.status.rawValue].compactMap { $0 }.joined(separator: " · "))
      }
  }
}

struct PeerSession: Identifiable, Equatable, Sendable {
  let id: String
  // What the composer writes after the `#`, and what the gateway folds to resolve it.
  let slug: String
  let label: String
  let detail: String

  fileprivate func matches(prefix needle: String) -> Bool {
    ([slug, label] + slug.split(separator: "-").map(String.init)).contains { $0.lowercased().hasPrefix(needle) }
  }
}

extension SlashCommandInfo {
  // The name, its aliases and a namespaced command's bare name: "wrapup" finds "dev:wrapup".
  fileprivate func matches(prefix needle: String) -> Bool {
    ([name] + (aliases ?? []) + name.split(separator: ":").map(String.init)).contains {
      $0.lowercased().hasPrefix(needle)
    }
  }
}

extension SkillInfo {
  fileprivate func matches(prefix needle: String) -> Bool {
    ([name] + name.split(whereSeparator: { "-:_".contains($0) }).map(String.init)).contains {
      $0.lowercased().hasPrefix(needle)
    }
  }
}

// A fixed height, so the row under a finger does not move as the filter narrows.
struct PromptSuggestionList: View {
  let suggestions: [PromptCompletionModel.Suggestion]
  let onAccept: (PromptCompletionModel.Suggestion) -> Void

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(suggestions) { suggestion in
          Button {
            onAccept(suggestion)
          } label: {
            PromptSuggestionRow(suggestion: suggestion)
              .padding(.horizontal, 14)
              .padding(.vertical, 8)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("Suggestion")
          if suggestion.id != suggestions.last?.id { Divider().padding(.leading, 14) }
        }
      }
    }
    .scrollIndicators(.hidden)
    .frame(maxWidth: .infinity)
    .frame(height: 240)
    .background(Color(.systemBackground))
    .overlay(alignment: .top) { Rectangle().fill(TerminalPalette.cellStroke).frame(height: 1) }
  }
}

private struct PromptSuggestionRow: View {
  let suggestion: PromptCompletionModel.Suggestion

  var body: some View {
    switch suggestion {
    case .file(let match):
      row(symbol: "doc", title: Fmt.lastComponent(match.relative), subtitle: match.relative, monoSubtitle: true)
    case .command(let command):
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text("/\(command.name)")
            .font(.system(.callout, design: .monospaced))
            .foregroundStyle(PromptTokenStyle.color(.command))
            .lineLimit(1)
          if let hint = command.argumentHint, !hint.isEmpty {
            Text(hint).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
          }
        }
        if let description = command.description, !description.isEmpty {
          Text(description).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .skill(let skill):
      row(
        symbol: "sparkles", title: skill.displayName ?? skill.name,
        subtitle: skill.shortDescription ?? skill.description ?? "Inserts a message you can edit")
    case .session(let peer):
      row(symbol: "person.2", title: peer.label, subtitle: peer.detail)
    }
  }

  private func row(symbol: String, title: String, subtitle: String, monoSubtitle: Bool = false) -> some View {
    HStack(spacing: 9) {
      Image(systemName: symbol).font(.caption).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.callout).lineLimit(1)
        Text(subtitle)
          .font(monoSubtitle ? .caption2.monospaced() : .caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(monoSubtitle ? .head : .tail)
      }
      Spacer(minLength: 0)
    }
  }
}
