use crate::book::{HeightBook, PlanCache};
use crate::planner::{self, Metrics, TermLine};
use crate::protocol::{Frame, decode_frame};
use crate::rows::TerminalRows;
use crate::transcript::{TranscriptState, apply_event};
use crate::vt::{Cell, CellText, Color, Style, VtScreen};

pub struct Engine {
    pub state: TranscriptState,
    cache: PlanCache,
    pub metrics: Metrics,
    pub vt: VtScreen,
    pub rows: TerminalRows,
    pub book: HeightBook,
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new(1080.0, 19.8, 44.0, 120, 40)
    }
}

impl Engine {
    pub fn new(width_px: f64, cell_px: f64, line_px: f64, cols: usize, vt_rows: usize) -> Self {
        Engine {
            state: TranscriptState::default(),
            cache: PlanCache::new(),
            metrics: Metrics { cell: cell_px, line: line_px, width: width_px, font_size: 32.0 },
            vt: VtScreen::new(cols, vt_rows, 1000),
            rows: TerminalRows::build(&[]),
            book: HeightBook::empty(),
        }
    }

    pub fn ingest_line(&mut self, line: &[u8]) -> bool {
        match decode_frame(line) {
            Some(Frame::Event(event)) => {
                apply_event(&mut self.state, event);
                true
            }
            Some(Frame::ShellOutput { data, .. }) => {
                self.vt.feed(&data);
                true
            }
            _ => false,
        }
    }

    pub fn ingest_batch(&mut self, batch: &[u8]) -> usize {
        let mut applied = 0;
        for line in batch.split(|&b| b == b'\n') {
            if !line.is_empty() && self.ingest_line(line) {
                applied += 1;
            }
        }
        applied
    }

    pub fn layout(&mut self) {
        self.rows = TerminalRows::build(&self.state.items);
        self.book = HeightBook::new(&self.rows, &self.metrics, Some(&mut self.cache));
    }

    pub fn layout_timed(&mut self) -> (f64, f64) {
        let a = std::time::Instant::now();
        self.rows = TerminalRows::build(&self.state.items);
        let b = std::time::Instant::now();
        self.book = HeightBook::new(&self.rows, &self.metrics, Some(&mut self.cache));
        let c = std::time::Instant::now();
        ((b - a).as_nanos() as f64 / 1000.0, (c - b).as_nanos() as f64 / 1000.0)
    }

    pub fn item_count(&self) -> usize {
        self.state.items.len()
    }

    pub fn tail_lines(&self, max_lines: usize) -> Vec<TermLine> {
        let mut chunks: Vec<Vec<TermLine>> = Vec::new();
        let mut total = 0usize;
        let mut index = self.rows.len();
        while index > 0 && total < max_lines {
            index -= 1;
            let planned = planner::plan(&self.rows.rows[index], &self.metrics);
            total += planned.len();
            chunks.push(planned);
        }
        let mut lines: Vec<TermLine> = Vec::with_capacity(total);
        for chunk in chunks.into_iter().rev() {
            lines.extend(chunk);
        }
        if lines.len() > max_lines {
            lines.drain(..lines.len() - max_lines);
        }
        lines
    }

    pub fn snapshot(&self, max_lines: usize) -> Vec<u8> {
        let lines = self.tail_lines(max_lines);
        let mut out = ByteWriter::new();
        out.u32(self.state.items.len() as u32);
        out.u32(self.rows.len() as u32);
        let total = (self.book.offset(self.rows.len()) / self.metrics.line).max(0.0);
        out.u32(total as u32);
        out.u32(lines.len() as u32);
        for line in &lines {
            out.u8(line.tone as u8);
            out.u8(line.gutter_tone as u8);
            out.u8((line.bold as u8) | ((line.italic as u8) << 1) | ((line.nested as u8) << 2));
            out.u8(line.indent.min(255) as u8);
            out.str16(&line.gutter);
            out.str32(&line.text);
            match &line.attributed {
                Some(runs) => {
                    let n = runs.len().min(u16::MAX as usize);
                    out.u16(n as u16);
                    for &(start, len, intent) in &runs[..n] {
                        out.u32(start as u32);
                        out.u32(len as u32);
                        out.u8(intent);
                    }
                }
                None => out.u16(0),
            }
        }
        out.bytes
    }

    pub fn vt_snapshot(&self) -> Vec<u8> {
        let vt = &self.vt;
        let mut out = ByteWriter::new();
        out.u16(vt.cols as u16);
        out.u16(vt.rows as u16);
        for index in vt.total_rows() - vt.rows..vt.total_rows() {
            write_vt_line(&mut out, &vt.line(index));
        }
        out.bytes
    }
}

pub fn write_vt_line(out: &mut ByteWriter, cells: &[Cell]) {
    let mut runs: Vec<(Style, String, u16)> = Vec::new();
    for cell in cells {
        if cell.continuation {
            if let Some(run) = runs.last_mut() {
                run.2 += 1;
            }
            continue;
        }
        let same = matches!(runs.last(), Some((style, _, _)) if *style == cell.style);
        if !same {
            runs.push((cell.style, String::new(), 0));
        }
        let run = runs.last_mut().expect("run");
        run.2 += 1;
        match &cell.text {
            CellText::None => run.1.push(' '),
            CellText::Char(c) => run.1.push(*c),
            CellText::Cluster(s) => run.1.push_str(s),
        }
    }
    let n = runs.len().min(u16::MAX as usize);
    out.u16(n as u16);
    for (style, text, columns) in &runs[..n] {
        let (fg, bg) = resolve(style);
        out.u32(fg);
        out.u32(bg);
        out.u8((style.bold as u8)
            | ((style.dim as u8) << 1)
            | ((style.italic as u8) << 2)
            | ((style.underline as u8) << 3)
            | ((style.inverse as u8) << 4)
            | ((style.strikethrough as u8) << 5)
            | ((style.hidden as u8) << 6));
        out.u16(*columns);
        out.str32(text);
    }
}

pub const SLOT_DEFAULT: u32 = 0;
pub const THEME_FOREGROUND: u32 = 0x0100_0000;
pub const RGB: u32 = 0x0200_0000;
pub const THEME_BACKGROUND: u32 = 0x0300_0000;

const ANSI: [u32; 16] = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff,
    0xff00ff, 0x00ffff, 0xffffff,
];

pub fn xterm_rgb(index: u8) -> u32 {
    match index {
        0..16 => ANSI[index as usize],
        16..232 => {
            let steps = [0u32, 95, 135, 175, 215, 255];
            let offset = (index - 16) as usize;
            steps[offset / 36] << 16 | steps[(offset % 36) / 6] << 8 | steps[offset % 6]
        }
        _ => {
            let level = 8 + (index as u32 - 232) * 10;
            level << 16 | level << 8 | level
        }
    }
}

fn rgb(c: Color) -> Option<u32> {
    match c {
        Color::Default => None,
        Color::Indexed(i) => Some(RGB | xterm_rgb(i)),
        Color::Rgb(r, g, b) => Some(RGB | (r as u32) << 16 | (g as u32) << 8 | b as u32),
    }
}

// Inverse against an unset colour swaps in the theme's own foreground or background, so the renderer only maps four
// slot words onto its palette.
pub fn resolve(style: &Style) -> (u32, u32) {
    let fg = rgb(style.fg);
    let bg = rgb(style.bg);
    if style.inverse {
        (bg.unwrap_or(THEME_BACKGROUND), fg.unwrap_or(THEME_FOREGROUND))
    } else {
        (fg.unwrap_or(SLOT_DEFAULT), bg.unwrap_or(SLOT_DEFAULT))
    }
}

pub struct ByteWriter {
    pub bytes: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        ByteWriter { bytes: Vec::with_capacity(16 * 1024) }
    }
    pub fn u8(&mut self, v: u8) {
        self.bytes.push(v);
    }
    pub fn u16(&mut self, v: u16) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i32(&mut self, v: i32) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i64(&mut self, v: i64) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f32(&mut self, v: f32) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f64(&mut self, v: f64) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }
    pub fn str16(&mut self, s: &str) {
        let mut end = s.len().min(u16::MAX as usize);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        let b = &s.as_bytes()[..end];
        self.u16(b.len() as u16);
        self.bytes.extend_from_slice(b);
    }
    pub fn str32(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.bytes.extend_from_slice(s.as_bytes());
    }
}

impl Default for ByteWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod vt_line_tests {
    use super::*;

    fn style(fg: Color, bg: Color, inverse: bool) -> Style {
        Style { fg, bg, inverse, ..Style::default() }
    }

    #[test]
    fn indexed_colours_resolve_through_the_xterm_table() {
        assert_eq!(xterm_rgb(1), 0xcd0000);
        assert_eq!(xterm_rgb(16), 0x000000);
        assert_eq!(xterm_rgb(196), 0xff0000);
        assert_eq!(xterm_rgb(232), 0x080808);
        assert_eq!(xterm_rgb(255), 0xeeeeee);
        assert_eq!(resolve(&style(Color::Indexed(9), Color::Default, false)), (RGB | 0xff0000, SLOT_DEFAULT));
    }

    #[test]
    fn inverse_swaps_and_fills_unset_colours_from_the_theme() {
        assert_eq!(resolve(&style(Color::Default, Color::Default, true)), (THEME_BACKGROUND, THEME_FOREGROUND));
        assert_eq!(resolve(&style(Color::Rgb(1, 2, 3), Color::Default, true)), (THEME_BACKGROUND, RGB | 0x010203));
        assert_eq!(resolve(&style(Color::Default, Color::Indexed(4), true)), (RGB | 0x0000ee, THEME_FOREGROUND));
    }

    #[test]
    fn a_wide_glyph_is_one_character_in_two_columns() {
        let plain = Cell { text: CellText::Char('a'), style: Style::default(), continuation: false };
        let wide = Cell { text: CellText::Char('漢'), ..plain.clone() };
        let rest = Cell { text: CellText::None, continuation: true, ..plain.clone() };
        let mut out = ByteWriter::new();
        write_vt_line(&mut out, &[plain, wide, rest]);
        let bytes = out.bytes;
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 1);
        assert_eq!(u16::from_le_bytes([bytes[11], bytes[12]]), 3);
    }
}
