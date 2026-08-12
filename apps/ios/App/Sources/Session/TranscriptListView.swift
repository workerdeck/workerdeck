import WorkerDeckKit
import SwiftUI

/// The scrolling transcript, bottom-anchored.
///
/// Auto-scroll follows the tail *unless* the user has scrolled up, so reading
/// back through a long run isn't yanked away every time a delta lands. "Near the
/// bottom" is tracked with a sentinel row at the end of the `LazyVStack`: it is
/// only realized when the tail is inside the lazy render window, which is exactly
/// the condition we want and costs nothing to observe.
struct TranscriptListView: View {
  let items: [TranscriptItem]
  /// Change signal that also fires for streaming text (which doesn't grow `items`).
  let revision: Int

  @Environment(\.transcriptVariant) private var variant
  @Environment(\.transcriptDensity) private var density

  @State private var expanded: Set<String> = []
  @State private var isNearBottom = true

  private static let bottomAnchor = "transcript-bottom"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        // The one vertical separation between rows there is, which is what makes
        // it the whole of the density feature.
        LazyVStack(alignment: .leading, spacing: transcriptRowGap(variant, density)) {
          ForEach(items, id: \.rowID) { item in
            TranscriptItemView(item: item, isExpanded: expansion(item.rowID))
              .id(item.rowID)
          }
          Color.clear
            .frame(height: 1)
            .id(Self.bottomAnchor)
            .onAppear { isNearBottom = true }
            .onDisappear { isNearBottom = false }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .overlay(alignment: .bottomTrailing) {
        if !isNearBottom {
          JumpToBottomButton {
            withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
          }
          .padding(.trailing, 14)
          .padding(.bottom, 10)
        }
      }
      // Two triggers on purpose: a new row is worth animating, a streamed
      // character is not (animating every delta looks like a stutter).
      .onChange(of: items.count) { _, _ in
        guard isNearBottom else { return }
        withAnimation(.easeOut(duration: 0.18)) {
          proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
      }
      .onChange(of: revision) { _, _ in
        guard isNearBottom else { return }
        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
      }
      .onAppear {
        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
      }
    }
  }

  private func expansion(_ key: String) -> Binding<Bool> {
    Binding(
      get: { expanded.contains(key) },
      set: { open in
        if open {
          expanded.insert(key)
        } else {
          expanded.remove(key)
        }
      })
  }
}

private struct JumpToBottomButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.down")
        .font(.footnote.weight(.semibold))
        .padding(9)
        .background(.regularMaterial, in: Circle())
        .overlay(Circle().strokeBorder(Color.secondary.opacity(0.2)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Jump to latest")
  }
}
