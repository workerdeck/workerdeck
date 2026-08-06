import WorkerDeckKit
import SwiftUI

/// What a session shows before it has said anything: where the agent is sitting,
/// and what the composer accepts beyond prose.
///
/// **It gives way rather than pushing.** The screen it decorates shrinks a lot —
/// the keyboard takes half of it, landscape takes most of the rest — and the
/// composer must never end up underneath either. So it is sized from the height
/// it is actually given and sheds its parts in order of how little they say: the
/// icon first, then the path, then the hints. Below that it renders nothing at
/// all, which is the correct amount of decoration for a screen with no room.
///
/// Deliberately no project name: the navigation bar already carries it. And no
/// brand mark — the mark's geometry is inlined in four places already, and the
/// README asks that they stay identical.
struct SessionEmptyState: View {
  let cwd: String?
  /// Whether `/command` completion is live yet — the CLI reports its commands a
  /// beat after the session starts, and promising a feature that isn't wired up
  /// yet is worse than not mentioning it.
  let hasCommands: Bool
  /// Whether the engine has reported skills the `/` popover can offer. Its own
  /// flag, not a variant of `hasCommands`: what `/` does differs — a command is
  /// submitted, a skill is typed for you to edit — and an engine can have one
  /// without the other.
  var hasSkills: Bool = false
  let canBrowseFiles: Bool
  /// What the layout was actually offered, not what the screen is.
  let availableHeight: CGFloat

  @HotReloaded private var hot

  /// Height thresholds, measured against the real layout: the full form needs
  /// ~300pt, and the hint card alone ~150pt. Below the last one there is nothing
  /// worth drawing.
  private var showsIcon: Bool { availableHeight >= 320 }
  private var showsPath: Bool { availableHeight >= 230 }
  private var showsAnything: Bool { availableHeight >= 130 }

  var body: some View {
    if showsAnything {
      VStack(spacing: 18) {
        if showsIcon {
          Image(systemName: "terminal")
            .font(.system(size: 24, weight: .light))
            .foregroundStyle(.secondary)
            .frame(width: 58, height: 58)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        }

        if showsPath, let cwd {
          Text(cwd)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
            .padding(.horizontal, 24)
        }

        VStack(spacing: 0) {
          ForEach(Array(hints.enumerated()), id: \.offset) { index, hint in
            if index > 0 { Divider().padding(.leading, 46) }
            HStack(spacing: 12) {
              Image(systemName: hint.symbol)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(width: 22)
              Text(hint.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
          }
        }
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 20)
      }
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .contain)
    }
  }

  private struct Hint {
    let symbol: String
    let text: String
  }

  private var hints: [Hint] {
    // No resumed-thread caveat any more: every engine that resumes now replays
    // its history into the transcript (`resumeBackfill`), so a resumed session
    // doesn't reach this empty state — its history is on screen.
    var hints = [Hint(symbol: "text.bubble", text: "Tell me what to do")]
    // Two keys, two hints — different features, not two spellings of one. `$` is
    // codex's own sigil for skills; `/` stays the CLI's commands.
    if hasCommands {
      hints.append(Hint(symbol: "slash.circle", text: "Type / for the CLI's slash commands."))
    }
    if hasSkills {
      hints.append(Hint(symbol: "sparkles", text: "Type $ to draft a message for a skill."))
    }
    if canBrowseFiles {
      hints.append(Hint(symbol: "at", text: "Type @ to search this project's files."))
    }
    return hints
  }
}
