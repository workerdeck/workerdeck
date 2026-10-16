import SwiftUI
import UIKit

// The `+` cell's sheet: camera, photos and files. It closes the moment a source is picked, and the system picker
// presents after it, since stacking one on a half-height sheet fights the system.
struct AddMediaSheet: View {
  enum Source: String, Identifiable {
    case camera, photos, files
    var id: String { rawValue }
  }

  let acceptsImages: Bool
  let onChoose: (Source) -> Void

  @Environment(\.dismiss) private var dismiss

  private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

  var body: some View {
    VStack(spacing: 16) {
      ZStack {
        Text("Add Media").font(.headline)
        HStack {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(.secondary)
              .frame(width: 30, height: 30)
              .background(Color.secondary.opacity(0.18), in: Circle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close")
          Spacer(minLength: 0)
        }
      }
      HStack(spacing: 10) {
        if acceptsImages {
          tile(.camera, "Camera", "camera")
            .disabled(!cameraAvailable)
            .opacity(cameraAvailable ? 1 : 0.4)
          tile(.photos, "Photos", "photo")
        }
        tile(.files, "Files", "doc.badge.arrow.up")
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .presentationDetents([.height(196)])
    .presentationDragIndicator(.visible)
    .presentationBackground(.regularMaterial)
  }

  private func tile(_ source: Source, _ title: String, _ symbol: String) -> some View {
    Button {
      dismiss()
      onChoose(source)
    } label: {
      VStack(spacing: 10) {
        Image(systemName: symbol).font(.title2)
        Text(title).font(.subheadline)
      }
      .frame(maxWidth: .infinity)
      .frame(height: 104)
      .background(Color.secondary.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
      .contentShape(RoundedRectangle(cornerRadius: 16))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}

// SwiftUI has no camera view and `PhotosPicker` cannot take a new photo.
struct CameraPicker: UIViewControllerRepresentable {
  let onCapture: (UIImage) -> Void

  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let controller = UIImagePickerController()
    controller.sourceType = .camera
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture, dismiss: { dismiss() }) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let onCapture: (UIImage) -> Void
    private let dismiss: () -> Void

    init(onCapture: @escaping (UIImage) -> Void, dismiss: @escaping () -> Void) {
      self.onCapture = onCapture
      self.dismiss = dismiss
    }

    func imagePickerController(
      _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage { onCapture(image) }
      dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { dismiss() }
  }
}
