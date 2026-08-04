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

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.isScrollEnabled = false
    view.textContainerInset = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = true
    view.font = DraftStyle.base
    view.typingAttributes = DraftStyle.baseAttributes
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
    DraftStyle.restyle(view)

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
    let line = (view.font ?? DraftStyle.base).lineHeight
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
    /// True while `updateUIView` is writing into the view. The delegate fires
    /// synchronously from those writes, and reporting them back as user edits
    /// would both loop and mutate SwiftUI state mid-update.
    var isApplyingBinding = false

    init(_ parent: RichTextEditor) {
      self.parent = parent
    }

    func textViewDidChange(_ view: UITextView) {
      guard !isApplyingBinding else { return }
      DraftStyle.restyle(view)
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

/// Draft styling: the same rules `PromptTokenStyle` uses in the transcript, in the
/// vocabulary UIKit needs, so a token looks identical before and after sending.
@MainActor
enum DraftStyle {
  static var base: UIFont { .preferredFont(forTextStyle: .body) }

  static var baseAttributes: [NSAttributedString.Key: Any] {
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
  static func restyle(_ view: UITextView) {
    // Mid-composition (IME, dictation): the marked range carries its own
    // attributes and rewriting them breaks the candidate UI.
    guard view.markedTextRange == nil else { return }

    let text = view.text ?? ""
    let storage = view.textStorage
    storage.beginEditing()
    storage.setAttributes(baseAttributes, range: NSRange(location: 0, length: storage.length))
    for token in PromptTokens.confirmed(in: text) {
      storage.addAttributes(tokenAttributes(token.kind), range: NSRange(token.range, in: text))
    }
    storage.endEditing()
    // Otherwise the next character typed inherits the last token's monospace.
    view.typingAttributes = baseAttributes
  }
}
