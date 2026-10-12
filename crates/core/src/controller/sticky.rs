use crate::book::HeightBook;
use crate::rows::TerminalRows;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pin {
    pub row: usize,
    pub offset: f64,
}

pub fn resolve(
    prompt_rows: &[usize],
    rows: &TerminalRows,
    book: &HeightBook,
    top: f64,
    line: f64,
    strip_height: Option<f64>,
) -> Option<Pin> {
    let strip = strip_height.unwrap_or(line);
    let content_top = |row: usize| book.offset(row) + if rows.gap_before(row) { line } else { 0.0 };
    let index = last_prompt(prompt_rows, top, content_top)?;
    if content_top(index) >= top {
        return None;
    }
    let Some(&next) = prompt_rows.iter().find(|&&row| row > index) else {
        return Some(Pin { row: index, offset: 0.0 });
    };
    let distance = content_top(next) - top;
    if distance >= strip {
        return Some(Pin { row: index, offset: 0.0 });
    }
    Some(Pin { row: index, offset: (-strip).max(distance - strip) })
}

fn last_prompt(prompt_rows: &[usize], offset: f64, content_top: impl Fn(usize) -> f64) -> Option<usize> {
    let at = prompt_rows.partition_point(|&row| content_top(row) <= offset);
    at.checked_sub(1).map(|i| prompt_rows[i])
}
