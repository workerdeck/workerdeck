use wd_native::vt::{CellText, VtKey, VtScreen};

fn make(cols: usize, rows: usize, input: &str) -> VtScreen {
    let mut screen = VtScreen::new(cols, rows, 100);
    screen.feed(input);
    screen
}

fn plain(screen: &VtScreen, index: usize) -> String {
    let text: String = screen
        .line(index)
        .iter()
        .filter(|cell| !cell.continuation)
        .map(|cell| match &cell.text {
            CellText::None => " ".to_owned(),
            CellText::Char(c) => c.to_string(),
            CellText::Cluster(s) => s.to_string(),
        })
        .collect();
    text.trim_end_matches(' ').to_owned()
}

fn rows(screen: &VtScreen) -> Vec<String> {
    (0..screen.rows).map(|row| plain(screen, screen.scrollback_count() + row)).collect()
}

fn history(screen: &VtScreen) -> Vec<String> {
    (0..screen.total_rows()).map(|row| plain(screen, row)).collect()
}

#[test]
fn arrows_follow_the_cursor_key_mode() {
    let mut screen = make(10, 4, "");
    assert_eq!(screen.encode(VtKey::Up), "\u{1b}[A");
    assert_eq!(screen.encode(VtKey::Left), "\u{1b}[D");
    assert_eq!(screen.encode(VtKey::Home), "\u{1b}[H");
    screen.feed("\u{1b}[?1h");
    assert_eq!(screen.encode(VtKey::Up), "\u{1b}OA");
    assert_eq!(screen.encode(VtKey::Right), "\u{1b}OC");
    assert_eq!(screen.encode(VtKey::End), "\u{1b}OF");
    assert_eq!(screen.encode(VtKey::PageDown), "\u{1b}[6~");
    assert_eq!(screen.encode(VtKey::Delete), "\u{1b}[3~");
}

#[test]
fn control_keys_and_the_rest() {
    let screen = make(10, 4, "");
    assert_eq!(screen.encode(VtKey::Control('c')), "\u{3}");
    assert_eq!(screen.encode(VtKey::Control('C')), "\u{3}");
    assert_eq!(screen.encode(VtKey::Control('d')), "\u{4}");
    assert_eq!(screen.encode(VtKey::Control('[')), "\u{1b}");
    assert_eq!(screen.encode(VtKey::Control(' ')), "\0");
    assert_eq!(screen.encode(VtKey::Control('?')), "\u{7f}");
    assert_eq!(screen.encode(VtKey::Control('é')), "");
    assert_eq!(screen.encode(VtKey::Enter), "\r");
    assert_eq!(screen.encode(VtKey::Tab), "\t");
    assert_eq!(screen.encode(VtKey::Backspace), "\u{7f}");
    assert_eq!(screen.encode(VtKey::Escape), "\u{1b}");
    assert_eq!(screen.encode(VtKey::Char('é')), "é");
    assert_eq!(screen.encode(VtKey::Function(1)), "\u{1b}OP");
    assert_eq!(screen.encode(VtKey::Function(5)), "\u{1b}[15~");
    assert_eq!(screen.encode(VtKey::Function(12)), "\u{1b}[24~");
    assert_eq!(screen.encode(VtKey::Function(13)), "");
}

#[test]
fn paste_is_bracketed_only_when_asked() {
    let mut screen = make(10, 4, "");
    assert_eq!(screen.encode_paste("hi\nthere\r\n"), "hi\rthere\r");
    screen.feed("\u{1b}[?2004h");
    assert_eq!(screen.encode_paste("hi"), "\u{1b}[200~hi\u{1b}[201~");
    screen.feed("\u{1b}[?2004l");
    assert_eq!(screen.encode_paste("hi"), "hi");
}

#[test]
fn resize_cuts_and_pads_live_lines_without_reflow() {
    let mut screen = make(10, 3, "0123456789abc");
    assert_eq!(rows(&screen), ["0123456789", "abc", ""]);
    screen.resize(5, 3);
    assert_eq!(rows(&screen), ["01234", "abc", ""]);
    assert_eq!(screen.line(0).len(), 5);
    screen.resize(8, 3);
    assert_eq!(rows(&screen), ["01234", "abc", ""]);
    assert_eq!(screen.cursor().1, 3);
    assert_eq!(screen.revision, 3);
}

#[test]
fn resize_leaves_scrollback_as_emitted() {
    let mut screen = make(10, 2, "0123456789\r\nab\r\ncd");
    assert_eq!(history(&screen), ["0123456789", "ab", "cd"]);
    screen.resize(4, 2);
    assert_eq!(screen.line(0).len(), 10);
    assert_eq!(plain(&screen, 0), "0123456789");
    assert_eq!(rows(&screen), ["ab", "cd"]);
}

#[test]
fn shrinking_rows_keeps_the_cursor_line_and_growing_pulls_history_back() {
    let mut screen = make(5, 4, "a\r\nb\r\nc");
    screen.resize(5, 2);
    assert_eq!(history(&screen), ["a", "b", "c"]);
    assert_eq!(screen.cursor().0, 1);
    screen.resize(5, 4);
    assert_eq!(history(&screen), ["a", "b", "c", ""]);
    assert_eq!(screen.scrollback_count(), 0);
    assert_eq!(screen.cursor().0, 2);
}

#[test]
fn resize_inside_the_alternate_screen_resizes_the_main_screen_too() {
    let mut screen = make(6, 3, "abcdef\u{1b}[?1049h");
    screen.resize(3, 3);
    screen.feed("\u{1b}[?1049l");
    assert_eq!(rows(&screen), ["abc", "", ""]);
    assert_eq!(screen.cols, 3);
}

#[test]
fn resize_splitting_a_wide_char_blanks_its_head() {
    let mut screen = make(6, 2, "ab界");
    screen.resize(3, 2);
    assert_eq!(rows(&screen)[0], "ab");
    assert!(!screen.line(screen.scrollback_count()).iter().any(|cell| cell.continuation));
}
