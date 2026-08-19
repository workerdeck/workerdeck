import WorkerDeckKit
import SwiftUI

/// The prompt input, in whichever shape the transcript above it is wearing.
///
/// In `cards` it is a floating glass card. At rest it is the field and nothing
/// else, so a session being read is not competing with a row of buttons; once it
/// has focus, a draft, or a turn to stop, an action row unfolds underneath —
/// attach on the left, dismiss the keyboard and the one send/stop button on the
/// right.
///
/// In `terminal` it is docked along the foot of the screen instead: flat,
/// opaque, edge to edge, its buttons plain glyphs on the field's own row, and a
/// single rule along the top that turns accent on focus. See `docked`.
///
/// The draft, the caret and the focus flag are all the caller's: the `/command`
/// and `@file` picker is a screen-level overlay (`PromptSuggestionList`), and it
/// edits the same three things this does.
struct ComposerView: View {
  /// The transcript's variant reaches here through the same environment the rows
  /// read, so the composer matches what is above it without a parameter.
  @Environment(\.transcriptVariant) private var variant

  @Binding var text: String
  /// Caret in UTF-16 units — it decides which token is being completed and where
  /// an accepted suggestion lands.
  @Binding var selection: NSRange
  @Binding var isFocused: Bool
  let isBusy: Bool
  let isEnabled: Bool
  /// Files staged for the next message. Owned by the session view, because they
  /// outlive the composer's focus and are cleared on send.
  let attachments: ComposerAttachmentStore
  /// Whether the engine takes attachments at all (`capabilities.attachments`
  /// non-empty). False hides the plus button — an attach affordance the engine
  /// has no meaning for is not a choice.
  let canAddMedia: Bool
  let onEdit: (String, NSRange) -> Void
  let onSend: () -> Void
  let onStop: () -> Void
  let onAddMedia: () -> Void

  @ViewBuilder
  var body: some View {
    if variant.isTerminal { docked } else { card }
  }

  /// The chat shape: a floating glass card that unfolds an action row.
  private var card: some View {
    VStack(spacing: 6) {
      // Above the field, like the picture you are talking about should be.
      if !attachments.isEmpty {
        AttachmentStrip(store: attachments)
      }
      // At rest the field is the entire card: collapsed means no focus, no draft
      // and no turn running, so there is nothing a button could do here.
      field
      if isExpanded {
        actionRow
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 6)
    .glassPanel(cornerRadius: 24)
    .animation(.easeOut(duration: 0.18), value: isExpanded)
  }

  /// The terminal shape, and the same one VS Code's agent view wears: the
  /// composer is the *foot of the panel* rather than a card floating on it.
  ///
  /// Edge to edge, opaque, no radius and no glass — and **one** border, the rule
  /// along the top, which turns accent while the field has focus. That single
  /// blue line is the whole affordance, which is what an editor does and what a
  /// transcript with no boxes in it asks for.
  ///
  /// The buttons stop hiding, too. A glass circle is chat furniture; here they
  /// are characters on the same line as the field — `+` to attach, `↵` to send —
  /// so an empty composer is one row tall instead of two, which is the point of
  /// this variant everywhere else in the app as well.
  private var docked: some View {
    VStack(spacing: 0) {
      if !attachments.isEmpty {
        AttachmentStrip(store: attachments)
          .padding(.bottom, 8)
      }
      HStack(alignment: .bottom, spacing: 4) {
        gutterGlyph
          .padding(.bottom, glyphBaseline)
        field
        TermGlyphButton(
          glyph: "\u{21B5}", label: "Send", tint: canSend ? TerminalPalette.color(.blue) : nil,
          action: onSend
        )
        .disabled(!canSend)
        .padding(.bottom, glyphBaseline)
      }
    }
    .padding(.horizontal, 6)
    // Air on each side of the prompt, inside the two rules. A plain 8, not a
    // fraction of the line: this is chrome between two rules, not a transcript
    // row, and the whole-multiple rule governs rows.
    .padding(.vertical, 8)
    // Opaque and reaching past the home indicator: a docked bar with the
    // transcript's background showing under it is not docked.
    .background(Color(.systemBackground).ignoresSafeArea(edges: .bottom))
    // **Two** rules, top and bottom, both turning accent on focus — the CLI's
    // own frame for its prompt, and what makes the field its own strip of the
    // screen rather than the transcript's last row. A side border would take
    // the gutter glyph off the column every transcript marker sits on, which is
    // the one thing this shape exists to hold.
    .overlay(alignment: .top) { rule }
    .overlay(alignment: .bottom) { rule }
    .animation(.easeOut(duration: 0.15), value: isFocused)
  }

  private var rule: some View {
    Rectangle()
      .fill(isFocused ? Color.accentColor : Color.primary.opacity(0.15))
      .frame(height: isFocused ? 1.5 : 0.5)
  }

  /// The composer's **gutter cell** — the column every transcript row's marker
  /// sits in, so whatever stands here cannot move the text beside it. It holds
  /// one of three things, in this order:
  ///
  /// `\u{2715}` **while the session is working**, because the gutter is where the eye
  /// already is and stop is the only action that matters mid-run. The condition
  /// is `isBusy` **alone**, not `isBusy && !canSend`: with send living on the
  /// other side of the field there is no slot to compete for. Under the old
  /// test, typing a follow-up mid-run replaced stop with send and left no way to
  /// stop the turn at all.
  ///
  /// A cross rather than a `\u{25A0}`: the square reads as a *state* ("stopped") in a
  /// column where `\u{25CF}` and `\u{25C6}` really are states, so it looked like a status
  /// marker rather than something to press.
  ///
  /// `+` **otherwise**, when there is anything to attach.
  ///
  /// `\u{276F}` when neither applies, so the column is never empty and the typed line
  /// never shifts as the session starts and stops. Blue, not the brand's coral:
  /// coral is the *working* mark, and a prompt waiting for you is not the
  /// session working.
  @ViewBuilder
  private var gutterGlyph: some View {
    if isBusy {
      TermGlyphButton(
        glyph: "\u{2715}", label: "Interrupt", tint: TerminalPalette.color(.yellow), action: onStop)
    } else if canAddMedia {
      TermGlyphButton(glyph: "+", label: "Add media", action: onAddMedia)
        .disabled(!isEnabled)
    } else {
      Text(TermGlyph.prompt)
        .font(.system(size: TermGlyphButton.glyphSize, design: .monospaced))
        .foregroundStyle(TerminalPalette.color(.blue))
        .frame(width: TermGlyphButton.side, height: TermGlyphButton.side)
        .accessibilityHidden(true)
    }
  }

  /// How far a glyph has to lift off the bottom to sit on the field's **last
  /// line** rather than on the field's bottom edge.
  ///
  /// `.bottom` alignment centres a 34pt button on the field's bottom 34pt, which
  /// includes the text container's 8pt inset — so the glyph rides low by exactly
  /// half the difference. Computed from the live font rather than nudged by a
  /// constant, because `DraftStyle.base` is a Dynamic Type font: at accessibility
  /// sizes a hardcoded offset would be wrong in the other direction.
  private var glyphBaseline: CGFloat {
    let inset = DraftStyle.containerInset.bottom
    return max(0, inset + DraftStyle.base.lineHeight / 2 - TermGlyphButton.side / 2)
  }

  /// Expanded whenever there is something to act on: the keyboard is up, a draft
  /// is waiting, a photo is staged, or a turn is running and stopping it must stay
  /// one tap away.
  private var isExpanded: Bool {
    isFocused || !text.isEmpty || isBusy || !attachments.isEmpty
  }

  /// The placeholder's font, matching what `RichTextEditor` will set on the
  /// text view: monospaced at the transcript's size under `terminal` (the theme
  /// is monospace by construction), body otherwise.
  private var placeholderFont: Font {
    variant.isTerminal ? .system(.subheadline, design: .monospaced) : .body
  }

  private var field: some View {
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        // Matched to `RichTextEditor`'s `textContainerInset`, so the placeholder
        // sits exactly where the first character will.
        Text("Message")
          // Derived from the variant, **not** read off `DraftStyle`: that is a
          // process-wide static written by `RichTextEditor` during its own
          // `makeUIView`, so a `Text` built in the same pass reads whatever the
          // previous field left there. Spelled from the same two inputs
          // instead, which is the only version that cannot be a render behind.
          .font(placeholderFont)
          .foregroundStyle(.tertiary)
          .padding(.horizontal, DraftStyle.containerInset.left)
          .padding(.vertical, DraftStyle.containerInset.top)
          .allowsHitTesting(false)
      }
      RichTextEditor(
        text: $text,
        selection: $selection,
        isFocused: $isFocused,
        isEnabled: isEnabled,
        onEdit: onEdit)
    }
  }

  /// Attach on the left; dismiss and send on the right. There is deliberately no
  /// dictate button — iOS puts a microphone on the keyboard itself, right where a
  /// thumb already is, and a second one here would only compete with it.
  private var actionRow: some View {
    HStack(spacing: 8) {
      if canAddMedia {
        CircleButton(systemImage: "plus", label: "Add media", action: onAddMedia)
          .disabled(!isEnabled)
      }
      Spacer(minLength: 0)
      if isFocused {
        CircleButton(systemImage: "keyboard.chevron.compact.down", label: "Hide keyboard") {
          dismissKeyboard()
        }
      }
      sendButton
    }
    .padding(.horizontal, 4)
    .padding(.bottom, 2)
  }

  /// One button, two jobs. A draft always sends — messages queue behind a running
  /// turn, and taking that away to make room for stop would be a downgrade. Stop
  /// takes the slot only while a turn is live *and* there is nothing to send.
  @ViewBuilder
  private var sendButton: some View {
    if isBusy, !canSend {
      Button(action: onStop) {
        Image(systemName: "stop.fill")
          .font(.footnote)
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(Color.red.opacity(0.85), in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop the current turn")
    } else {
      Button(action: onSend) {
        Image(systemName: "arrow.up")
          .font(.body.weight(.semibold))
          .foregroundStyle(canSend ? Color.white : Color.secondary)
          .frame(width: 34, height: 34)
          .background(canSend ? Color.accentColor : Color.secondary.opacity(0.2), in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
  }

  /// A photo on its own is a message — the send button does not wait for text.
  /// It does wait for the upload, so an id that hasn't landed can't be named.
  private var canSend: Bool {
    guard isEnabled, !attachments.isUploading, !attachments.hasFailure else { return false }
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
  }
}

/// The action row's shape: a glass circle around an SF Symbol.
///
/// `.plain` keeps the glass from being repainted by the button style, and takes
/// the automatic disabled dimming with it — hence the explicit opacity, so a
/// closed session's buttons read as unavailable rather than broken.
private struct CircleButton: View {
  let systemImage: String
  let label: String
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .frame(width: 34, height: 34)
        .glassPill()
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.45)
    .accessibilityLabel(label)
  }
}

/// A composer action as a **character**, for the docked (terminal) shape.
///
/// A *character*, not an SF Symbol, and that is the whole point: this bar sits
/// on the transcript's grid, and the glyphs it draws are the ones the CLI draws
/// — `\u{276F}`, `+`, `\u{2715}`, `\u{21B5}`. A symbol is a picture of a button; these are the
/// same vocabulary as the markers in the column above, so the furniture reads as
/// part of the conversation rather than as chat chrome parked underneath it.
///
/// No pill and no glass behind it, for the same reason. What replaces them is
/// tone: the two states worth colouring are coloured (an armed send is blue, a
/// running turn's stop is yellow) and everything else is the theme's `dim`.
private struct TermGlyphButton: View {
  /// The hit target. 34pt is the smallest that still reads as a button under a
  /// thumb, and it is deliberately larger than the glyph inside it — the target
  /// is what a finger needs, the glyph is what the grid needs.
  static let side: CGFloat = 34
  /// Taken from the field's own font rather than named as a constant: the
  /// composer types at `lineTextUIStyle` and that is a Dynamic Type style, so a
  /// hardcoded size would be right at one content-size category and wrong at
  /// every other one — and these glyphs sit *on the typed line*.
  static var glyphSize: CGFloat { DraftStyle.base.pointSize }

  let glyph: String
  let label: String
  /// `nil` = the theme's `dim`; set only for the two states worth colouring.
  var tint: Color?
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Text(glyph)
        .font(.system(size: Self.glyphSize, design: .monospaced))
        .foregroundStyle(tint ?? TerminalPalette.color(.dim))
        .frame(width: Self.side, height: Self.side)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.4)
    .accessibilityLabel(label)
  }
}

/// The staged files, as a scrolling row of chips above the field.
///
/// Each chip shows the thumbnail the phone already has, so nothing here waits on
/// the network; the upload's state rides on top of it (a spinner while in flight,
/// a warning badge if the gateway refused it) and the ✕ takes it back off.
private struct AttachmentStrip: View {
  let store: ComposerAttachmentStore

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(store.items) { item in
          AttachmentChip(item: item, onRetry: { store.retry(item) }, onRemove: { store.remove(item) })
        }
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
    }
    .frame(height: 62)
  }
}

private struct AttachmentChip: View {
  let item: ComposerAttachment
  let onRetry: () -> Void
  let onRemove: () -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      content
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.25)))
        .overlay(alignment: .center) { statusOverlay }
        // Tap to retry, and only when there is something to retry.
        .onTapGesture { if item.failure != nil { onRetry() } }
      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .font(.footnote)
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, Color.black.opacity(0.55))
      }
      .buttonStyle(.plain)
      .offset(x: 5, y: -5)
      .accessibilityLabel("Remove \(item.name)")
    }
    .padding(.top, 5)
    .padding(.trailing, 5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(item.failure.map { "\(item.name), failed: \($0). Tap to retry." } ?? item.name)
  }

  @ViewBuilder
  private var content: some View {
    if let thumbnail = item.thumbnail {
      Image(uiImage: thumbnail)
        .resizable()
        .scaledToFill()
    } else {
      VStack(spacing: 2) {
        Image(systemName: "doc")
          .font(.footnote)
        Text(fileExtension)
          .font(.system(size: 9, weight: .semibold))
          .lineLimit(1)
      }
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.secondary.opacity(0.16))
    }
  }

  @ViewBuilder
  private var statusOverlay: some View {
    switch item.state {
    case .uploading:
      ZStack {
        Color.black.opacity(0.35)
        ProgressView().controlSize(.small).tint(.white)
      }
    case .failed:
      ZStack {
        Color.black.opacity(0.45)
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(.orange)
      }
    case .ready:
      EmptyView()
    }
  }

  private var fileExtension: String {
    let ext = (item.name as NSString).pathExtension.uppercased()
    return ext.isEmpty ? "FILE" : ext
  }
}
