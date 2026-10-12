use crate::book::{HeightBook, PlanCache};
use crate::planner::{self, Metrics, TermLine};
use crate::protocol::{Frame, decode_frame};
use crate::rows::TerminalRows;
use crate::transcript::{TranscriptState, apply_event};
use crate::vt::{CellText, Color, Style, VtScreen};

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
            metrics: Metrics {
                cell: cell_px,
                line: line_px,
                width: width_px,
                font_size: 32.0,
            },
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
        let first = vt.total_rows() - vt.rows;
        let mut runs: Vec<(Style, String)> = Vec::new();
        for index in first..vt.total_rows() {
            let cells = vt.line(index);
            runs.clear();
            for cell in cells.iter() {
                if cell.continuation {
                    continue;
                }
                let same = matches!(runs.last(), Some((style, _)) if *style == cell.style);
                if !same {
                    runs.push((cell.style, String::new()));
                }
                let text = &mut runs.last_mut().unwrap().1;
                match &cell.text {
                    CellText::None => text.push(' '),
                    CellText::Char(c) => text.push(*c),
                    CellText::Cluster(s) => text.push_str(s),
                }
            }
            out.u16(runs.len().min(u16::MAX as usize) as u16);
            for (style, text) in &runs {
                out.u32(color(style.fg));
                out.u32(color(style.bg));
                out.u8((style.bold as u8)
                    | ((style.dim as u8) << 1)
                    | ((style.italic as u8) << 2)
                    | ((style.underline as u8) << 3)
                    | ((style.inverse as u8) << 4)
                    | ((style.strikethrough as u8) << 5));
                out.str32(text);
            }
        }
        out.bytes
    }
}

fn color(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(i) => 0x0100_0000 | i as u32,
        Color::Rgb(r, g, b) => 0x0200_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
    }
}

pub struct ByteWriter {
    pub bytes: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        ByteWriter {
            bytes: Vec::with_capacity(16 * 1024),
        }
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
    pub fn str16(&mut self, s: &str) {
        let b = &s.as_bytes()[..s.len().min(u16::MAX as usize)];
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
