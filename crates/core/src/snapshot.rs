// The binary snapshots a native renderer reads. Little-endian, every buffer opens with `VERSION`; a reader that
// sees another version refuses the buffer rather than guessing. Layout per buffer in `docs/NATIVE-CORE-SNAPSHOTS.md`.
use crate::controller::shell::{ShellPhase, ShellSession};
use crate::controller::transcript::TranscriptView;
use crate::engine::{ByteWriter, write_vt_line};
use crate::planner::TermLine;

pub const VERSION: u8 = 1;

pub fn transcript_layout(view: &TranscriptView) -> Vec<u8> {
    let rows = view.rows();
    let prompts = view.prompt_rows();
    let recap = view.recap_row();
    let mut out = ByteWriter::new();
    out.u8(VERSION);
    out.u32(rows.len() as u32);
    for index in 0..rows.len() {
        let row = &rows.rows[index];
        out.str16(&row.key());
        out.f32(view.book().height(index) as f32);
        out.u8((view.gap_above(index) as u8)
            | ((prompts.binary_search(&index).is_ok() as u8) << 1)
            | (((recap == Some(index)) as u8) << 2));
    }
    match view.reveal() {
        Some(reveal) => {
            out.i32(reveal.row as i32);
            out.u64(reveal.nonce);
        }
        None => {
            out.i32(-1);
            out.u64(0);
        }
    }
    out.bytes
}

pub fn transcript_lines(view: &TranscriptView, start: usize, end: usize) -> Vec<u8> {
    let end = end.min(view.rows().len());
    let start = start.min(end);
    let mut out = ByteWriter::new();
    out.u8(VERSION);
    out.u32(start as u32);
    out.u32((end - start) as u32);
    for index in start..end {
        let lines = view.lines(index);
        out.u32(lines.len() as u32);
        for line in lines.iter() {
            write_line(&mut out, line);
        }
    }
    out.bytes
}

// Free-standing lines (a plan in a prompt) in the `transcript_lines` shape: one row starting at 0.
pub fn lines_block(lines: &[TermLine]) -> Vec<u8> {
    let mut out = ByteWriter::new();
    out.u8(VERSION);
    out.u32(0);
    out.u32(1);
    out.u32(lines.len() as u32);
    for line in lines {
        write_line(&mut out, line);
    }
    out.bytes
}

fn write_line(out: &mut ByteWriter, line: &TermLine) {
    out.u8(line.tone as u8);
    out.u8(line.gutter_tone as u8);
    out.u8(line.band as u8);
    out.u8((line.bold as u8)
        | ((line.italic as u8) << 1)
        | ((line.nested as u8) << 2)
        | ((line.pulsing as u8) << 3)
        | ((line.in_open as u8) << 4)
        | ((line.press.is_some() as u8) << 5)
        | ((line.image.is_some() as u8) << 6)
        | ((line.elapsed_since.is_some() as u8) << 7));
    out.u16(line.indent.min(u16::MAX as usize) as u16);
    out.u16(line.columns.min(u16::MAX as usize) as u16);
    out.str16(&line.gutter);
    out.str32(&line.text);
    let runs = line.attributed.as_deref().unwrap_or_default();
    let n = runs.len().min(u16::MAX as usize);
    out.u16(n as u16);
    for &(start, len, intent) in &runs[..n] {
        out.u32(start as u32);
        out.u32(len as u32);
        out.u8(intent);
    }
    if let Some(since) = line.elapsed_since {
        out.f64(since);
    }
    if let Some(image) = &line.image {
        out.str16(&image.tool_use_id);
        out.i64(image.source_seq);
        out.i64(image.part_index);
        out.str16(&image.media_type);
        out.i64(image.bytes);
        out.u16(image.lines.min(u16::MAX as usize) as u16);
    }
}

// `start` counts from the oldest scrollback line; the live screen is the last `rows` lines of `total`.
pub fn shell_grid(shell: &ShellSession, start: usize, count: usize) -> Vec<u8> {
    let screen = shell.screen();
    let total = screen.total_rows();
    let start = start.min(total);
    let end = start.saturating_add(count).min(total);
    let (cursor_row, cursor_col) = screen.cursor();
    let mut out = ByteWriter::new();
    out.u8(VERSION);
    out.u64(shell.revision());
    out.u16(screen.cols as u16);
    out.u16(screen.rows as u16);
    out.u32(total as u32);
    out.u16(cursor_row as u16);
    out.u16(cursor_col as u16);
    out.u8((screen.cursor_visible as u8)
        | ((screen.alt_screen_active as u8) << 1)
        | ((shell.can_type() as u8) << 2)
        | ((shell.is_running() as u8) << 3)
        | ((matches!(shell.phase(), ShellPhase::Ended(_)) as u8) << 4));
    out.str16(&shell.title());
    out.str16(&shell.status_text());
    out.u32(start as u32);
    out.u32((end - start) as u32);
    for index in start..end {
        write_vt_line(&mut out, &screen.line(index));
    }
    out.bytes
}
