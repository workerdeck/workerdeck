use wd_native::vm::agent_avatar;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AvatarFetch {
    pub key: String,
    pub still_path: String,
    pub busy_path: String,
}

impl From<agent_avatar::AvatarFetch> for AvatarFetch {
    fn from(fetch: agent_avatar::AvatarFetch) -> Self {
        AvatarFetch { key: fetch.key, still_path: fetch.still_path, busy_path: fetch.busy_path }
    }
}

// The busy strip's `x-frame-durations` header: one entry per frame, frames laid out left to right.
#[uniffi::export]
pub fn avatar_frame_durations(header: Option<String>) -> Vec<f64> {
    agent_avatar::frame_durations(header.as_deref())
}

// None when the strip is not worth slicing; the still is drawn instead.
#[uniffi::export]
pub fn avatar_strip_width(frames: u32, image_width: u32) -> Option<u32> {
    agent_avatar::strip_frame_width(frames as usize, image_width)
}

#[uniffi::export]
pub fn avatar_busy_frame(durations: Vec<f64>, at_ms: f64) -> u32 {
    agent_avatar::busy_frame(&durations, at_ms) as u32
}
