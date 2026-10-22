use crate::rest::Entries;
use serde::{Deserialize, Serialize};

const MAX_AGE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const TOUCH_MS: f64 = 60_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub item_count: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<f64>,
    pub activity: f64,
    pub prose: f64,
    pub seen_at: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    #[serde(default)]
    pub item_count: Option<f64>,
    #[serde(default)]
    pub conversation: Option<f64>,
    #[serde(default)]
    pub activity: Option<f64>,
    #[serde(default)]
    pub prose: Option<f64>,
}

pub fn watermark_key(host_id: &str, session_id: &str) -> String {
    format!("{host_id}:{session_id}")
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Watermarks {
    marks: Entries<Watermark>,
}

impl Watermarks {
    pub fn new(stored: Entries<Watermark>) -> Self {
        Watermarks { marks: stored }
    }

    // A stored mark of another shape is dropped: its session reads as caught up until the next visit marks it.
    pub fn from_json(json: Option<&str>) -> Self {
        let stored: Entries<serde_json::Value> = json.and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        let mut marks = Entries::new();
        for (key, value) in stored.0 {
            if let Ok(mark) = serde_json::from_value(value) {
                marks.set(key, mark);
            }
        }
        Watermarks { marks }
    }

    pub fn get(&self, host_id: &str, session_id: &str) -> Option<&Watermark> {
        self.marks.get(&watermark_key(host_id, session_id))
    }

    pub fn all(&self) -> &Entries<Watermark> {
        &self.marks
    }

    pub fn mark(&mut self, host_id: &str, session_id: &str, seen: &Seen, now: f64) -> bool {
        let id = watermark_key(host_id, session_id);
        let previous = self.marks.get(&id);
        let held = |pick: fn(&Watermark) -> f64| previous.map(pick).unwrap_or(0.0);
        let (item_count, conversation) = marked_items(previous, seen);
        let next = Watermark {
            item_count,
            conversation,
            activity: held(|m| m.activity).max(seen.activity.unwrap_or(0.0)),
            prose: held(|m| m.prose).max(seen.prose.unwrap_or(0.0)),
            seen_at: now,
        };
        if let Some(previous) = previous
            && previous.item_count == next.item_count
            && previous.conversation == next.conversation
            && previous.activity == next.activity
            && previous.prose == next.prose
            && next.seen_at - previous.seen_at < TOUCH_MS
        {
            return false;
        }
        self.marks.set(id, next);
        let cutoff = now - MAX_AGE_MS;
        self.marks.0.retain(|(_, mark)| mark.seen_at >= cutoff);
        true
    }

    pub fn forget(&mut self, host_id: &str, session_id: &str) -> bool {
        let id = watermark_key(host_id, session_id);
        let before = self.marks.len();
        self.marks.0.retain(|(key, _)| *key != id);
        self.marks.len() != before
    }
}

impl Watermarks {
    // A gateway unpaired takes its marks along: a later pairing mints a new host id and never reads them.
    pub fn forget_host(&mut self, host_id: &str) -> bool {
        let prefix = watermark_key(host_id, "");
        let before = self.marks.len();
        self.marks.0.retain(|(key, _)| !key.starts_with(&prefix));
        self.marks.len() != before
    }
}

// A newer conversation's reading replaces the item count, an older one's (a late mark from a view that has not seen the
// cut yet) never raises it, and only a reading of the same conversation takes the max.
fn marked_items(previous: Option<&Watermark>, seen: &Seen) -> (f64, Option<f64>) {
    let held = (previous.map_or(0.0, |m| m.item_count), previous.and_then(|m| m.conversation));
    let Some(count) = seen.item_count else { return held };
    if previous.is_none() {
        return (count, seen.conversation);
    }
    if seen.conversation == held.1 {
        return (held.0.max(count), held.1);
    }
    match (seen.conversation, held.1) {
        (Some(c), None) => (count, Some(c)),
        (Some(c), Some(h)) if c > h => (count, Some(c)),
        _ => held,
    }
}

// A mark taken in another conversation is no position in this one, so the recap covers it from the top.
pub fn catch_up_items(item_count: f64, mark_conversation: Option<f64>, conversation: Option<f64>) -> f64 {
    match (mark_conversation, conversation) {
        (Some(a), Some(b)) if a != b => 0.0,
        _ => item_count,
    }
}

pub fn unseen_count(mark: Option<&Watermark>, prose_count: Option<f64>) -> f64 {
    match (mark, prose_count) {
        (Some(mark), Some(count)) => (count - mark.prose).max(0.0),
        _ => 0.0,
    }
}
