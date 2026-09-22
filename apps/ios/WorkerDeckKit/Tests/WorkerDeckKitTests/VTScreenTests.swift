import Foundation
import Testing

@testable import WorkerDeckKit

/// The emulator a shell session draws on. Every test reads the screen back as
/// `plainText` per row, so a case reads as "this output, that picture".
@Suite("VTScreen")
@MainActor
struct VTScreenTests {
  private func make(cols: Int = 10, rows: Int = 4, scrollback: Int = 100, _ input: String = "") -> VTScreen {
    let screen = VTScreen(cols: cols, rows: rows, scrollbackLimit: scrollback)
    screen.feed(input)
    return screen
  }

  private func rows(_ screen: VTScreen) -> [String] {
    (0..<screen.rows).map { screen.line(at: screen.scrollbackCount + $0).plainText }
  }

  private func history(_ screen: VTScreen) -> [String] {
    (0..<screen.totalRows).map { screen.line(at: $0).plainText }
  }

  private func cell(_ screen: VTScreen, _ row: Int, _ col: Int) -> VTCell {
    screen.line(at: screen.scrollbackCount + row).cells[col]
  }

  private struct Snapshot: Equatable {
    var lines: [VTLine]
    var cursor: [Int]
    var alt: Bool
    var title: String?
    var visible: Bool
    var bells: Int
    var responses: String
    var modes: [Bool]
  }

  private func snapshot(_ screen: VTScreen) -> Snapshot {
    Snapshot(
      lines: (0..<screen.totalRows).map(screen.line(at:)),
      cursor: [screen.cursorRow, screen.cursorCol], alt: screen.altScreenActive, title: screen.title,
      visible: screen.cursorVisible, bells: screen.bellCount, responses: screen.takeResponses(),
      modes: [screen.applicationCursorKeys, screen.bracketedPaste])
  }

  // MARK: - Split feeds

  @Test func aSequenceFedOneScalarAtATimeLandsAsIfFedWhole() {
    let fixtures = [
      "\u{1b}[31mred\u{1b}[0m plain",
      "\u{1b}[2;3Hx\u{1b}[1;1Hy",
      "\u{1b}]0;the title\u{7}after",
      "\u{1b}]2;st title\u{1b}\\after",
      "a\u{1b}[?1049hb\u{1b}[?1049lc",
      "\u{1b}[38:2::10:20:30mX\u{1b}[48;5;200mY\u{1b}[m",
      "\u{1b}P1$q\u{1b}\\ok",
      "中文\u{1b}[1D!",
      "e\u{301}x\u{1f468}\u{200d}\u{1f469}",
      "\u{1b}(0lqk\u{1b}(B",
      "line one\r\nline two\r\n\u{1b}[6n",
      "\u{1b}[?25l\u{1b}[?1h\u{1b}[?2004h\u{7}",
      "\u{1b}[1;5r\u{1b}[5;1Hx\ny\u{1b}[?6h\u{1b}[H",
      "\u{1b}7\u{1b}[3;3HQ\u{1b}8W",
      "\u{1b}_G a=q\u{1b}\\W\u{1b}[?1;2;3;4h",
    ]
    for fixture in fixtures {
      let whole = make(cols: 12, rows: 6, fixture)
      let byCharacter = make(cols: 12, rows: 6)
      for character in fixture {
        byCharacter.feed(String(character))
      }
      let byScalar = make(cols: 12, rows: 6)
      for scalar in fixture.unicodeScalars {
        byScalar.feed(String(scalar))
      }
      let expected = snapshot(whole)
      #expect(snapshot(byCharacter) == expected, "by character: \(fixture.debugDescription)")
      #expect(snapshot(byScalar) == expected, "by scalar: \(fixture.debugDescription)")
    }
  }

  @Test func aTruncatedSequenceWaitsForTheRest() {
    let screen = make(cols: 5, "\u{1b}[")
    #expect(rows(screen) == ["", "", "", ""])
    screen.feed("3")
    #expect(rows(screen) == ["", "", "", ""])
    screen.feed("1mX")
    #expect(rows(screen) == ["X", "", "", ""])
    #expect(cell(screen, 0, 0).style.fg == .indexed(1))
  }

  // MARK: - Wrapping

  @Test func printingInTheLastColumnDefersTheWrap() {
    let screen = make(cols: 5, "abcde")
    #expect(rows(screen) == ["abcde", "", "", ""])
    #expect(screen.cursorRow == 0)
    #expect(screen.cursorCol == 4)
    screen.feed("f")
    #expect(rows(screen) == ["abcde", "f", "", ""])
    #expect(screen.cursorCol == 1)
  }

  @Test func aFullWidthLineFollowedByCRLFDoesNotDoubleSpace() {
    let screen = make(cols: 5, "abcde\r\nfghij\r\nk")
    #expect(rows(screen) == ["abcde", "fghij", "k", ""])
  }

  @Test func aLineFeedAfterAFullLineKeepsTheColumn() {
    #expect(rows(make(cols: 5, "abcde\nX")) == ["abcde", "    X", "", ""])
  }

  @Test func aBackspaceAfterAFullLineStepsOffTheLastColumn() {
    #expect(rows(make(cols: 5, "abcde\u{8}X")) == ["abcXe", "", "", ""])
  }

  @Test func eraseToEndOfLineClearsThePendingWrap() {
    #expect(rows(make(cols: 5, "abcde\u{1b}[Kf")) == ["abcdf", "", "", ""])
  }

  @Test func withAutowrapOffTheLastColumnIsOverwritten() {
    #expect(rows(make(cols: 5, "\u{1b}[?7labcdefg")) == ["abcdg", "", "", ""])
  }

  // MARK: - Wide and combining characters

  @Test func wideCharactersTakeTwoCells() {
    let screen = make(cols: 6, "中文")
    #expect(cell(screen, 0, 0).text == "中")
    #expect(cell(screen, 0, 1).isContinuation)
    #expect(cell(screen, 0, 2).text == "文")
    #expect(cell(screen, 0, 3).isContinuation)
    #expect(screen.cursorCol == 4)
    let line = screen.line(at: 0)
    #expect(line.plainText == "中文")
    #expect(line.runs().map(\.text) == ["中", "文"])
    #expect(line.runs().map(\.columns) == [2, 2])
  }

  @Test func runsReportColumnsNotCharacters() {
    let line = make(cols: 12, "ab\u{1b}[31m中c\u{1b}[m文\u{1b}[44m  ").line(at: 0)
    let runs = line.runs()
    #expect(runs.map(\.text) == ["ab", "中", "c", "文", "  "])
    #expect(runs.map(\.columns) == [2, 2, 1, 2, 2])
    #expect(runs[1].style.fg == .indexed(1))
    #expect(runs[2].style.fg == .indexed(1))
    var offsets: [Int] = []
    var column = 0
    for run in runs {
      offsets.append(column)
      column += run.columns
    }
    #expect(offsets == [0, 2, 4, 5, 7])
    #expect(column == 9)
    let rest = line.cells.dropFirst(column)
    #expect(rest.allSatisfy { $0.isBlank && !$0.style.paintsBlank })
  }

  @Test func concealedTextKeepsItsCellsAndBackground() {
    let screen = make(cols: 12, "\u{1b}[8;42msecret\u{1b}[28mshown")
    #expect(cell(screen, 0, 0).style == VTStyle(bg: .indexed(2), hidden: true))
    #expect(cell(screen, 0, 6).style == VTStyle(bg: .indexed(2)))
    let runs = screen.line(at: 0).runs()
    #expect(runs.map(\.columns) == [6, 5])
    #expect(runs[0].style.hidden)
    #expect(!runs[1].style.hidden)
  }

  @Test func aWideCharacterWrapsWhenOneCellIsLeft() {
    let screen = make(cols: 5, "abcd中")
    #expect(rows(screen) == ["abcd", "中", "", ""])
    #expect(screen.cursorRow == 1)
    #expect(screen.cursorCol == 2)
  }

  @Test func aWideCharacterFillingTheLineDefersTheWrapToo() {
    let screen = make(cols: 4, "ab中")
    #expect(rows(screen) == ["ab中", "", "", ""])
    #expect(screen.cursorCol == 3)
    screen.feed("x")
    #expect(rows(screen) == ["ab中", "x", "", ""])
  }

  @Test func overwritingEitherHalfOfAWideCharacterBlanksBoth() {
    let head = make(cols: 6, "中\rx")
    #expect(cell(head, 0, 0).text == "x")
    #expect(!cell(head, 0, 1).isContinuation)
    #expect(head.line(at: 0).plainText == "x")

    let tail = make(cols: 6, "ab中\u{1b}[4Gx")
    #expect(tail.line(at: 0).plainText == "ab x")
    #expect(!cell(tail, 0, 3).isContinuation)
  }

  @Test func combiningMarksRideTheirBase() {
    let screen = make(cols: 6)
    for scalar in "e\u{301}x".unicodeScalars {
      screen.feed(String(scalar))
    }
    #expect(cell(screen, 0, 0).text == "e\u{301}")
    #expect(cell(screen, 0, 1).text == "x")
    #expect(screen.cursorCol == 2)
  }

  @Test func emojiAreWideAndAZWJSequenceIsMeasuredPerScalar() {
    let screen = make(cols: 10, "\u{1f600}\u{1f468}\u{200d}\u{1f469}!")
    #expect(cell(screen, 0, 1).isContinuation)
    #expect(cell(screen, 0, 2).text == "\u{1f468}\u{200d}")
    #expect(cell(screen, 0, 4).text == "\u{1f469}")
    #expect(cell(screen, 0, 6).text == "!")
  }

  // MARK: - Scrolling and scrollback

  @Test func aScrollRegionScrollsOnlyItselfAndFeedsNoScrollback() {
    let screen = make(cols: 5, rows: 5, "1\r\n2\r\n3\r\n4\r\n5\u{1b}[2;4r\u{1b}[4;1H\nX")
    #expect(rows(screen) == ["1", "3", "4", "X", "5"])
    #expect(screen.scrollbackCount == 0)
  }

  @Test func aRegionStartingAtTheTopStillFeedsScrollback() {
    let screen = make(cols: 5, rows: 4, "\u{1b}[1;2ra\r\nb\r\nc")
    #expect(rows(screen) == ["b", "c", "", ""])
    #expect(history(screen).first == "a")
  }

  @Test func scrollbackKeepsTheNewestLinesUpToTheLimit() {
    let screen = make(cols: 5, rows: 3, scrollback: 5, "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\r\n10\r\n")
    #expect(screen.scrollbackCount == 5)
    #expect(screen.totalRows == 8)
    #expect(history(screen) == ["4", "5", "6", "7", "8", "9", "10", ""])
    #expect(screen.line(at: 99).plainText == "")
  }

  @Test func theAlternateScreenNeverFeedsScrollback() {
    let screen = make(cols: 5, rows: 2, scrollback: 5, "\u{1b}[?1049h1\r\n2\r\n3\r\n4\r\n")
    #expect(screen.scrollbackCount == 0)
    #expect(rows(screen) == ["4", ""])
  }

  @Test func reverseIndexAtTheTopScrollsDown() {
    #expect(rows(make(rows: 3, "a\r\nb\u{1b}[H\u{1b}MX")) == ["X", "a", "b"])
  }

  @Test func scrollUpAndDownMoveTheWholeRegion() {
    let screen = make(rows: 3, "a\r\nb\r\nc\u{1b}[S")
    #expect(rows(screen) == ["b", "c", ""])
    #expect(history(screen).first == "a")
    screen.feed("\u{1b}[2T")
    #expect(rows(screen) == ["", "", "b"])
  }

  // MARK: - Erasing and editing

  @Test func eraseInDisplayClearsTheScreenAndOnlyThreeClearsScrollback() {
    let screen = make(rows: 2, "a\r\nb\r\nc")
    #expect(history(screen) == ["a", "b", "c"])
    screen.feed("\u{1b}[2J")
    #expect(history(screen) == ["a", "", ""])
    #expect(screen.cursorRow == 1)
    #expect(screen.cursorCol == 1)
    screen.feed("\u{1b}[3J")
    #expect(screen.scrollbackCount == 0)
  }

  @Test func eraseInDisplayBelowAndAbove() {
    #expect(rows(make(cols: 3, rows: 3, "abc\r\ndef\r\nghi\u{1b}[2;2H\u{1b}[J")) == ["abc", "d", ""])
    #expect(rows(make(cols: 3, rows: 3, "abc\r\ndef\r\nghi\u{1b}[2;2H\u{1b}[1J")) == ["", "  f", "ghi"])
  }

  @Test func eraseInLineVariants() {
    #expect(rows(make(cols: 6, "abcdef\u{1b}[4G\u{1b}[K")).first == "abc")
    #expect(rows(make(cols: 6, "abcdef\u{1b}[4G\u{1b}[1K")).first == "    ef")
    #expect(rows(make(cols: 6, "abcdef\u{1b}[4G\u{1b}[2K")).first == "")
  }

  @Test func erasedCellsKeepTheCurrentBackground() {
    let screen = make(cols: 4, "ab\u{1b}[44m\u{1b}[K")
    #expect(cell(screen, 0, 3).style == VTStyle(bg: .indexed(4)))
    #expect(screen.line(at: 0).runs().map(\.text) == ["ab", "  "])
    #expect(screen.line(at: 0).plainText == "ab")
  }

  @Test func insertAndDeleteLinesWithinTheRegion() {
    let screen = make(rows: 4, "a\r\nb\r\nc\r\nd\u{1b}[2;1H\u{1b}[L")
    #expect(rows(screen) == ["a", "", "b", "c"])
    screen.feed("\u{1b}[M")
    #expect(rows(screen) == ["a", "b", "c", ""])
    screen.feed("\u{1b}[2M")
    #expect(rows(screen) == ["a", "", "", ""])
    #expect(screen.scrollbackCount == 0)
  }

  @Test func insertDeleteAndEraseCharacters() {
    let screen = make(cols: 6, "abcdef\u{1b}[3G\u{1b}[2@")
    #expect(rows(screen).first == "ab  cd")
    screen.feed("\u{1b}[2P")
    #expect(rows(screen).first == "abcd")
    #expect(rows(make(cols: 6, "abcdef\u{1b}[3G\u{1b}[2X")).first == "ab  ef")
  }

  @Test func insertModeShiftsTheRestOfTheLine() {
    #expect(rows(make(cols: 6, "abc\u{1b}[1G\u{1b}[4hX\u{1b}[4lY")).first == "XYbc")
  }

  @Test func deletingThroughAWideCharacterLeavesNoOrphanHalf() {
    let screen = make(cols: 6, "a中b\u{1b}[3G\u{1b}[P")
    #expect(rows(screen).first == "a b")
    #expect(!cell(screen, 0, 1).isContinuation)
  }

  // MARK: - SGR

  @Test func sgrSetsAndClearsEveryAttribute() {
    let screen = make(cols: 20, "\u{1b}[1;2;3;4;7;8;9mA\u{1b}[22;23;24;27;28;29mB\u{1b}[4:3mC\u{1b}[4:0mD")
    #expect(
      cell(screen, 0, 0).style
        == VTStyle(bold: true, dim: true, italic: true, underline: true, inverse: true, strikethrough: true, hidden: true))
    #expect(cell(screen, 0, 1).style == .default)
    #expect(cell(screen, 0, 2).style.underline)
    #expect(!cell(screen, 0, 3).style.underline)
  }

  @Test func sgrColoursInEverySpelling() {
    let screen = make(
      cols: 20,
      "\u{1b}[31;44mA\u{1b}[38;5;208mB\u{1b}[48;5;17mC\u{1b}[38;2;1;2;3mD\u{1b}[48;2;4;5;6mE"
        + "\u{1b}[38:5:99mF\u{1b}[38:2::7:8:9mG\u{1b}[48:2:10:11:12mH\u{1b}[39;49mI\u{1b}[91;104mJ")
    let styles = (0..<10).map { cell(screen, 0, $0).style }
    #expect(styles[0].fg == .indexed(1))
    #expect(styles[0].bg == .indexed(4))
    #expect(styles[1].fg == .indexed(208))
    #expect(styles[2].bg == .indexed(17))
    #expect(styles[3].fg == .rgb(1, 2, 3))
    #expect(styles[4].bg == .rgb(4, 5, 6))
    #expect(styles[5].fg == .indexed(99))
    #expect(styles[6].fg == .rgb(7, 8, 9))
    #expect(styles[7].bg == .rgb(10, 11, 12))
    #expect(styles[8].fg == .default)
    #expect(styles[8].bg == .default)
    #expect(styles[9].fg == .indexed(9))
    #expect(styles[9].bg == .indexed(12))
  }

  @Test func anExtendedColourConsumesExactlyItsArguments() {
    let screen = make(
      cols: 20, "\u{1b}[38;2;1;2;3;4mA\u{1b}[m\u{1b}[38;5;200;1mB\u{1b}[m\u{1b}[38:2:5:6:7;1mC\u{1b}[mD\u{1b}[38;2mE")
    #expect(cell(screen, 0, 0).style == VTStyle(fg: .rgb(1, 2, 3), underline: true))
    #expect(cell(screen, 0, 1).style == VTStyle(fg: .indexed(200), bold: true))
    #expect(cell(screen, 0, 2).style == VTStyle(fg: .rgb(5, 6, 7), bold: true))
    #expect(cell(screen, 0, 3).style == .default)
    #expect(cell(screen, 0, 4).style == .default)
  }

  // MARK: - The alternate screen

  @Test func theAlternateScreenRoundTripsTheMainScreenAndItsCursor() {
    let screen = make(rows: 3, "a\r\nb\r\nc\r\nd")
    #expect(history(screen) == ["a", "b", "c", "d"])
    screen.feed("\u{1b}[?1049h")
    #expect(screen.altScreenActive)
    #expect(rows(screen) == ["", "", ""])
    #expect(screen.scrollbackCount == 1)
    screen.feed("\u{1b}[HTUI\r\nline\r\nmore\r\nmore\u{1b}[2;4r")
    #expect(screen.scrollbackCount == 1)
    screen.feed("\u{1b}[?1049l")
    #expect(!screen.altScreenActive)
    #expect(history(screen) == ["a", "b", "c", "d"])
    #expect(screen.cursorRow == 2)
    #expect(screen.cursorCol == 1)
    screen.feed("\nZ")
    #expect(history(screen) == ["a", "b", "c", "d", " Z"])
  }

  @Test func aSaveInsideTheAlternateScreenDoesNotClobberTheExitCursor() {
    let screen = make(rows: 3, "ab\u{1b}[?1049h\u{1b}[3;3H\u{1b}7\u{1b}[H\u{1b}8\u{1b}[?1049l")
    #expect(screen.cursorRow == 0)
    #expect(screen.cursorCol == 2)
  }

  // MARK: - Real-world output

  @Test func colouredDirectoryListing() {
    let screen = make(
      cols: 40, rows: 3,
      "total 8\r\n\u{1b}[0m\u{1b}[01;34mdocs\u{1b}[0m  \u{1b}[01;32mrun.sh\u{1b}[0m  README.md\r\n")
    #expect(rows(screen) == ["total 8", "docs  run.sh  README.md", ""])
    let runs = screen.line(at: 1).runs()
    #expect(runs.map(\.text) == ["docs", "  ", "run.sh", "  README.md"])
    #expect(runs[0].style == VTStyle(fg: .indexed(4), bold: true))
    #expect(runs[2].style == VTStyle(fg: .indexed(2), bold: true))
    #expect(runs[3].style == .default)
  }

  @Test func aProgressBarRedrawnWithCarriageReturnsIsOneLine() {
    let screen = make(cols: 30, rows: 3, "\r[##        ] 20%\r[####      ] 40%\r[##########] 100%\r\nDone")
    #expect(rows(screen) == ["[##########] 100%", "Done", ""])
    #expect(screen.scrollbackCount == 0)
    let spinner = make(cols: 30, rows: 3, "step 1/3 running\r\u{1b}[Kstep 2/3\r\u{1b}[Kstep 3/3 ok")
    #expect(rows(spinner) == ["step 3/3 ok", "", ""])
  }

  @Test func decGraphicsDrawBoxes() {
    #expect(rows(make(cols: 6, "\u{1b}(0lqqk\u{1b}(Bx")).first == "┌──┐x")
    #expect(rows(make(cols: 6, "\u{1b})0\u{e}lq\u{f}a")).first == "┌─a")
  }

  @Test func repeatRepeatsTheLastPrintedCharacter() {
    #expect(rows(make(cols: 8, "ab\u{1b}[3b")).first == "abbbb")
  }

  // MARK: - Tabs, title, bell, modes

  @Test func tabsStopEveryEightColumnsUnlessReprogrammed() {
    let screen = make(cols: 20, "a\tb\tc")
    #expect(rows(screen).first == "a       b       c")
    #expect(screen.cursorCol == 17)
    #expect(rows(make(cols: 20, "\u{1b}[3g\u{1b}[5G\u{1b}HX\r\tY")).first == "    Y")
    #expect(rows(make(cols: 20, "\t\t\u{1b}[ZZ")).first == "        Z")
  }

  @Test func titleFromOSCZeroOrTwoTerminatedEitherWay() {
    let screen = make("\u{1b}]0;hello\u{7}")
    #expect(screen.title == "hello")
    screen.feed("\u{1b}]2;world\u{1b}\\")
    #expect(screen.title == "world")
    screen.feed("\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{7}")
    #expect(screen.title == "world")
    #expect(rows(screen).first == "link")
  }

  @Test func bellsAreCounted() {
    #expect(make("a\u{7}b\u{7}").bellCount == 2)
  }

  @Test func modesAreRecordedForTheView() {
    let screen = make("\u{1b}[?25l")
    #expect(!screen.cursorVisible)
    screen.feed("\u{1b}[?25h\u{1b}[?1000h\u{1b}[?1006h")
    #expect(screen.cursorVisible)
    #expect(screen.mouseTracking == .click)
    #expect(screen.sgrMouse)
    screen.feed("\u{1b}[?1002h")
    #expect(screen.mouseTracking == .drag)
    screen.feed("\u{1b}[?1002l\u{1b}[?1006l")
    #expect(screen.mouseTracking == .none)
    #expect(!screen.sgrMouse)
  }

  @Test func revisionBumpsOncePerFeedThatDrewSomething() {
    let screen = make()
    #expect(screen.revision == 0)
    screen.feed("x")
    #expect(screen.revision == 1)
    screen.feed("")
    screen.feed("\u{1b}[31m")
    #expect(screen.revision == 1)
    screen.feed("\u{1b}[?25l")
    #expect(screen.revision == 2)
    screen.feed("abc\r\n")
    #expect(screen.revision == 3)
  }

  @Test func saveAndRestoreCursorKeepsPositionAndStyle() {
    let screen = make("\u{1b}[2;3H\u{1b}[31m\u{1b}7\u{1b}[H\u{1b}[mZ\u{1b}8W")
    #expect(rows(screen) == ["Z", "  W", "", ""])
    #expect(cell(screen, 1, 2).style.fg == .indexed(1))
  }

  @Test func originModeConfinesTheCursorToTheRegion() {
    let screen = make(rows: 5, "\u{1b}[2;4r\u{1b}[?6h\u{1b}[1;1HX\u{1b}[9;1HY")
    #expect(rows(screen) == ["", "X", "", "Y", ""])
  }

  // MARK: - Responses

  @Test func cursorPositionReportAnswersWithTheRealPosition() {
    let screen = make("\u{1b}[3;5H\u{1b}[6n")
    #expect(screen.takeResponses() == "\u{1b}[3;5R")
    #expect(screen.takeResponses() == "")
    screen.feed("\u{1b}[c\u{1b}[5n")
    #expect(screen.takeResponses() == "\u{1b}[?1;2c\u{1b}[0n")
    screen.feed("\u{1b}[2;4r\u{1b}[?6h\u{1b}[6n")
    #expect(screen.takeResponses() == "\u{1b}[1;1R")
  }

  @Test func responsesAreBounded() {
    let screen = make()
    for _ in 0..<2000 {
      screen.feed("\u{1b}[6n")
    }
    #expect(screen.takeResponses().utf8.count <= 4096)
  }

  // MARK: - Keys

  @Test func arrowsFollowTheCursorKeyMode() {
    let screen = make()
    #expect(screen.encode(.up) == "\u{1b}[A")
    #expect(screen.encode(.left) == "\u{1b}[D")
    #expect(screen.encode(.home) == "\u{1b}[H")
    screen.feed("\u{1b}[?1h")
    #expect(screen.encode(.up) == "\u{1b}OA")
    #expect(screen.encode(.right) == "\u{1b}OC")
    #expect(screen.encode(.end) == "\u{1b}OF")
    #expect(screen.encode(.pageDown) == "\u{1b}[6~")
    #expect(screen.encode(.delete) == "\u{1b}[3~")
  }

  @Test func controlKeysAndTheRest() {
    let screen = make()
    #expect(screen.encode(.control("c")) == "\u{3}")
    #expect(screen.encode(.control("C")) == "\u{3}")
    #expect(screen.encode(.control("d")) == "\u{4}")
    #expect(screen.encode(.control("[")) == "\u{1b}")
    #expect(screen.encode(.enter) == "\r")
    #expect(screen.encode(.tab) == "\t")
    #expect(screen.encode(.backspace) == "\u{7f}")
    #expect(screen.encode(.escape) == "\u{1b}")
    #expect(screen.encode(.char("é")) == "é")
    #expect(screen.encode(.function(1)) == "\u{1b}OP")
    #expect(screen.encode(.function(5)) == "\u{1b}[15~")
    #expect(screen.encode(.function(12)) == "\u{1b}[24~")
    #expect(screen.encode(.function(13)) == "")
  }

  @Test func pasteIsBracketedOnlyWhenAsked() {
    let screen = make()
    #expect(screen.encodePaste("hi\nthere\r\n") == "hi\rthere\r")
    screen.feed("\u{1b}[?2004h")
    #expect(screen.encodePaste("hi") == "\u{1b}[200~hi\u{1b}[201~")
    screen.feed("\u{1b}[?2004l")
    #expect(screen.encodePaste("hi") == "hi")
  }

  // MARK: - Garbage

  @Test func malformedAndUnknownSequencesPrintNothing() {
    #expect(rows(make("\u{1b}[999999999999999999999zA")).first == "A")
    #expect(rows(make("\u{1b}[12;1xA")).first == "A")
    #expect(rows(make("\u{1b}[ qA")).first == "A")
    #expect(rows(make("\u{1b}QA")).first == "A")
    #expect(rows(make("\u{1b}P0;1|17/ab\u{1b}\\A")).first == "A")
    #expect(rows(make("\u{1b}_G a=q,f=100\u{1b}\\A")).first == "A")
    #expect(rows(make("\u{1b}^pm\u{9c}A")).first == "A")
    #expect(rows(make("\u{1b}[?1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;32;33;34;35;36;37;38;39;40hA")).first == "A")
    #expect(rows(make("\u{1b}[1;2;\u{1b}[HA")).first == "A")
    #expect(rows(make("\u{1b}]0;\(String(repeating: "t", count: 10_000))\u{7}A")).first == "A")
  }

  @Test func anUnterminatedOSCSwallowsUntilItsTerminator() {
    let screen = make("\u{1b}]0;never")
    #expect(rows(screen).first == "")
    screen.feed(" terminated")
    #expect(rows(screen).first == "")
    screen.feed("\u{7}Y")
    #expect(rows(screen).first == "Y")
    #expect(screen.title == "never terminated")
  }

  @Test func c0ControlsRunInsideASequence() {
    #expect(rows(make(cols: 6, "ab\u{1b}[\rKc")).first == "c")
  }

  // MARK: - Resize and reset

  @Test func resizeCutsAndPadsLiveLinesWithoutReflow() {
    let screen = make(cols: 10, rows: 3, "0123456789abc")
    #expect(rows(screen) == ["0123456789", "abc", ""])
    screen.resize(cols: 5, rows: 3)
    #expect(rows(screen) == ["01234", "abc", ""])
    #expect(screen.line(at: 0).cells.count == 5)
    screen.resize(cols: 8, rows: 3)
    #expect(rows(screen) == ["01234", "abc", ""])
    #expect(screen.cursorCol == 3)
    #expect(screen.revision == 3)
  }

  @Test func resizeLeavesScrollbackAsEmitted() {
    let screen = make(cols: 10, rows: 2, "0123456789\r\nab\r\ncd")
    #expect(history(screen) == ["0123456789", "ab", "cd"])
    screen.resize(cols: 4, rows: 2)
    #expect(screen.line(at: 0).cells.count == 10)
    #expect(screen.line(at: 0).plainText == "0123456789")
    #expect(rows(screen) == ["ab", "cd"])
  }

  @Test func shrinkingRowsKeepsTheCursorLineAndGrowingPullsHistoryBack() {
    let screen = make(cols: 5, rows: 4, "a\r\nb\r\nc")
    screen.resize(cols: 5, rows: 2)
    #expect(history(screen) == ["a", "b", "c"])
    #expect(screen.cursorRow == 1)
    screen.resize(cols: 5, rows: 4)
    #expect(history(screen) == ["a", "b", "c", ""])
    #expect(screen.scrollbackCount == 0)
    #expect(screen.cursorRow == 2)
  }

  @Test func resizeInsideTheAlternateScreenResizesTheMainScreenToo() {
    let screen = make(cols: 6, rows: 3, "abcdef\u{1b}[?1049h")
    screen.resize(cols: 3, rows: 3)
    screen.feed("\u{1b}[?1049l")
    #expect(rows(screen) == ["abc", "", ""])
    #expect(screen.cols == 3)
  }

  @Test func resetAndRISReturnToPowerOn() {
    let screen = make(rows: 2, "a\r\nb\r\nc\u{1b}]0;t\u{7}\u{1b}[?25l\u{1b}[31m")
    screen.feed("\u{1b}c")
    #expect(history(screen) == ["", ""])
    #expect(screen.title == nil)
    #expect(screen.cursorVisible)
    screen.feed("x")
    #expect(cell(screen, 0, 0).style == .default)
    #expect(screen.cursorRow == 0)
  }

  @Test func aWideLineOfOutputSplitAcrossFramesStaysLinear() {
    let screen = make(cols: 120, rows: 40, scrollback: 1000)
    let line = "\u{1b}[32m" + String(repeating: "y", count: 100) + "\u{1b}[0m\r\n"
    let chunk = String(repeating: line, count: 200)
    let clock = ContinuousClock()
    let small = clock.measure {
      for _ in 0..<5 { screen.feed(chunk) }
    }
    let large = clock.measure {
      for _ in 0..<50 { screen.feed(chunk) }
    }
    #expect(screen.scrollbackCount == 1000)
    #expect(rows(screen)[38] == String(repeating: "y", count: 100))
    // Ten times the output, well under a hundred times the time: the ring and
    // the in-place row edits are what keep a `yes` from being O(screen).
    #expect(large < small * 100, "1k lines \(small) vs 10k lines \(large)")
  }
}
