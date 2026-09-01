import WorkerDeckKit
import SwiftUI
import UIKit

/// The composer's text view, and the app's only UIKit bridge.
///
/// SwiftUI's `TextField`/`TextEditor` can do neither of the two things a prompt
/// composer needs on this deployment target (17.0): render *part* of the draft
/// differently, and say where the caret is. Both come from the same place —
/// `UITextView` — so the bridge buys styled tokens and mid-message completion at
/// once, rather than one at a time.
///
/// Styling is applied to the `textStorage` rather than by replacing
/// `attributedText`: attribute-only edits leave the undo stack and the selection
/// alone, and cost nothing on a draft-sized string.
struct RichTextEditor: UIViewRepresentable {
  @Binding var text: String
  /// Caret (or selection) in UTF-16 units, the only currency `UITextView` deals in.
  @Binding var selection: NSRange
  @Binding var isFocused: Bool
  var isEnabled = true
  /// Grows to this many lines of body text, then scrolls.
  var maxLines = 6
  /// Text *and* caret, together, on every edit — deriving the caret from a
  /// separate `onChange` would race the text it belongs to.
  var onEdit: (String, NSRange) -> Void = { _, _ in }
  /// A paste carrying a picture. Returns **true** when it was taken as an
  /// attachment, which is also the instruction to drop the paste: a clipboard
  /// copied from a browser holds the image *and* its alt text, and inserting
  /// both would stage a photo and type a caption nobody asked for. The web
  /// client's rule, ported — `use-prompt-area-events.ts` returns the moment it
  /// finds an image, before it looks at a single text flavour.
  var onImagePaste: () -> Bool = { false }

  /// The reader's typeface preference, the same one the transcript above reads.
  /// A `UITextView` is outside SwiftUI's font environment entirely, so unlike
  /// every other piece of text in the panel this one has to be told.
  @Environment(\.transcriptFont) private var transcriptFont
  @Environment(\.transcriptVariant) private var transcriptVariant

  /// This render's styling — a value, so nothing is left behind for the next
  /// field to inherit.
  private var style: DraftStyle {
    DraftStyle(variant: transcriptVariant, font: transcriptFont)
  }

  /// The typeface, and the one place the variant outranks the preference.
  ///
  /// `transcriptFont` is a **Cards-only** setting everywhere else in the app,
  /// because the terminal theme is monospace *by construction* — that is its
  /// premise, not a preference expressed in it. The field had been following the
  /// preference regardless, so a terminal transcript drawn in a monospaced grid
  /// sat above a prompt typed in the system sans: the one row you author was the
  /// only row not on the grid. The web says the same thing in CSS, where the VS
  /// Code webview repoints `--cw-font-mono` unconditionally for exactly this
  /// reason.
  /// (Spelled once, in `DraftStyle.init(variant:font:)`; this stays as the
  /// place the reasoning lives.)

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = DraftTextView()
    view.delegate = context.coordinator
    // Through the coordinator rather than capturing `self`: this struct is
    // rebuilt every render and the view outlives each copy, so a captured
    // `onImagePaste` would be calling into a composer several states old.
    let coordinator = context.coordinator
    view.onImagePaste = { coordinator.parent.onImagePaste() }
    view.backgroundColor = .clear
    view.isScrollEnabled = false
    view.textContainerInset = DraftStyle.containerInset
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = true
    let style = self.style
    context.coordinator.style = style
    view.font = style.base
    view.typingAttributes = style.baseAttributes
    // A prompt carries paths, code and flags: curly quotes and em-dashes would
    // corrupt them silently.
    view.smartQuotesType = .no
    view.smartDashesType = .no
    view.smartInsertDeleteType = .no
    view.keyboardDismissMode = .interactive
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.isApplyingBinding = true
    defer { context.coordinator.isApplyingBinding = false }

    if view.text != text {
      view.text = text
    }
    // Before the restyle, which paints `baseAttributes` over the whole draft:
    // that is what carries a font change through to text already typed.
    let style = self.style
    if context.coordinator.style != style {
      context.coordinator.style = style
      view.font = style.base
    }
    style.restyle(view)

    let clamped = clamp(selection, to: view.text as NSString)
    if view.selectedRange != clamped {
      view.selectedRange = clamped
    }
    view.isEditable = isEnabled

    // Async: first-responder changes made inside an update pass re-enter layout,
    // and UIKit complains about it.
    if isFocused != view.isFirstResponder {
      let shouldFocus = isFocused
      DispatchQueue.main.async {
        guard shouldFocus != view.isFirstResponder else { return }
        _ = shouldFocus ? view.becomeFirstResponder() : view.resignFirstResponder()
      }
    }
  }

  /// Height follows the content until it hits `maxLines`, then the view scrolls —
  /// the growing-composer behaviour `TextField(axis: .vertical)` gave for free.
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context)
    -> CGSize?
  {
    guard let width = proposal.width, width > 0 else { return nil }
    let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    let ceiling = maxHeight(for: uiView)
    uiView.isScrollEnabled = fitting.height > ceiling
    return CGSize(width: width, height: min(fitting.height, ceiling))
  }

  private func maxHeight(for view: UITextView) -> CGFloat {
    let line = (view.font ?? style.base).lineHeight
    return line * CGFloat(maxLines) + view.textContainerInset.top
      + view.textContainerInset.bottom
  }

  /// The parent can shorten the draft (sending clears it) while the caret still
  /// points into the old one.
  private func clamp(_ range: NSRange, to text: NSString) -> NSRange {
    let location = min(max(range.location, 0), text.length)
    return NSRange(location: location, length: min(range.length, text.length - location))
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: RichTextEditor
    /// This field's styling, held here because the delegate below runs with
    /// nothing in hand but the view — which is exactly what the process-wide
    /// statics used to be working around.
    var style = DraftStyle(variant: .cards, font: .regular)
    /// True while `updateUIView` is writing into the view. The delegate fires
    /// synchronously from those writes, and reporting them back as user edits
    /// would both loop and mutate SwiftUI state mid-update.
    var isApplyingBinding = false

    init(_ parent: RichTextEditor) {
      self.parent = parent
    }

    func textViewDidChange(_ view: UITextView) {
      guard !isApplyingBinding else { return }
      style.restyle(view)
      parent.text = view.text
      parent.selection = view.selectedRange
      parent.onEdit(view.text, view.selectedRange)
    }

    func textViewDidChangeSelection(_ view: UITextView) {
      guard !isApplyingBinding, parent.selection != view.selectedRange else { return }
      parent.selection = view.selectedRange
      parent.onEdit(view.text, view.selectedRange)
    }

    func textViewDidBeginEditing(_ view: UITextView) {
      guard !parent.isFocused else { return }
      parent.isFocused = true
    }

    func textViewDidEndEditing(_ view: UITextView) {
      guard parent.isFocused else { return }
      parent.isFocused = false
    }
  }
}

/// The composer's text view, subclassed for one reason: a pasted picture.
///
/// `UITextViewDelegate` has no paste hook — `shouldChangeTextIn` sees the text a
/// paste produced, never the pasteboard it came from, and by then the image is
/// already gone. `paste(_:)` is the only place the clipboard is still whole.
final class DraftTextView: UITextView {
  /// Returns true when the paste was consumed as an attachment.
  var onImagePaste: (() -> Bool)?

  override func paste(_ sender: Any?) {
    if onImagePaste?() == true { return }
    super.paste(sender)
  }

  /// Without this an image-only clipboard has no Paste item at all: a
  /// `UITextView` offers Paste when the pasteboard holds *text*, and a
  /// screenshot holds none. The check is `hasImages`, which is a detection
  /// query and does not raise the system's paste prompt — the prompt belongs on
  /// the tap, not on the menu appearing.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
    return super.canPerformAction(action, withSender: sender)
  }
}

/// Draft styling: the same rules `PromptTokenStyle` uses in the transcript, in the
/// vocabulary UIKit needs, so a token looks identical before and after sending.
///
/// **A value, derived from its two inputs.** `design` and `textStyle` were
/// process-wide mutable statics, written by `RichTextEditor` during its own
/// `makeUIView`/`updateUIView` and read by anyone — which is a cache of a
/// preference dressed as a constant, and it bit: the composer's placeholder read
/// it during the same render pass and got the *previous* field's font, so the
/// placeholder had to be re-derived from the variant by hand, which is two
/// spellings of one rule. Any second text field in the app would have inherited
/// whatever the last one set.
///
/// Constructed from `(variant, font)`, so the placeholder and the field are the
/// same derivation rather than two that have to agree, and threaded to the
/// delegate through the coordinator — which is what the statics were really
/// working around: `restyle` runs from a `UITextViewDelegate` with nothing in
/// hand but the view.
struct DraftStyle: Equatable {
  var design: UIFontDescriptor.SystemDesign
  var textStyle: UIFont.TextStyle

  /// The one derivation. `variant` outranks `font` — see
  /// `RichTextEditor.wantedDesign` for why the terminal theme is monospace by
  /// construction rather than by preference.
  init(variant: TranscriptVariant, font: TranscriptFont) {
    design = variant.isTerminal ? .monospaced : font.uiDesign
    textStyle = variant.isTerminal ? lineTextUIStyle : .body
  }

  /// The field's own padding. A genuine constant, so it stays static: three
  /// places need to agree with it — the text view, the placeholder that has to
  /// land exactly where the first character will, and the composer's glyph
  /// buttons, which sit on the *last line's* box rather than on the field's
  /// bottom edge.
  static let containerInset = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)

  /// Dynamic Type's body font in the chosen design. Built from the descriptor
  /// rather than `monospacedSystemFont(ofSize:)` so it keeps tracking the
  /// content-size category — `adjustsFontForContentSizeCategory` needs a font
  /// that came from a text style.
  var base: UIFont {
    let body = UIFont.preferredFont(forTextStyle: textStyle)
    guard let descriptor = body.fontDescriptor.withDesign(design) else { return body }
    return UIFont(descriptor: descriptor, size: 0)
  }

  /// The same face for SwiftUI, which is what the placeholder needs. A mapping
  /// rather than `Font(base)`: that would freeze the resolved size, and this one
  /// keeps scaling with Dynamic Type the way the field does.
  ///
  /// A `switch` on the style rather than `textStyle == lineTextUIStyle`, which
  /// hardcoded what `lineTextUIStyle` happens to *be*: repoint that constant and
  /// the field, the glyphs and `glyphBaseline` all follow it (they derive from
  /// `base`) while the placeholder would silently keep the old size and stop
  /// landing on the first character — the placeholder's one job, and the same
  /// two-spellings-of-one-rule this type was rewritten to end.
  var swiftUIFont: Font {
    let scale: Font.TextStyle =
      switch textStyle {
      case .largeTitle: .largeTitle
      case .title1: .title
      case .title2: .title2
      case .title3: .title3
      case .headline: .headline
      case .subheadline: .subheadline
      case .callout: .callout
      case .footnote: .footnote
      case .caption1: .caption
      case .caption2: .caption2
      default: .body
      }
    return .system(scale, design: design == .monospaced ? .monospaced : .default)
  }

  var baseAttributes: [NSAttributedString.Key: Any] {
    [.font: base, .foregroundColor: UIColor.label]
  }

  static func tokenAttributes(_ kind: PromptToken.Kind) -> [NSAttributedString.Key: Any] {
    let size = UIFont.preferredFont(forTextStyle: .callout).pointSize
    return [
      .font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular),
      .foregroundColor: UIColor(PromptTokenStyle.color(kind)),
    ]
  }

  /// Repaint the draft. Only *confirmed* tokens are styled — the word still being
  /// typed stays plain, so the composer doesn't flicker on every keystroke.
  func restyle(_ view: UITextView) {
    // Mid-composition (IME, dictation): the marked range carries its own
    // attributes and rewriting them breaks the candidate UI.
    guard view.markedTextRange == nil else { return }

    let text = view.text ?? ""
    let storage = view.textStorage
    storage.beginEditing()
    storage.setAttributes(baseAttributes, range: NSRange(location: 0, length: storage.length))
    for token in PromptTokens.confirmed(in: text) {
      storage.addAttributes(
        Self.tokenAttributes(token.kind), range: NSRange(token.range, in: text))
    }
    storage.endEditing()
    // Otherwise the next character typed inherits the last token's monospace.
    view.typingAttributes = baseAttributes
  }
}
