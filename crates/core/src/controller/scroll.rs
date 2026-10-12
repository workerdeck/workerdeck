#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TranscriptScrollGeometry {
    pub content_height: f64,
    pub frame_height: f64,
    pub inset_top: f64,
    pub inset_bottom: f64,
}

impl TranscriptScrollGeometry {
    pub fn top(&self) -> f64 {
        -self.inset_top
    }

    pub fn bottom(&self) -> f64 {
        self.top().max(self.content_height + self.inset_bottom - self.frame_height)
    }

    pub fn clamped(&self, offset: f64) -> f64 {
        offset.max(self.top()).min(self.bottom())
    }

    pub fn pins_after_jump(&self, offset: f64, threshold: f64, complete: bool) -> bool {
        complete && offset >= self.bottom() - threshold
    }
}
