// Which transcript rows a native list holds lines for. The list reports the rows on screen; lines are read for
// them plus a margin and re-read only once the screen leaves that range. A screen showing the last row follows
// the tail, which is where a session opens.
use std::ops::Range;

pub const WINDOW: usize = 80;
pub const MARGIN: usize = 40;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Viewport {
    wanted: Option<Range<usize>>,
    loaded: Range<usize>,
}

impl Viewport {
    // `first..=last` are on screen out of `count` rows; answers the rows to read when the held ones no longer do.
    pub fn show(&mut self, first: usize, last: usize, count: usize) -> Option<Range<usize>> {
        let tail = last + 1 >= count;
        let held = self.loaded.contains(&first) && self.loaded.contains(&last);
        if held && (!tail || self.loaded.end >= count) {
            return None;
        }
        self.wanted = (!tail).then(|| first.saturating_sub(MARGIN)..last + MARGIN + 1);
        Some(self.window(count))
    }

    // The rows to read now: after the transcript changed, or once `show` moved the window.
    pub fn window(&mut self, count: usize) -> Range<usize> {
        let range = self.wanted.clone().unwrap_or(count.saturating_sub(WINDOW)..count);
        let start = range.start.min(count);
        self.loaded = start..range.end.clamp(start, count);
        self.loaded.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_opens_on_its_tail() {
        let mut viewport = Viewport::default();
        assert_eq!(viewport.window(200), 120..200);
        assert_eq!(viewport.window(30), 0..30);
    }

    #[test]
    fn scrolling_inside_the_held_rows_reads_nothing() {
        let mut viewport = Viewport::default();
        viewport.window(200);
        assert_eq!(viewport.show(180, 199, 200), None);
        assert_eq!(viewport.show(130, 150, 200), None);
    }

    #[test]
    fn leaving_the_held_rows_reads_them_with_a_margin() {
        let mut viewport = Viewport::default();
        viewport.window(200);
        assert_eq!(viewport.show(100, 119, 200), Some(60..160));
        assert_eq!(viewport.window(210), 60..160, "a window off the tail stays put as rows arrive");
    }

    #[test]
    fn back_at_the_tail_the_window_follows_new_rows() {
        let mut viewport = Viewport::default();
        viewport.window(200);
        viewport.show(10, 20, 200);
        assert_eq!(viewport.show(190, 199, 200), Some(120..200));
        assert_eq!(viewport.window(205), 125..205);
    }

    #[test]
    fn a_tail_that_grew_past_the_held_rows_is_read_again() {
        let mut viewport = Viewport::default();
        viewport.window(200);
        assert_eq!(viewport.show(195, 200, 201), Some(121..201));
    }
}
