import WorkerDeckKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
  @Environment(\.transcriptFont) private var transcriptFont

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
  /// Shell mode: the field is a host shell prompt and the send button runs the line
  /// rather than messaging the agent. Owned by the session view, because the same
  /// `onEdit` that detects the leading `!` also drives the completion list.
  let isShellMode: Bool
  /// Offered the first character typed into an empty field, before it is inserted.
  /// True swallows it — that is how `!` enters shell mode without becoming part of the
  /// command. See `RichTextEditor.onLeadingTrigger`.
  let onLeadingTrigger: (String) -> Bool
  let onEdit: (String, NSRange) -> Void
  let onSend: () -> Void
  let onStop: () -> Void
  let onAddMedia: () -> Void
  /// Leave shell mode. A phone has no Escape key, so the `!` in the gutter is the way
  /// out — the same glyph that says which mode you are in undoes it.
  let onExitShell: () -> Void

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
      if isShellMode {
        shellHint
      }
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
  /// Edge to edge, opaque, no radius and no glass — and **one** border, an accent
  /// rule along the top. It does not wait for focus, because the caret already
  /// says where focus is; that single line is the whole affordance, which is what
  /// an editor does and what a transcript with no boxes in it asks for.
  ///
  /// The buttons stop hiding, too. A glass circle is chat furniture; here they
  /// are glyphs in square cells on the field's own row — `+` to attach, `↵` to
  /// send — so an empty composer is one row tall instead of two, which is the
  /// point of this variant everywhere else in the app as well.
  private var docked: some View {
    VStack(spacing: 0) {
      // A row of its own rather than an overlay: the frames draw this stroke
      // *outside* the box it edges, so an overlay would eat the top padding and
      // land every glyph cell a rule's height high.
      rule
      barContent
    }
    .background(Color(.systemBackground).ignoresSafeArea(edges: .bottom))
    .animation(.easeOut(duration: 0.15), value: isShellMode)
  }

  private var barContent: some View {
    VStack(spacing: 0) {
      if !attachments.isEmpty {
        AttachmentStrip(store: attachments)
          .padding(.bottom, 8)
      }
      HStack(alignment: .center, spacing: TermComposerMetrics.gap) {
        gutterGlyph
        field
        TermGlyphButton(
          glyph: "\u{21B5}", label: "Send", action: onSend, glyphSize: style.base.pointSize)
          .disabled(!canSend)
      }
      if isShellMode {
        shellHint
          .padding(.leading, TermGlyphButton.side + TermComposerMetrics.gap)
      }
    }
    .padding(.horizontal, TermComposerMetrics.sidePadding)
    .padding(.top, TermComposerMetrics.topPadding)
    .padding(.bottom, TermComposerMetrics.bottomPadding)
  }

  /// **One** rule, along the top, and it does not wait for focus — the caret is
  /// what says where focus is. A bottom rule would draw a second edge with only
  /// the home indicator between them; a side border would take the gutter glyph
  /// off the column every transcript marker sits on.
  private var rule: some View {
    Rectangle()
      // Shell mode outranks the accent: it is on for the whole time the field is
      // focused and the rule is half of what makes the mode unmistakable.
      .fill(isShellMode ? TerminalPalette.color(.magenta) : Color.accentColor)
      .frame(height: TermComposerMetrics.rule)
  }

  /// What the mode is and how to leave it. Rendered only while shell mode is on, so the
  /// composer's resting height is untouched.
  private var shellHint: some View {
    Text("shell mode · tap ! to exit")
      .font(.system(size: style.base.pointSize * 0.85, design: .monospaced))
      .foregroundStyle(TerminalPalette.color(.dim))
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityHidden(true)
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
    if isShellMode {
      TermGlyphButton(
        glyph: "!", label: "Leave shell mode", tint: TerminalPalette.color(.magenta),
        action: onExitShell, glyphSize: style.base.pointSize)
    } else if isBusy {
      TermGlyphButton(
        glyph: "\u{2715}", label: "Interrupt", tint: TerminalPalette.color(.yellow), action: onStop,
        glyphSize: style.base.pointSize)
    } else if canAddMedia {
      TermGlyphButton(
        glyph: "+", label: "Add media", action: onAddMedia,
        glyphSize: style.base.pointSize)
        .disabled(!isEnabled)
    } else {
      Text(TermGlyph.prompt)
        .font(.system(size: style.base.pointSize, design: .monospaced))
        .foregroundStyle(TerminalPalette.color(.blue))
        .frame(width: TermGlyphButton.side, height: TermGlyphButton.side)
        .accessibilityHidden(true)
    }
  }

  /// The field's styling, from the same two inputs `RichTextEditor` derives it
  /// from — one derivation rather than two that have to agree.
  private var style: DraftStyle { DraftStyle(variant: variant, font: transcriptFont) }

  /// Expanded whenever there is something to act on: the keyboard is up, a draft
  /// is waiting, a photo is staged, or a turn is running and stopping it must stay
  /// one tap away.
  private var isExpanded: Bool {
    isFocused || !text.isEmpty || isBusy || !attachments.isEmpty
  }

  private var field: some View {
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        // Matched to `RichTextEditor`'s `textContainerInset`, so the placeholder
        // sits exactly where the first character will.
        Text(isShellMode ? "Run a command on the host" : "Message")
          // The field's own derivation, not a parallel spelling of it. It used
          // to be one: `DraftStyle` was a process-wide static written by
          // `RichTextEditor` during its own `makeUIView`, so a `Text` built in
          // the same pass read whatever the previous field had left there, and
          // the placeholder had to re-derive the rule by hand to be correct.
          .font(style.swiftUIFont)
          .foregroundStyle(.tertiary)
          .padding(.horizontal, style.containerInset.left)
          .padding(.vertical, style.containerInset.top)
          .allowsHitTesting(false)
      }
      RichTextEditor(
        text: $text,
        selection: $selection,
        isFocused: $isFocused,
        isEnabled: isEnabled,
        onEdit: onEdit,
        onImagePaste: pasteImage,
        onLeadingTrigger: onLeadingTrigger)
    }
  }

  /// Take a picture off the clipboard and stage it. Returns whether it did —
  /// see `RichTextEditor.onImagePaste` for why the answer suppresses the paste.
  ///
  /// **Raw bytes first, the decoded image only as a fallback.** A screenshot is
  /// PNG and the API takes PNG, so routing it through `UIPasteboard.image`
  /// would decode and re-encode it to JPEG for nothing — a lossy round trip
  /// that makes text in a screenshot, which is most of what gets pasted into an
  /// agent, measurably worse to read. `AttachmentNormalizer.file` keeps the
  /// exact bytes when the format and size already suit, and falls back to the
  /// same transcode everything else gets.
  private func pasteImage() -> Bool {
    guard canAddMedia, isEnabled else { return false }
    let board = UIPasteboard.general
    guard board.hasImages else { return false }
    for (type, mediaType) in Self.pasteboardImageTypes {
      guard let data = board.data(forPasteboardType: type.identifier) else { continue }
      let ext = type.preferredFilenameExtension ?? "img"
      guard let picked = AttachmentNormalizer.file(
        data: data, name: "pasted.\(ext)", mediaType: mediaType)
      else { continue }
      attachments.add(picked)
      return true
    }
    // A clipboard whose image is in some format we did not name — or was put
    // there as a live `UIImage` by another app — still pastes; it just costs a
    // transcode.
    guard let image = board.image,
      let picked = AttachmentNormalizer.image(image, name: "pasted.jpg", mediaType: nil)
    else { return false }
    attachments.add(picked)
    return true
  }

  /// The formats worth taking verbatim, in the order a clipboard usually offers
  /// them. Exactly `AttachmentNormalizer.acceptedImageTypes` — anything outside
  /// this set would be transcoded by the normalizer anyway, so asking the
  /// pasteboard for it buys nothing.
  private static let pasteboardImageTypes: [(UTType, String)] = [
    (.png, "image/png"), (.jpeg, "image/jpeg"), (.gif, "image/gif"), (.webP, "image/webp"),
  ]

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
    guard isEnabled else { return false }
    let typed = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    // A staged photo is not a shell command, and an upload in flight has nothing to do
    // with one either — in this mode the line alone decides.
    if isShellMode { return typed }
    guard !attachments.isUploading, !attachments.hasFailure else { return false }
    return typed || !attachments.isEmpty
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
/// No pill and no glass behind it, for the same reason. What it wears instead is
/// a **cell**: a rounded square, filled and outlined, that the glyph stands in. A
/// phone has no hover, so a bare glyph reads as text that happens to be tappable
/// — the cell is what says "control" before you touch it. Its size and radius are
/// `TermComposerMetrics`, which is where the design's units become points.
///
/// The cell is drawn **only while the button can act**. A send with nothing to
/// send has no cell at all, just the dim `\u{21B5}`, which is the one signal that
/// costs no layout and cannot be mistaken for a disabled-looking button. Tone
/// still carries the two states worth colouring on top of that: a running turn's
/// stop is yellow and shell mode is magenta. Send is deliberately **not** tinted
/// — the cell appearing is what "armed" means here.
private struct TermGlyphButton: View {
  /// The hit target, and the cell drawn in it. Deliberately larger than the glyph
  /// inside it — the target is what a finger needs, the glyph is what the grid
  /// needs.
  static let side = TermComposerMetrics.cell
  /// Taken from the field's own font rather than named as a constant: the
  /// composer types at `lineTextUIStyle` and that is a Dynamic Type style, so a
  /// hardcoded size would be right at one content-size category and wrong at
  /// every other one — and these glyphs sit *on the typed line*. Handed in
  /// rather than read off a static, so this button cannot be a render behind
  /// the field it sits on.
  let glyph: String
  let label: String
  /// `nil` = the theme's `dim`; set only for the two states worth colouring.
  var tint: Color?
  let action: () -> Void
  var glyphSize: CGFloat = UIFont.preferredFont(forTextStyle: lineTextUIStyle).pointSize

  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Text(glyph)
        .font(.system(size: glyphSize, design: .monospaced))
        .foregroundStyle(tint ?? TerminalPalette.color(isEnabled ? .bright : .dim))
    }
    .buttonStyle(TermGlyphButtonStyle(filled: isEnabled))
    .accessibilityLabel(label)
  }
}

/// Every measurement in the docked composer, taken from the Figma frames
/// `Prompt/Default`, `Prompt/Focus` and `Prompt/Dirty`.
///
/// Those frames are drawn over a **1170x2532 (@3x, 390pt) screenshot placed at
/// 585 units wide**, so one design unit is two device pixels — two thirds of a
/// point, not one. Reading the frames' numbers as points makes every one of them
/// half again too large, which is exactly the bug this type exists to prevent:
/// the conversion is applied once, here, and the raw frame numbers stay legible
/// beside it.
private enum TermComposerMetrics {
  private static let unit: CGFloat = 2.0 / 3.0

  static let cell = 48 * unit
  static let cellRadius = 8 * unit
  static let cellStroke = 1 * unit
  static let gap = 12 * unit
  static let sidePadding = 8 * unit
  static let topPadding = 8 * unit
  static let bottomPadding = 12 * unit
  static let rule = 2 * unit
}

/// The cell at rest and the wash under a finger, drawn as a `ButtonStyle` so the
/// press state is the system's own rather than a gesture this component tracks.
private struct TermGlyphButtonStyle: ButtonStyle {
  private static let radius = TermComposerMetrics.cellRadius

  let filled: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .frame(width: TermGlyphButton.side, height: TermGlyphButton.side)
      .background(
        RoundedRectangle(cornerRadius: Self.radius)
          .fill(filled ? TerminalPalette.cellFill : .clear)
          .overlay(
            RoundedRectangle(cornerRadius: Self.radius)
              .fill(configuration.isPressed ? TerminalPalette.pressedCell : .clear))
          .overlay(
            RoundedRectangle(cornerRadius: Self.radius)
              .strokeBorder(
                filled ? TerminalPalette.cellStroke : .clear,
                lineWidth: TermComposerMetrics.cellStroke)))
      .contentShape(Rectangle())
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
