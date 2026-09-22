import SwiftUI
import WorkerDeckKit

/// The shell drill-in: one PTY, full width, with a keyboard.
///
/// The phone's shape for what `packages/ui`'s `ShellTerminal` does behind
/// `?shell=`, and it arrives the same way the sub-agent takeover does - a push,
/// so the way back is the navigation bar. Like that screen it is **not a second
/// attach**: it holds the session's one socket open (`holdOpen`) and rides the
/// same event stream, which is what lets the transcript keep reducing behind it.
///
/// What it is not is a transcript. The bytes here are a grid, not rows, and
/// nothing on this screen goes through the reducer.
struct ShellTerminalView: View {
  let model: ShellTerminalModel
  let vm: TranscriptViewModel

  @Environment(\.scenePhase) private var scenePhase
  @Environment(PushCoordinator.self) private var push
  @Environment(\.dismiss) private var dismiss

  @State private var keyboardFocused = false
  /// The strip's `ctrl` is a **latch**, not a held modifier: a phone has no way
  /// to hold one key while striking another, so it arms and the next character
  /// consumes it. Shown pressed while armed, or nobody could tell.
  @State private var controlArmed = false
  @State private var confirmKill = false

  private var typography: TerminalTypography { TerminalTypography.session }

  var body: some View {
    ShellGridView(
      screen: model.screen, revision: model.revision, typography: typography,
      onMeasure: { cols, rows in model.resize(cols: cols, rows: rows) }
    )
    .background(Color(uiColor: .systemBackground))
    .overlay(alignment: .topLeading) {
      // Zero-size and behind everything: it is a first responder, not a view.
      ShellKeyboard(focused: $keyboardFocused, onKey: send, onText: send(text:))
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
    }
    .contentShape(Rectangle())
    .onTapGesture { if model.canType { keyboardFocused = true } }
    .safeAreaInset(edge: .top, spacing: 0) { statusStrip }
    .safeAreaInset(edge: .bottom, spacing: 0) { controlStrip }
    .navigationTitle(model.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if model.isRunning {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Kill", systemImage: "stop.circle") { confirmKill = true }
            .tint(TerminalPalette.color(.red))
        }
      }
    }
    .confirmationDialog(
      "Kill this shell?", isPresented: $confirmKill, titleVisibility: .visible
    ) {
      Button("Kill", role: .destructive) { model.kill() }
    } message: {
      // The whole tree, because that is what the gateway actually signals, and a
      // dev server's children are the reason anyone reaches for this.
      Text("The process and everything it started are stopped. The output stays readable.")
    }
    .task { await vm.holdOpen() }
    .task { model.start() }
    .onDisappear { model.stop() }
    // The session view's handler is on a covered view while this screen is up,
    // so the reconnect and the notification claim have to live where the reader
    // actually is - the same reason the sub-agent takeover carries its own.
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { vm.reconnectNow() }
      push.visibleSessionId = phase == .active ? vm.sessionId : nil
    }
  }

  // MARK: - The strip

  /// One line: what the record says, in the words every other client uses.
  private var statusStrip: some View {
    HStack(spacing: 0) {
      Text(TerminalShell.glyph)
        .frame(width: typography.cell * 2, alignment: .leading)
      Text(model.statusText)
        .lineLimit(1)
      Spacer(minLength: 0)
      if model.canType {
        Text("\(model.screen.cols)x\(model.screen.rows)")
          .monospacedDigit()
          .foregroundStyle(TerminalPalette.color(.faint))
      }
    }
    .font(typography.font)
    .foregroundStyle(
      model.isRunning ? TerminalPalette.color(.magenta) : TerminalPalette.color(.dim)
    )
    .padding(.horizontal, typography.cell)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .systemBackground))
    .overlay(alignment: .bottom) { Divider() }
  }

  // MARK: - The control strip

  /// The keys a software keyboard has not got, which on a command line is most
  /// of the ones that matter: Escape, Tab, Control and the arrows. Without these
  /// the drill-in could run `ls` and nothing that needed interrupting.
  @ViewBuilder private var controlStrip: some View {
    if model.canType {
      HStack(spacing: 4) {
        key("esc") { send(.escape) }
        key("tab") { send(.tab) }
        key("ctrl", active: controlArmed) { controlArmed.toggle() }
        key("^C") { controlArmed = false; send(.control("c")) }
        Spacer(minLength: 0)
        key("↑") { send(.up) }
        key("↓") { send(.down) }
        key("←") { send(.left) }
        key("→") { send(.right) }
        Button {
          keyboardFocused.toggle()
        } label: {
          Image(systemName: keyboardFocused ? "keyboard.chevron.compact.down" : "keyboard")
            .font(.footnote)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .frame(minHeight: 30)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(.bar)
      .overlay(alignment: .top) { Divider() }
    }
  }

  private func key(_ label: String, active: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label)
        .font(.footnote.monospaced())
        .padding(.horizontal, 8)
        .frame(minWidth: 34, minHeight: 30)
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(active ? TerminalPalette.color(.magenta).opacity(0.3) : Color(uiColor: .secondarySystemFill))
        )
    }
    .buttonStyle(.plain)
    .foregroundStyle(active ? TerminalPalette.color(.magenta) : Color.primary)
  }

  // MARK: - Input

  private func send(_ key: VTKey) {
    model.send(key)
  }

  /// A typed character, with the latch applied. Only a single character can be
  /// a control chord: a paste is text, and `ctrl` armed against a paste would
  /// turn its first character into a signal and drop the rest of the meaning.
  private func send(text: String) {
    if controlArmed, text.count == 1, let first = text.first {
      controlArmed = false
      model.send(.control(first))
      return
    }
    if text.count > 1 {
      model.paste(text)
      return
    }
    model.send(text: text)
  }
}
