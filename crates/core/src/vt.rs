use crate::cells::{in_ranges, is_emoji_presentation};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strikethrough: bool,
    pub hidden: bool,
}

impl Style {
    fn paints_blank(&self) -> bool {
        self.bg != Color::Default || self.inverse || self.underline || self.strikethrough
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CellText {
    #[default]
    None,
    Char(char),
    Cluster(Box<str>),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cell {
    pub text: CellText,
    pub style: Style,
    pub continuation: bool,
}

impl Cell {
    fn is_blank(&self) -> bool {
        !self.continuation && matches!(self.text, CellText::None | CellText::Char(' '))
    }
}

const BLANK: Cell = Cell { text: CellText::None, style: STYLE_DEFAULT, continuation: false };
const STYLE_DEFAULT: Style = Style {
    fg: Color::Default,
    bg: Color::Default,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strikethrough: false,
    hidden: false,
};

const WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115F),
    (0x2329, 0x232A),
    (0x2E80, 0x303E),
    (0x3041, 0x33FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xA000, 0xA4CF),
    (0xA960, 0xA97F),
    (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF),
    (0xFE10, 0xFE19),
    (0xFE30, 0xFE6F),
    (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6),
    (0x16FE0, 0x16FE4),
    (0x17000, 0x18AFF),
    (0x1B000, 0x1B2FF),
    (0x1F200, 0x1F251),
    (0x20000, 0x2FFFD),
    (0x30000, 0x3FFFD),
];

// Hand table of the populated Mn, Me and Cf blocks; renderers must agree with it.
const ZERO_WIDTH: &[(u32, u32)] = &[
    (0x0300, 0x036F),
    (0x0483, 0x0489),
    (0x0591, 0x05BD),
    (0x05BF, 0x05BF),
    (0x05C1, 0x05C2),
    (0x05C4, 0x05C5),
    (0x05C7, 0x05C7),
    (0x0600, 0x0605),
    (0x0610, 0x061A),
    (0x061C, 0x061C),
    (0x064B, 0x065F),
    (0x0670, 0x0670),
    (0x06D6, 0x06DD),
    (0x06DF, 0x06E4),
    (0x06E7, 0x06E8),
    (0x06EA, 0x06ED),
    (0x070F, 0x070F),
    (0x0711, 0x0711),
    (0x0730, 0x074A),
    (0x07A6, 0x07B0),
    (0x07EB, 0x07F3),
    (0x0816, 0x082D),
    (0x0859, 0x085B),
    (0x0890, 0x0891),
    (0x0898, 0x089F),
    (0x08CA, 0x0902),
    (0x093A, 0x093A),
    (0x093C, 0x093C),
    (0x0941, 0x0948),
    (0x094D, 0x094D),
    (0x0951, 0x0957),
    (0x0962, 0x0963),
    (0x0981, 0x0981),
    (0x09BC, 0x09BC),
    (0x09C1, 0x09C4),
    (0x09CD, 0x09CD),
    (0x09E2, 0x09E3),
    (0x0A01, 0x0A02),
    (0x0A3C, 0x0A3C),
    (0x0A41, 0x0A51),
    (0x0A70, 0x0A71),
    (0x0A75, 0x0A75),
    (0x0A81, 0x0A82),
    (0x0ABC, 0x0ABC),
    (0x0AC1, 0x0AC8),
    (0x0ACD, 0x0ACD),
    (0x0B01, 0x0B01),
    (0x0B3C, 0x0B3C),
    (0x0B3F, 0x0B3F),
    (0x0B41, 0x0B44),
    (0x0B4D, 0x0B4D),
    (0x0B82, 0x0B82),
    (0x0BC0, 0x0BC0),
    (0x0BCD, 0x0BCD),
    (0x0C00, 0x0C00),
    (0x0C3E, 0x0C40),
    (0x0C46, 0x0C56),
    (0x0CBC, 0x0CBC),
    (0x0CCC, 0x0CCD),
    (0x0D00, 0x0D01),
    (0x0D41, 0x0D44),
    (0x0D4D, 0x0D4D),
    (0x0E31, 0x0E31),
    (0x0E34, 0x0E3A),
    (0x0E47, 0x0E4E),
    (0x0EB1, 0x0EB1),
    (0x0EB4, 0x0EBC),
    (0x0EC8, 0x0ECE),
    (0x0F18, 0x0F19),
    (0x0F35, 0x0F35),
    (0x0F37, 0x0F37),
    (0x0F39, 0x0F39),
    (0x0F71, 0x0F84),
    (0x102D, 0x1030),
    (0x1032, 0x1037),
    (0x1039, 0x103A),
    (0x135D, 0x135F),
    (0x1712, 0x1714),
    (0x17B4, 0x17B5),
    (0x17B7, 0x17BD),
    (0x17C6, 0x17C6),
    (0x17C9, 0x17D3),
    (0x180B, 0x180E),
    (0x18A9, 0x18A9),
    (0x1A17, 0x1A18),
    (0x1AB0, 0x1ACE),
    (0x1B00, 0x1B03),
    (0x1DC0, 0x1DFF),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0x20D0, 0x20F0),
    (0x2CEF, 0x2CF1),
    (0x2DE0, 0x2DFF),
    (0x302A, 0x302D),
    (0x3099, 0x309A),
    (0xA66F, 0xA672),
    (0xA674, 0xA67D),
    (0xA69E, 0xA69F),
    (0xA6F0, 0xA6F1),
    (0xA8E0, 0xA8F1),
    (0xFB1E, 0xFB1E),
    (0xFE00, 0xFE0F),
    (0xFE20, 0xFE2F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x101FD, 0x101FD),
    (0x110BD, 0x110BD),
    (0x1BCA0, 0x1BCA3),
    (0x1D167, 0x1D169),
    (0x1D173, 0x1D182),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
    (0xE0100, 0xE01EF),
];

pub fn width_of(c: char) -> usize {
    let v = c as u32;
    if v < 0x300 {
        return 1;
    }
    if (0x1160..=0x11FF).contains(&v) {
        return 0;
    }
    if in_ranges(ZERO_WIDTH, v) {
        return 0;
    }
    if (0x1F3FB..=0x1F3FF).contains(&v) {
        return 0;
    }
    if v < 0x1100 {
        return 1;
    }
    if is_emoji_presentation(v) {
        return if (0x1F1E6..=0x1F1FF).contains(&v) { 1 } else { 2 };
    }
    if in_ranges(WIDE, v) {
        return 2;
    }
    1
}

#[derive(Clone, Copy)]
struct SavedCursor {
    col: usize,
    row: usize,
    style: Style,
    origin_mode: bool,
    g0: bool,
    g1: bool,
    shifted_out: bool,
}

#[derive(Clone)]
struct Buffer {
    grid: Vec<Vec<Cell>>,
    cursor_col: usize,
    cursor_row: usize,
    pending_wrap: bool,
    scroll_top: usize,
    scroll_bottom: usize,
    saved: Option<SavedCursor>,
}

impl Buffer {
    fn new(cols: usize, rows: usize, fill: &Cell) -> Self {
        Buffer {
            grid: vec![vec![fill.clone(); cols]; rows],
            cursor_col: 0,
            cursor_row: 0,
            pending_wrap: false,
            scroll_top: 0,
            scroll_bottom: rows - 1,
            saved: None,
        }
    }
}

struct LineRing {
    capacity: usize,
    storage: Vec<Vec<Cell>>,
    start: usize,
    count: usize,
}

impl LineRing {
    fn get(&self, index: usize) -> &Vec<Cell> {
        &self.storage[(self.start + index) % self.capacity]
    }
    fn push(&mut self, line: Vec<Cell>) {
        if self.capacity == 0 {
            return;
        }
        let slot = (self.start + self.count) % self.capacity;
        if slot < self.storage.len() {
            self.storage[slot] = line;
        } else {
            self.storage.push(line);
        }
        if self.count == self.capacity {
            self.start = (self.start + 1) % self.capacity;
        } else {
            self.count += 1;
        }
    }
    fn clear(&mut self) {
        self.storage.clear();
        self.start = 0;
        self.count = 0;
    }
    fn pop_last(&mut self) -> Option<Vec<Cell>> {
        if self.count == 0 {
            return None;
        }
        self.count -= 1;
        let slot = (self.start + self.count) % self.capacity;
        Some(std::mem::take(&mut self.storage[slot]))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VtKey {
    Char(char),
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Delete,
    Function(u8),
    Control(char),
}

const DEC_GRAPHICS: [char; 31] = [
    '◆', '▒', '␉', '␌', '␍', '␊', '°', '±', '␤', '␋', '┘', '┐', '┌', '└', '┼', '⎺', '⎻', '─', '⎼', '⎽', '├', '┤', '┴', '┬', '│', '≤', '≥',
    'π', '≠', '£', '·',
];
const MAX_REPEAT: usize = 4096;
const MAX_RESPONSE: usize = 4096;

pub struct VtScreen {
    pub cols: usize,
    pub rows: usize,
    pub revision: u64,
    pub cursor_visible: bool,
    pub alt_screen_active: bool,
    pub title: Option<String>,
    pub bell_count: u64,
    pub application_cursor_keys: bool,
    pub bracketed_paste: bool,
    pub mouse_tracking: u8,
    pub sgr_mouse: bool,
    pub focus_reporting: bool,
    buffer: Buffer,
    inactive: Option<Buffer>,
    scrollback: LineRing,
    style: Style,
    origin_mode: bool,
    autowrap: bool,
    insert_mode: bool,
    newline_mode: bool,
    tab_stops: Vec<bool>,
    g0: bool,
    g1: bool,
    shifted_out: bool,
    last_printed: Option<(CellText, usize)>,
    responses: String,
    dirty: bool,
    parser: Option<vte::Parser>,
    params: Vec<usize>,
    subparams: Vec<bool>,
}

fn default_tab_stops(cols: usize) -> Vec<bool> {
    (0..cols).map(|c| c > 0 && c % 8 == 0).collect()
}

impl VtScreen {
    pub fn new(cols: usize, rows: usize, scrollback_limit: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        VtScreen {
            cols,
            rows,
            revision: 0,
            cursor_visible: true,
            alt_screen_active: false,
            title: None,
            bell_count: 0,
            application_cursor_keys: false,
            bracketed_paste: false,
            mouse_tracking: 0,
            sgr_mouse: false,
            focus_reporting: false,
            buffer: Buffer::new(cols, rows, &BLANK),
            inactive: None,
            scrollback: LineRing { capacity: scrollback_limit, storage: Vec::new(), start: 0, count: 0 },
            style: Style::default(),
            origin_mode: false,
            autowrap: true,
            insert_mode: false,
            newline_mode: false,
            tab_stops: default_tab_stops(cols),
            g0: false,
            g1: false,
            shifted_out: false,
            last_printed: None,
            responses: String::new(),
            dirty: false,
            parser: Some(vte::Parser::new()),
            params: Vec::with_capacity(32),
            subparams: Vec::with_capacity(32),
        }
    }

    pub fn total_rows(&self) -> usize {
        self.scrollback.count + self.rows
    }

    pub fn cursor(&self) -> (usize, usize) {
        (self.buffer.cursor_row, self.buffer.cursor_col)
    }

    pub fn scrollback_count(&self) -> usize {
        self.scrollback.count
    }

    pub fn line(&self, index: usize) -> std::borrow::Cow<'_, [Cell]> {
        let kept = self.scrollback.count;
        if index >= kept + self.rows {
            return std::borrow::Cow::Owned(vec![BLANK; self.cols]);
        }
        if index < kept {
            let cells = self.scrollback.get(index);
            if cells.len() < self.cols {
                let mut padded = cells.clone();
                padded.resize(self.cols, BLANK);
                return std::borrow::Cow::Owned(padded);
            }
            return std::borrow::Cow::Borrowed(cells);
        }
        std::borrow::Cow::Borrowed(&self.buffer.grid[index - kept])
    }

    pub fn feed(&mut self, text: &str) {
        let mut parser = self.parser.take().unwrap_or_default();
        parser.advance(self, text.as_bytes());
        self.parser = Some(parser);
        if self.dirty {
            self.dirty = false;
            self.revision += 1;
        }
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        if cols == self.cols && rows == self.rows {
            return;
        }
        let mut active = std::mem::replace(&mut self.buffer, Buffer::new(1, 1, &BLANK));
        self.resize_buffer(&mut active, cols, rows, !self.alt_screen_active);
        self.buffer = active;
        if let Some(mut main) = self.inactive.take() {
            self.resize_buffer(&mut main, cols, rows, true);
            self.inactive = Some(main);
        }
        let mut stops = default_tab_stops(cols);
        let kept = self.cols.min(cols);
        stops[..kept].copy_from_slice(&self.tab_stops[..kept]);
        self.tab_stops = stops;
        self.cols = cols;
        self.rows = rows;
        self.revision += 1;
    }

    fn resize_buffer(&mut self, target: &mut Buffer, cols: usize, rows: usize, uses_scrollback: bool) {
        for line in &mut target.grid {
            if line.len() > cols {
                if line[cols].continuation {
                    line[cols - 1].text = CellText::None;
                }
                line.truncate(cols);
            } else {
                line.resize(cols, BLANK);
            }
        }
        let mut excess = target.grid.len().saturating_sub(rows);
        while excess > 0 {
            if target.grid.len() - 1 > target.cursor_row {
                target.grid.pop();
            } else {
                let line = target.grid.remove(0);
                if uses_scrollback {
                    self.scrollback.push(Self::trimmed(line));
                }
                target.cursor_row = target.cursor_row.saturating_sub(1);
            }
            excess -= 1;
        }
        while target.grid.len() < rows {
            let restorable = uses_scrollback && target.cursor_row + 1 == target.grid.len();
            match restorable.then(|| self.scrollback.pop_last()).flatten() {
                Some(mut line) => {
                    line.resize(cols, BLANK);
                    target.grid.insert(0, line);
                    target.cursor_row += 1;
                }
                None => target.grid.push(vec![BLANK; cols]),
            }
        }
        target.scroll_top = 0;
        target.scroll_bottom = rows - 1;
        target.cursor_col = target.cursor_col.min(cols - 1);
        target.cursor_row = target.cursor_row.min(rows - 1);
        target.pending_wrap = false;
        if let Some(saved) = &mut target.saved {
            saved.col = saved.col.min(cols - 1);
            saved.row = saved.row.min(rows - 1);
        }
    }

    pub fn encode(&self, key: VtKey) -> String {
        let arrow = if self.application_cursor_keys { "\u{1b}O" } else { "\u{1b}[" };
        let control = |c: char| char::from_u32(c as u32).map(String::from).unwrap_or_default();
        match key {
            VtKey::Char(c) => c.to_string(),
            VtKey::Enter => "\r".into(),
            VtKey::Tab => "\t".into(),
            VtKey::Backspace => "\u{7f}".into(),
            VtKey::Escape => "\u{1b}".into(),
            VtKey::Up => format!("{arrow}A"),
            VtKey::Down => format!("{arrow}B"),
            VtKey::Right => format!("{arrow}C"),
            VtKey::Left => format!("{arrow}D"),
            VtKey::Home => format!("{arrow}H"),
            VtKey::End => format!("{arrow}F"),
            VtKey::PageUp => "\u{1b}[5~".into(),
            VtKey::PageDown => "\u{1b}[6~".into(),
            VtKey::Delete => "\u{1b}[3~".into(),
            VtKey::Function(n) => match n {
                1 => "\u{1b}OP",
                2 => "\u{1b}OQ",
                3 => "\u{1b}OR",
                4 => "\u{1b}OS",
                5 => "\u{1b}[15~",
                6 => "\u{1b}[17~",
                7 => "\u{1b}[18~",
                8 => "\u{1b}[19~",
                9 => "\u{1b}[20~",
                10 => "\u{1b}[21~",
                11 => "\u{1b}[23~",
                12 => "\u{1b}[24~",
                _ => "",
            }
            .into(),
            VtKey::Control(c) => match c as u32 {
                0x61..=0x7A => control((c as u8 - 0x60) as char),
                0x41..=0x5F => control((c as u8 - 0x40) as char),
                0x40 | 0x20 => "\0".into(),
                0x3F => "\u{7f}".into(),
                _ => String::new(),
            },
        }
    }

    pub fn encode_paste(&self, text: &str) -> String {
        let body = text.replace("\r\n", "\r").replace('\n', "\r");
        if self.bracketed_paste { format!("\u{1b}[200~{body}\u{1b}[201~") } else { body }
    }

    pub fn take_responses(&mut self) -> String {
        std::mem::take(&mut self.responses)
    }

    pub fn reset(&mut self) {
        self.buffer = Buffer::new(self.cols, self.rows, &BLANK);
        self.inactive = None;
        self.alt_screen_active = false;
        self.scrollback.clear();
        self.title = None;
        self.responses.clear();
        self.last_printed = None;
        self.soft_reset();
        self.dirty = false;
        self.revision += 1;
    }

    fn soft_reset(&mut self) {
        self.style = Style::default();
        self.origin_mode = false;
        self.autowrap = true;
        self.insert_mode = false;
        self.newline_mode = false;
        self.cursor_visible = true;
        self.application_cursor_keys = false;
        self.bracketed_paste = false;
        self.mouse_tracking = 0;
        self.sgr_mouse = false;
        self.focus_reporting = false;
        self.g0 = false;
        self.g1 = false;
        self.shifted_out = false;
        self.tab_stops = default_tab_stops(self.cols);
        self.buffer.scroll_top = 0;
        self.buffer.scroll_bottom = self.rows - 1;
        self.buffer.pending_wrap = false;
        self.buffer.saved = None;
        self.dirty = true;
    }

    fn execute_c0(&mut self, value: u8) {
        match value {
            0x07 => {
                self.bell_count += 1;
                self.dirty = true;
            }
            0x08 => {
                if self.buffer.cursor_col > 0 {
                    self.buffer.cursor_col -= 1;
                }
                self.buffer.pending_wrap = false;
                self.dirty = true;
            }
            0x09 => self.tab(1),
            0x0A..=0x0C => {
                self.line_feed();
                if self.newline_mode {
                    self.buffer.cursor_col = 0;
                }
            }
            0x0D => {
                self.buffer.cursor_col = 0;
                self.buffer.pending_wrap = false;
                self.dirty = true;
            }
            0x0E => self.shifted_out = true,
            0x0F => self.shifted_out = false,
            _ => {}
        }
    }

    fn control_c1(&mut self, value: u32) {
        match value {
            0x84 => self.line_feed(),
            0x85 => {
                self.line_feed();
                self.buffer.cursor_col = 0;
            }
            0x88 => {
                let c = self.buffer.cursor_col;
                self.tab_stops[c] = true;
            }
            0x8D => self.reverse_index(),
            _ => {}
        }
    }

    fn arg(&self, index: usize, fallback: usize) -> usize {
        let value = self.params.get(index).copied().unwrap_or(0);
        if value == 0 { fallback } else { value }
    }

    fn respond(&mut self, text: String) {
        if self.responses.len() + text.len() <= MAX_RESPONSE {
            self.responses.push_str(&text);
        }
    }

    fn reported_row(&self) -> usize {
        (if self.origin_mode { self.buffer.cursor_row - self.buffer.scroll_top } else { self.buffer.cursor_row }) + 1
    }

    fn csi(&mut self, private: u8, intermediates: &[u8], action: char) {
        if !intermediates.is_empty() {
            if intermediates[0] == b'!' && action == 'p' {
                self.soft_reset();
            }
            return;
        }
        match private {
            0 => {}
            b'?' => {
                match action {
                    'h' => self.set_private_modes(true),
                    'l' => self.set_private_modes(false),
                    'n' => {
                        if self.arg(0, 0) == 6 {
                            let r = format!("\u{1b}[?{};{}R", self.reported_row(), self.buffer.cursor_col + 1);
                            self.respond(r);
                        }
                    }
                    'J' => self.erase_in_display(self.arg(0, 0)),
                    'K' => self.erase_in_line(self.arg(0, 0)),
                    _ => {}
                }
                return;
            }
            b'>' => {
                if action == 'c' && self.arg(0, 0) == 0 {
                    self.respond("\u{1b}[>0;276;0c".into());
                }
                return;
            }
            _ => return,
        }
        let col = self.buffer.cursor_col as isize;
        let row = self.buffer.cursor_row;
        match action {
            '@' => self.insert_cells(self.arg(0, 1)),
            'A' => self.cursor_up(self.arg(0, 1)),
            'B' => self.cursor_down(self.arg(0, 1)),
            'C' | 'a' => self.move_cursor(col + self.arg(0, 1) as isize, row as isize),
            'D' => self.move_cursor(col - self.arg(0, 1) as isize, row as isize),
            'E' => {
                self.cursor_down(self.arg(0, 1));
                self.buffer.cursor_col = 0;
            }
            'F' => {
                self.cursor_up(self.arg(0, 1));
                self.buffer.cursor_col = 0;
            }
            'G' | '`' => self.move_cursor(self.arg(0, 1) as isize - 1, row as isize),
            'H' | 'f' => self.set_cursor(self.arg(1, 1) as isize - 1, self.arg(0, 1) as isize - 1, false),
            'I' => self.tab(self.arg(0, 1)),
            'J' => self.erase_in_display(self.arg(0, 0)),
            'K' => self.erase_in_line(self.arg(0, 0)),
            'L' => self.insert_lines(self.arg(0, 1)),
            'M' => self.delete_lines(self.arg(0, 1)),
            'P' => self.delete_cells(self.arg(0, 1)),
            'S' => self.scroll_up(self.arg(0, 1)),
            'T' => {
                if self.params.len() <= 1 {
                    self.scroll_down(self.arg(0, 1))
                }
            }
            'X' => self.erase_cells(self.arg(0, 1)),
            'Z' => self.back_tab(self.arg(0, 1)),
            'b' => self.repeat_last(self.arg(0, 1)),
            'c' => {
                if self.arg(0, 0) == 0 {
                    self.respond("\u{1b}[?1;2c".into());
                }
            }
            'd' => self.set_cursor(col, self.arg(0, 1) as isize - 1, true),
            'e' => self.cursor_down(self.arg(0, 1)),
            'g' => match self.arg(0, 0) {
                0 => {
                    let c = self.buffer.cursor_col;
                    self.tab_stops[c] = false;
                }
                3 => self.tab_stops = vec![false; self.cols],
                _ => {}
            },
            'h' => self.set_modes(true),
            'l' => self.set_modes(false),
            'm' => self.select_graphic_rendition(),
            'n' => match self.arg(0, 0) {
                5 => self.respond("\u{1b}[0n".into()),
                6 => {
                    let r = format!("\u{1b}[{};{}R", self.reported_row(), self.buffer.cursor_col + 1);
                    self.respond(r);
                }
                _ => {}
            },
            'r' => {
                let rows = self.rows;
                self.set_margins(self.arg(0, 1) as isize - 1, self.arg(1, rows) as isize - 1)
            }
            's' => self.save_cursor(),
            't' => {
                if self.arg(0, 0) == 18 {
                    let r = format!("\u{1b}[8;{};{}t", self.rows, self.cols);
                    self.respond(r);
                }
            }
            'u' => self.restore_cursor(),
            _ => {}
        }
    }

    fn set_modes(&mut self, on: bool) {
        for i in 0..self.params.len() {
            match self.params[i] {
                4 => self.insert_mode = on,
                20 => self.newline_mode = on,
                _ => {}
            }
        }
    }

    fn set_private_modes(&mut self, on: bool) {
        for i in 0..self.params.len() {
            match self.params[i] {
                1 => self.application_cursor_keys = on,
                6 => {
                    self.origin_mode = on;
                    self.set_cursor(0, 0, false);
                }
                7 => self.autowrap = on,
                25 => {
                    self.cursor_visible = on;
                    self.dirty = true;
                }
                47 | 1047 => {
                    if on {
                        self.enter_alt_screen()
                    } else {
                        self.leave_alt_screen()
                    }
                }
                1048 => {
                    if on {
                        self.save_cursor()
                    } else {
                        self.restore_cursor()
                    }
                }
                1049 => {
                    if on {
                        self.save_cursor();
                        self.enter_alt_screen();
                    } else {
                        self.leave_alt_screen();
                        self.restore_cursor();
                    }
                }
                1000 => self.mouse_tracking = if on { 1 } else { 0 },
                1002 => self.mouse_tracking = if on { 2 } else { 0 },
                1003 => self.mouse_tracking = if on { 3 } else { 0 },
                1004 => self.focus_reporting = on,
                1006 => self.sgr_mouse = on,
                2004 => self.bracketed_paste = on,
                _ => {}
            }
        }
    }

    fn select_graphic_rendition(&mut self) {
        let mut index = 0;
        while index < self.params.len() {
            let code = self.params[index];
            if self.subparams[index] {
                index += 1;
                continue;
            }
            let s = &mut self.style;
            match code {
                0 => *s = Style::default(),
                1 => s.bold = true,
                2 => s.dim = true,
                3 => s.italic = true,
                4 => s.underline = !(index + 1 < self.params.len() && self.subparams[index + 1] && self.params[index + 1] == 0),
                7 => s.inverse = true,
                8 => s.hidden = true,
                9 => s.strikethrough = true,
                21 => s.underline = true,
                22 => {
                    s.bold = false;
                    s.dim = false;
                }
                23 => s.italic = false,
                24 => s.underline = false,
                27 => s.inverse = false,
                28 => s.hidden = false,
                29 => s.strikethrough = false,
                30..=37 => s.fg = Color::Indexed((code - 30) as u8),
                38 => {
                    if let Some(c) = self.extended_color(&mut index) {
                        self.style.fg = c
                    }
                }
                39 => s.fg = Color::Default,
                40..=47 => s.bg = Color::Indexed((code - 40) as u8),
                48 => {
                    if let Some(c) = self.extended_color(&mut index) {
                        self.style.bg = c
                    }
                }
                49 => s.bg = Color::Default,
                58 => {
                    let _ = self.extended_color(&mut index);
                }
                90..=97 => s.fg = Color::Indexed((code - 82) as u8),
                100..=107 => s.bg = Color::Indexed((code - 92) as u8),
                _ => {}
            }
            index += 1;
        }
    }

    fn extended_color(&self, index: &mut usize) -> Option<Color> {
        let p = &self.params;
        let start = *index + 1;
        let clamp = |v: usize| v.min(255) as u8;
        if start < p.len() && self.subparams[start] {
            let mut end = start;
            while end < p.len() && self.subparams[end] {
                end += 1;
            }
            *index = end - 1;
            let args = &p[start..end];
            // Swift indexes the ArraySlice with absolute indices; args[k] here is p[start + k].
            return match args.first() {
                Some(5) => {
                    if args.len() >= 2 {
                        Some(Color::Indexed(clamp(p[start + 1])))
                    } else {
                        None
                    }
                }
                Some(2) => {
                    if args.len() >= 5 {
                        Some(Color::Rgb(clamp(p[start + 2]), clamp(p[start + 3]), clamp(p[start + 4])))
                    } else if args.len() == 4 {
                        Some(Color::Rgb(clamp(p[start + 1]), clamp(p[start + 2]), clamp(p[start + 3])))
                    } else {
                        None
                    }
                }
                _ => None,
            };
        }
        if start >= p.len() {
            *index = p.len();
            return None;
        }
        match p[start] {
            5 => {
                *index = start + 1;
                if *index < p.len() { Some(Color::Indexed(clamp(p[*index]))) } else { None }
            }
            2 => {
                *index = start + 3;
                if *index < p.len() { Some(Color::Rgb(clamp(p[start + 1]), clamp(p[start + 2]), clamp(p[start + 3]))) } else { None }
            }
            _ => {
                *index = start;
                None
            }
        }
    }

    fn print_char(&mut self, c: char) {
        let v = c as u32;
        if v < 0x7F {
            let graphics = if self.shifted_out { self.g1 } else { self.g0 };
            if graphics && v >= 0x60 {
                self.put(CellText::Char(DEC_GRAPHICS[(v - 0x60) as usize]), 1);
            } else {
                self.put(CellText::Char(c), 1);
            }
            return;
        }
        let width = width_of(c);
        if width == 0 {
            self.attach(c);
        } else {
            self.put(CellText::Char(c), width);
        }
    }

    fn put(&mut self, text: CellText, width: usize) {
        let cols = self.cols;
        if self.buffer.pending_wrap {
            self.buffer.pending_wrap = false;
            if self.autowrap {
                self.buffer.cursor_col = 0;
                self.line_feed();
            }
        }
        if width == 2 {
            if cols < 2 {
                return;
            }
            if self.buffer.cursor_col == cols - 1 {
                if self.autowrap {
                    let row = self.buffer.cursor_row;
                    self.sever_wide(row, cols - 1);
                    self.blank_cell(row, cols - 1);
                    self.buffer.cursor_col = 0;
                    self.line_feed();
                } else {
                    self.buffer.cursor_col = cols - 2;
                }
            }
        }
        let row = self.buffer.cursor_row;
        let col = self.buffer.cursor_col;
        if self.insert_mode {
            self.shift_right(row, col, width);
        }
        self.sever_wide(row, col);
        self.sever_wide(row, col + width);
        let style = self.style;
        self.last_printed = Some((text.clone(), width));
        self.buffer.grid[row][col] = Cell { text, style, continuation: false };
        if width == 2 {
            self.buffer.grid[row][col + 1] = Cell { text: CellText::None, style, continuation: true };
        }
        if col + width >= cols {
            self.buffer.cursor_col = cols - 1;
            self.buffer.pending_wrap = self.autowrap;
        } else {
            self.buffer.cursor_col = col + width;
        }
        self.dirty = true;
    }

    fn attach(&mut self, c: char) {
        let row = self.buffer.cursor_row;
        let mut col = if self.buffer.pending_wrap { self.buffer.cursor_col as isize } else { self.buffer.cursor_col as isize - 1 };
        if col < 0 {
            return;
        }
        if self.buffer.grid[row][col as usize].continuation {
            col -= 1;
        }
        if col < 0 {
            return;
        }
        let cell = &mut self.buffer.grid[row][col as usize];
        let mut text = match &cell.text {
            CellText::None => String::new(),
            CellText::Char(ch) => ch.to_string(),
            CellText::Cluster(s) => s.to_string(),
        };
        text.push(c);
        if text.graphemes(true).count() != 1 {
            return;
        }
        cell.text = CellText::Cluster(text.into_boxed_str());
        self.dirty = true;
    }

    fn repeat_last(&mut self, count: usize) {
        let Some((text, width)) = self.last_printed.clone() else {
            return;
        };
        for _ in 0..count.min(MAX_REPEAT) {
            self.put(text.clone(), width);
        }
    }

    fn sever_wide(&mut self, row: usize, boundary: usize) {
        if boundary == 0 || boundary >= self.cols || !self.buffer.grid[row][boundary].continuation {
            return;
        }
        self.blank_cell(row, boundary - 1);
        self.blank_cell(row, boundary);
    }

    fn blank_cell(&mut self, row: usize, col: usize) {
        let cell = &mut self.buffer.grid[row][col];
        cell.text = CellText::None;
        cell.continuation = false;
    }

    fn move_cursor(&mut self, col: isize, row: isize) {
        self.buffer.cursor_col = col.clamp(0, self.cols as isize - 1) as usize;
        self.buffer.cursor_row = row.clamp(0, self.rows as isize - 1) as usize;
        self.buffer.pending_wrap = false;
        self.dirty = true;
    }

    fn set_cursor(&mut self, col: isize, row: isize, keep_col: bool) {
        let top = if self.origin_mode { self.buffer.scroll_top } else { 0 } as isize;
        let bottom = if self.origin_mode { self.buffer.scroll_bottom } else { self.rows - 1 } as isize;
        let c = if keep_col { self.buffer.cursor_col as isize } else { col };
        self.move_cursor(c, (row + top).max(top).min(bottom));
    }

    fn cursor_up(&mut self, count: usize) {
        let b = &self.buffer;
        let limit = if b.cursor_row >= b.scroll_top { b.scroll_top } else { 0 } as isize;
        let target = (b.cursor_row as isize - count as isize).max(limit);
        self.move_cursor(b.cursor_col as isize, target);
    }

    fn cursor_down(&mut self, count: usize) {
        let b = &self.buffer;
        let limit = if b.cursor_row <= b.scroll_bottom { b.scroll_bottom } else { self.rows - 1 };
        let target = (b.cursor_row + count).min(limit);
        self.move_cursor(b.cursor_col as isize, target as isize);
    }

    fn tab(&mut self, count: usize) {
        let mut col = self.buffer.cursor_col;
        for _ in 0..count {
            let mut next = col + 1;
            while next + 1 < self.cols && !self.tab_stops[next] {
                next += 1;
            }
            col = next.min(self.cols - 1);
        }
        self.move_cursor(col as isize, self.buffer.cursor_row as isize);
    }

    fn back_tab(&mut self, count: usize) {
        let mut col = self.buffer.cursor_col as isize;
        for _ in 0..count {
            let mut previous = col - 1;
            while previous > 0 && !self.tab_stops[previous as usize] {
                previous -= 1;
            }
            col = previous.max(0);
        }
        self.move_cursor(col, self.buffer.cursor_row as isize);
    }

    fn line_feed(&mut self) {
        self.buffer.pending_wrap = false;
        if self.buffer.cursor_row == self.buffer.scroll_bottom {
            self.scroll_up(1);
        } else if self.buffer.cursor_row < self.rows - 1 {
            self.buffer.cursor_row += 1;
        }
        self.dirty = true;
    }

    fn reverse_index(&mut self) {
        self.buffer.pending_wrap = false;
        if self.buffer.cursor_row == self.buffer.scroll_top {
            self.scroll_down(1);
        } else if self.buffer.cursor_row > 0 {
            self.buffer.cursor_row -= 1;
        }
        self.dirty = true;
    }

    fn save_cursor(&mut self) {
        self.buffer.saved = Some(SavedCursor {
            col: self.buffer.cursor_col,
            row: self.buffer.cursor_row,
            style: self.style,
            origin_mode: self.origin_mode,
            g0: self.g0,
            g1: self.g1,
            shifted_out: self.shifted_out,
        });
    }

    fn restore_cursor(&mut self) {
        let Some(saved) = self.buffer.saved else {
            self.move_cursor(0, 0);
            self.style = Style::default();
            return;
        };
        self.style = saved.style;
        self.origin_mode = saved.origin_mode;
        self.g0 = saved.g0;
        self.g1 = saved.g1;
        self.shifted_out = saved.shifted_out;
        self.move_cursor(saved.col as isize, saved.row as isize);
    }

    fn set_margins(&mut self, top: isize, bottom: isize) {
        let top = top.max(0);
        let bottom = bottom.min(self.rows as isize - 1);
        if top >= bottom {
            return;
        }
        self.buffer.scroll_top = top as usize;
        self.buffer.scroll_bottom = bottom as usize;
        self.set_cursor(0, 0, false);
    }

    fn erase_cell(&self) -> Cell {
        Cell { text: CellText::None, style: Style { bg: self.style.bg, ..Style::default() }, continuation: false }
    }

    fn blank_line(&self) -> Vec<Cell> {
        vec![self.erase_cell(); self.cols]
    }

    fn fill(&mut self, row: usize, from: usize, to: usize) {
        if from >= to {
            return;
        }
        self.sever_wide(row, from);
        self.sever_wide(row, to);
        let blank = self.erase_cell();
        for cell in &mut self.buffer.grid[row][from..to] {
            *cell = blank.clone();
        }
        self.dirty = true;
    }

    fn erase_in_line(&mut self, mode: usize) {
        self.buffer.pending_wrap = false;
        let row = self.buffer.cursor_row;
        let cols = self.cols;
        match mode {
            0 => self.fill(row, self.buffer.cursor_col, cols),
            1 => self.fill(row, 0, (self.buffer.cursor_col + 1).min(cols)),
            2 => self.fill(row, 0, cols),
            _ => {}
        }
    }

    fn erase_in_display(&mut self, mode: usize) {
        self.buffer.pending_wrap = false;
        match mode {
            0 => {
                self.erase_in_line(0);
                for row in self.buffer.cursor_row + 1..self.rows {
                    self.buffer.grid[row] = self.blank_line();
                }
            }
            1 => {
                self.erase_in_line(1);
                for row in 0..self.buffer.cursor_row {
                    self.buffer.grid[row] = self.blank_line();
                }
            }
            2 => {
                for row in 0..self.rows {
                    self.buffer.grid[row] = self.blank_line();
                }
            }
            3 => self.scrollback.clear(),
            _ => return,
        }
        self.dirty = true;
    }

    fn erase_cells(&mut self, count: usize) {
        let col = self.buffer.cursor_col;
        self.fill(self.buffer.cursor_row, col, (col + count).min(self.cols));
        self.buffer.pending_wrap = false;
    }

    fn insert_cells(&mut self, count: usize) {
        self.shift_right(self.buffer.cursor_row, self.buffer.cursor_col, count);
        self.buffer.pending_wrap = false;
    }

    fn shift_right(&mut self, row: usize, col: usize, count: usize) {
        let count = count.min(self.cols - col);
        if count == 0 {
            return;
        }
        self.sever_wide(row, col);
        self.sever_wide(row, self.cols - count);
        let blank = self.erase_cell();
        let line = &mut self.buffer.grid[row];
        line.truncate(line.len() - count);
        line.splice(col..col, std::iter::repeat_n(blank, count));
        self.dirty = true;
    }

    fn delete_cells(&mut self, count: usize) {
        let row = self.buffer.cursor_row;
        let col = self.buffer.cursor_col;
        let count = count.min(self.cols - col);
        if count == 0 {
            return;
        }
        self.sever_wide(row, col);
        self.sever_wide(row, col + count);
        let blank = self.erase_cell();
        let line = &mut self.buffer.grid[row];
        line.drain(col..col + count);
        line.extend(std::iter::repeat_n(blank, count));
        self.buffer.pending_wrap = false;
        self.dirty = true;
    }

    fn trimmed(mut line: Vec<Cell>) -> Vec<Cell> {
        let mut end = line.len();
        while end > 0 && line[end - 1].is_blank() && !line[end - 1].style.paints_blank() {
            end -= 1;
        }
        line.truncate(end);
        line
    }

    fn scroll_up(&mut self, count: usize) {
        let top = self.buffer.scroll_top;
        let bottom = self.buffer.scroll_bottom;
        let keep = !self.alt_screen_active && top == 0;
        for _ in 0..count.min(bottom - top + 1) {
            let line = self.buffer.grid.remove(top);
            if keep {
                self.scrollback.push(Self::trimmed(line));
            }
            let blank = self.blank_line();
            self.buffer.grid.insert(bottom, blank);
        }
        self.dirty = true;
    }

    fn scroll_down(&mut self, count: usize) {
        let top = self.buffer.scroll_top;
        let bottom = self.buffer.scroll_bottom;
        for _ in 0..count.min(bottom - top + 1) {
            self.buffer.grid.remove(bottom);
            let blank = self.blank_line();
            self.buffer.grid.insert(top, blank);
        }
        self.dirty = true;
    }

    fn insert_lines(&mut self, count: usize) {
        let row = self.buffer.cursor_row;
        if row < self.buffer.scroll_top || row > self.buffer.scroll_bottom {
            return;
        }
        for _ in 0..count.min(self.buffer.scroll_bottom - row + 1) {
            self.buffer.grid.remove(self.buffer.scroll_bottom);
            let blank = self.blank_line();
            self.buffer.grid.insert(row, blank);
        }
        self.buffer.cursor_col = 0;
        self.buffer.pending_wrap = false;
        self.dirty = true;
    }

    fn delete_lines(&mut self, count: usize) {
        let row = self.buffer.cursor_row;
        if row < self.buffer.scroll_top || row > self.buffer.scroll_bottom {
            return;
        }
        for _ in 0..count.min(self.buffer.scroll_bottom - row + 1) {
            self.buffer.grid.remove(row);
            let blank = self.blank_line();
            self.buffer.grid.insert(self.buffer.scroll_bottom, blank);
        }
        self.buffer.cursor_col = 0;
        self.buffer.pending_wrap = false;
        self.dirty = true;
    }

    fn alignment_test(&mut self) {
        let cell = Cell { text: CellText::Char('E'), style: Style::default(), continuation: false };
        for row in 0..self.rows {
            self.buffer.grid[row] = vec![cell.clone(); self.cols];
        }
        self.buffer.scroll_top = 0;
        self.buffer.scroll_bottom = self.rows - 1;
        self.move_cursor(0, 0);
    }

    fn enter_alt_screen(&mut self) {
        if self.alt_screen_active {
            return;
        }
        let fill = self.erase_cell();
        let mut alt = Buffer::new(self.cols, self.rows, &fill);
        alt.cursor_col = self.buffer.cursor_col;
        alt.cursor_row = self.buffer.cursor_row;
        self.inactive = Some(std::mem::replace(&mut self.buffer, alt));
        self.alt_screen_active = true;
        self.dirty = true;
    }

    fn leave_alt_screen(&mut self) {
        if !self.alt_screen_active {
            return;
        }
        let Some(mut main) = self.inactive.take() else {
            return;
        };
        main.cursor_col = self.buffer.cursor_col;
        main.cursor_row = self.buffer.cursor_row;
        main.pending_wrap = false;
        self.buffer = main;
        self.alt_screen_active = false;
        self.dirty = true;
    }
}

impl vte::Perform for VtScreen {
    fn print(&mut self, c: char) {
        let v = c as u32;
        if (0x80..0xA0).contains(&v) {
            self.control_c1(v);
        } else {
            self.print_char(c);
        }
    }

    fn execute(&mut self, byte: u8) {
        self.execute_c0(byte);
    }

    fn csi_dispatch(&mut self, params: &vte::Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        self.params.clear();
        self.subparams.clear();
        for group in params.iter() {
            for (k, &value) in group.iter().enumerate() {
                if self.params.len() < 32 {
                    self.params.push(value as usize);
                    self.subparams.push(k > 0);
                }
            }
        }
        if self.params.is_empty() {
            self.params.push(0);
            self.subparams.push(false);
        }
        let (private, rest) = match intermediates.first() {
            Some(&b) if (0x3C..=0x3F).contains(&b) => (b, &intermediates[1..]),
            _ => (0, intermediates),
        };
        self.csi(private, rest, action);
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        if intermediates.len() > 1 {
            return;
        }
        match intermediates.first() {
            None => match byte {
                b'7' => self.save_cursor(),
                b'8' => self.restore_cursor(),
                b'D' => self.line_feed(),
                b'E' => {
                    self.line_feed();
                    self.buffer.cursor_col = 0;
                }
                b'H' => {
                    let c = self.buffer.cursor_col;
                    self.tab_stops[c] = true;
                }
                b'M' => self.reverse_index(),
                b'c' => self.reset(),
                _ => {}
            },
            Some(b'(') => self.g0 = byte == b'0',
            Some(b')') => self.g1 = byte == b'0',
            Some(b'#') if byte == b'8' => self.alignment_test(),
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some(code) = params.first().and_then(|p| std::str::from_utf8(p).ok()).and_then(|s| s.parse::<i64>().ok()) else {
            return;
        };
        if params.len() < 2 {
            return;
        }
        if code == 0 || code == 2 {
            let title: Vec<String> = params[1..].iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect();
            self.title = Some(title.join(";"));
            self.dirty = true;
        }
    }
}
