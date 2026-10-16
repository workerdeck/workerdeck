import Foundation

// The keys a view turns into PTY input.
public enum VTKey: Equatable, Sendable {
  case char(Character)
  case enter, tab, backspace, escape
  case up, down, left, right, home, end, pageUp, pageDown, delete
  case function(Int)
  // ctrl-c etc: the caller passes `c`.
  case control(Character)
}
