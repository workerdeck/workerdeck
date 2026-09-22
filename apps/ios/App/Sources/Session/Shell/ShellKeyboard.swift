import SwiftUI
import UIKit
import WorkerDeckKit

/// The invisible first responder that turns typing into PTY bytes.
///
/// `UIKeyInput` rather than a `UITextView`: there is no document here to edit.
/// A terminal's stdin is a stream, the process owns the echo, and a text view
/// would insist on holding a copy of the line - which is how you end up fighting
/// autocorrect over a `git` flag and watching the field and the shell disagree
/// about what was typed.
struct ShellKeyboard: UIViewRepresentable {
  @Binding var focused: Bool
  let onKey: (VTKey) -> Void
  let onText: (String) -> Void

  func makeUIView(context: Context) -> ShellKeyInputView {
    let view = ShellKeyInputView()
    view.onKey = onKey
    view.onText = onText
    return view
  }

  func updateUIView(_ view: ShellKeyInputView, context: Context) {
    view.onKey = onKey
    view.onText = onText
    // Driven from state rather than on a press, so that dismissing the keyboard
    // by any other route (the strip's own button, an interactive dismiss) and
    // the responder agree about who is focused.
    if focused, !view.isFirstResponder {
      view.becomeFirstResponder()
    } else if !focused, view.isFirstResponder {
      view.resignFirstResponder()
    }
  }
}

final class ShellKeyInputView: UIView, UIKeyInput {
  var onKey: ((VTKey) -> Void)?
  var onText: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  override var canBecomeFirstResponder: Bool { true }

  // MARK: - UITextInputTraits

  // Everything the system would helpfully do to prose is wrong for a command
  // line: a capitalised `Git`, a smart quote in a `sed` expression or an
  // autocorrected flag all reach the process as exactly what was typed.
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
  var keyboardType: UIKeyboardType = .asciiCapable
  var returnKeyType: UIReturnKeyType = .default

  // MARK: - UIKeyInput

  /// Always true, and it has to be: `deleteBackward()` is only delivered while
  /// the responder claims to hold text, and a terminal has a line the process
  /// knows about even when this view holds nothing.
  var hasText: Bool { true }

  func insertText(_ text: String) {
    // The return key arrives as a newline; a PTY expects carriage return, which
    // is what `encode(.enter)` spells.
    if text == "\n" {
      onKey?(.enter)
      return
    }
    onText?(text)
  }

  func deleteBackward() {
    onKey?(.backspace)
  }

  // MARK: - Hardware keys

  /// A hardware keyboard's non-printing keys. `pressesBegan` rather than
  /// `keyCommands`, because a key command is a menu item: it fires once per
  /// press with no repeat, and holding an arrow down in `less` has to repeat.
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var handled = false
    for press in presses {
      guard let key = press.key, let mapped = Self.key(for: key) else { continue }
      onKey?(mapped)
      handled = true
    }
    if !handled { super.pressesBegan(presses, with: event) }
  }

  private static func key(for key: UIKey) -> VTKey? {
    if key.modifierFlags.contains(.control) {
      let characters = key.charactersIgnoringModifiers
      guard let first = characters.first, characters.count == 1 else { return nil }
      return .control(first)
    }
    switch key.keyCode {
    case .keyboardUpArrow: return .up
    case .keyboardDownArrow: return .down
    case .keyboardLeftArrow: return .left
    case .keyboardRightArrow: return .right
    case .keyboardHome: return .home
    case .keyboardEnd: return .end
    case .keyboardPageUp: return .pageUp
    case .keyboardPageDown: return .pageDown
    case .keyboardDeleteForward: return .delete
    case .keyboardEscape: return .escape
    case .keyboardTab: return .tab
    default: return nil
    }
  }
}
