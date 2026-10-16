import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The composer's field: a `UITextView`, because a SwiftUI field can neither style part of the draft nor say where
// the caret is, and completion needs both.
struct ComposerTextView: UIViewRepresentable {
  @Binding var text: String
  // Caret in UTF-16 units, the only currency `UITextView` deals in.
  @Binding var selection: NSRange
  @Binding var isFocused: Bool
  var isEnabled = true
  var isShellMode = false
  var tokens: (String) -> [TokenSpan] = { _ in [] }
  var maxLines = 6
  var onEdit: (String, NSRange) -> Void = { _, _ in }
  // True when the paste was taken as an attachment, which also drops the paste's alt text.
  var onImagePaste: () -> Bool = { false }
  // The first character typed into an empty field, offered before it is inserted; true swallows it. Clearing it from
  // `onEdit` instead would race the view writing it straight back.
  var onLeadingTrigger: (String) -> Bool = { _ in false }

  static var font: UIFont {
    let body = UIFont.preferredFont(forTextStyle: .body)
    guard let descriptor = body.fontDescriptor.withDesign(.monospaced) else { return body }
    return UIFont(descriptor: descriptor, size: 0)
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = DraftTextView()
    view.delegate = context.coordinator
    let coordinator = context.coordinator
    view.onImagePaste = { coordinator.parent.onImagePaste() }
    view.backgroundColor = .clear
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = true
    view.font = Self.font
    view.typingAttributes = Self.baseAttributes
    // Paths, code and flags: curly quotes and smart dashes would corrupt them silently.
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
    if view.text != text { view.text = text }
    Self.restyle(view, tokens: tokens)
    let clamped = clamp(selection, to: view.text as NSString)
    if view.selectedRange != clamped { view.selectedRange = clamped }
    view.isEditable = isEnabled
    view.accessibilityIdentifier = isShellMode ? "Shell command" : "Message"
    view.autocapitalizationType = isShellMode ? .none : .sentences
    view.autocorrectionType = isShellMode ? .no : .default
    view.tintColor = isShellMode ? TerminalPalette.uiColor(.magenta) : nil
    // Async: a first-responder change inside an update pass re-enters layout.
    if isFocused != view.isFirstResponder {
      let focus = isFocused
      DispatchQueue.main.async {
        guard focus != view.isFirstResponder else { return }
        _ = focus ? view.becomeFirstResponder() : view.resignFirstResponder()
      }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width > 0 else { return nil }
    let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    let ceiling = (uiView.font ?? Self.font).lineHeight * CGFloat(maxLines)
    uiView.isScrollEnabled = fitting.height > ceiling
    return CGSize(width: width, height: min(fitting.height, ceiling))
  }

  private func clamp(_ range: NSRange, to text: NSString) -> NSRange {
    let location = min(max(range.location, 0), text.length)
    return NSRange(location: location, length: min(range.length, text.length - location))
  }

  static var baseAttributes: [NSAttributedString.Key: Any] {
    [.font: font, .foregroundColor: TerminalPalette.uiColor(.fg)]
  }

  // Only confirmed tokens are styled: the word still being typed stays plain, so the draft does not flicker.
  static func restyle(_ view: UITextView, tokens: (String) -> [TokenSpan]) {
    guard view.markedTextRange == nil else { return }
    let text = view.text ?? ""
    let storage = view.textStorage
    storage.beginEditing()
    storage.setAttributes(baseAttributes, range: NSRange(location: 0, length: storage.length))
    for token in tokens(text) where Int(token.end) <= storage.length {
      storage.addAttributes(
        [.foregroundColor: UIColor(PromptTokenStyle.color(token.kind))],
        range: NSRange(location: Int(token.start), length: Int(token.end - token.start)))
    }
    storage.endEditing()
    view.typingAttributes = baseAttributes
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: ComposerTextView
    // True while `updateUIView` writes into the view: its delegate echoes are not user edits.
    var isApplyingBinding = false

    init(_ parent: ComposerTextView) { self.parent = parent }

    func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      guard !isApplyingBinding, view.text.isEmpty, range.location == 0, range.length == 0 else { return true }
      return !parent.onLeadingTrigger(text)
    }

    func textViewDidChange(_ view: UITextView) {
      guard !isApplyingBinding else { return }
      ComposerTextView.restyle(view, tokens: parent.tokens)
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
      if !parent.isFocused { parent.isFocused = true }
    }

    func textViewDidEndEditing(_ view: UITextView) {
      if parent.isFocused { parent.isFocused = false }
    }
  }
}

// `UITextViewDelegate` never sees the pasteboard, so a pasted picture is caught in `paste(_:)`.
final class DraftTextView: UITextView {
  var onImagePaste: (() -> Bool)?

  override func paste(_ sender: Any?) {
    if onImagePaste?() == true { return }
    super.paste(sender)
  }

  // An image-only clipboard holds no text, so without this there is no Paste item at all.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
    return super.canPerformAction(action, withSender: sender)
  }
}

// `@file`, `/command`, `$skill` and `#session` as the CLI writes them: tinted, no fill.
enum PromptTokenStyle {
  static func color(_ kind: TokenKind) -> Color {
    switch kind {
    case .file: TerminalPalette.color(.blue)
    case .command: .purple
    case .skill: .orange
    case .session: TerminalPalette.color(.green)
    }
  }
}
