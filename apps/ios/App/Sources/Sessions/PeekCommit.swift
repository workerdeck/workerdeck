import ObjectiveC
import UIKit

// SwiftUI's `.contextMenu` offers no action for a tap on its preview, so the preview only closes the menu. Its
// interaction delegate gets the UIKit callback added at runtime: a tap on the peek opens what `open` names.
@MainActor
enum PeekCommit {
  static var open: (() -> Void)?
  private static var patched: Set<ObjectIdentifier> = []

  static func install(near view: UIView) {
    var node: UIView? = view
    while let current = node {
      for case let interaction as UIContextMenuInteraction in current.interactions {
        if let delegate = interaction.delegate { patch(type(of: delegate)) }
      }
      node = current.superview
    }
  }

  private static func patch(_ cls: AnyClass) {
    guard patched.insert(ObjectIdentifier(cls)).inserted else { return }
    let selector = #selector(
      UIContextMenuInteractionDelegate.contextMenuInteraction(_:willPerformPreviewActionForMenuWith:animator:))
    let block: @convention(block) (AnyObject, UIContextMenuInteraction, UIContextMenuConfiguration, UIContextMenuInteractionCommitAnimating) -> Void = { _, _, _, animator in
      guard let open = PeekCommit.open else { return }
      animator.preferredCommitStyle = .dismiss
      animator.addCompletion { open() }
    }
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(cls, selector, imp, "v@:@@@"), let method = class_getInstanceMethod(cls, selector) {
      method_setImplementation(method, imp)
    }
  }
}
