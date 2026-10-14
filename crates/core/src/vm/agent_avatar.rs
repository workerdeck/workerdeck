use crate::rest::{AgentRef, encode_component};
use std::collections::{HashMap, HashSet};

pub const RETRY_AFTER_MS: f64 = 60_000.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarFetch {
    pub key: String,
    pub host_id: String,
    pub still_path: String,
    pub busy_path: String,
}

pub fn avatar_path(agent_id: &str, busy: bool) -> String {
    format!("/agents/{}/{}", encode_component(agent_id), if busy { "avatar-busy.png" } else { "avatar.png" })
}

// `AgentRef.avatar` is versioned by the avatar's seed, so a new seed is a new key and each picture is fetched once.
pub fn avatar_key(host_id: &str, agent: &AgentRef) -> Option<String> {
    agent.avatar.as_ref().map(|avatar| format!("{host_id}|{avatar}"))
}

pub fn frame_durations(header: Option<&str>) -> Vec<f64> {
    header
        .unwrap_or_default()
        .split(',')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .collect()
}

pub fn strip_frame_width(frames: usize, image_width: u32) -> Option<u32> {
    if frames < 2 {
        return None;
    }
    let width = image_width / frames as u32;
    (width > 0).then_some(width)
}

pub fn busy_frame(durations: &[f64], at_ms: f64) -> usize {
    let period: f64 = durations.iter().sum();
    if period <= 0.0 {
        return 0;
    }
    let mut at = at_ms.rem_euclid(period);
    for (index, duration) in durations.iter().enumerate() {
        if at < *duration {
            return index;
        }
        at -= duration;
    }
    durations.len() - 1
}

#[derive(Debug, Default)]
pub struct AvatarLoads {
    loaded: HashSet<String>,
    in_flight: HashSet<String>,
    failed_at: HashMap<String, f64>,
}

impl AvatarLoads {
    pub fn begin(&mut self, host_id: &str, agent: &AgentRef, now_ms: f64) -> Option<AvatarFetch> {
        let key = avatar_key(host_id, agent)?;
        if self.loaded.contains(&key) || self.in_flight.contains(&key) {
            return None;
        }
        if self.failed_at.get(&key).is_some_and(|failed| now_ms - failed < RETRY_AFTER_MS) {
            return None;
        }
        self.in_flight.insert(key.clone());
        Some(AvatarFetch { key, host_id: host_id.to_owned(), still_path: avatar_path(&agent.id, false), busy_path: avatar_path(&agent.id, true) })
    }

    pub fn settle(&mut self, key: &str, loaded: bool, now_ms: f64) {
        self.in_flight.remove(key);
        if loaded {
            self.failed_at.remove(key);
            self.loaded.insert(key.to_owned());
        } else {
            self.failed_at.insert(key.to_owned(), now_ms);
        }
    }

    pub fn forget_host(&mut self, host_id: &str) {
        let prefix = format!("{host_id}|");
        self.loaded.retain(|key| !key.starts_with(&prefix));
        self.in_flight.retain(|key| !key.starts_with(&prefix));
        self.failed_at.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, avatar: Option<&str>) -> AgentRef {
        AgentRef { id: id.to_owned(), name: "WD-Lead".to_owned(), avatar: avatar.map(str::to_owned), ..AgentRef::default() }
    }

    #[test]
    fn paths_encode_the_agent_id() {
        assert_eq!(avatar_path("a b", false), "/agents/a%20b/avatar.png");
        assert_eq!(avatar_path("wd-lead", true), "/agents/wd-lead/avatar-busy.png");
    }

    #[test]
    fn durations_drop_what_is_not_a_positive_number() {
        assert_eq!(frame_durations(Some("120, 80,x,0,-1,inf")), vec![120.0, 80.0]);
        assert!(frame_durations(None).is_empty());
        assert!(frame_durations(Some("")).is_empty());
    }

    #[test]
    fn a_strip_needs_two_frames_and_a_pixel_each() {
        assert_eq!(strip_frame_width(4, 128), Some(32));
        assert_eq!(strip_frame_width(1, 128), None);
        assert_eq!(strip_frame_width(4, 3), None);
    }

    #[test]
    fn busy_frame_walks_the_period() {
        let durations = [100.0, 50.0, 50.0];
        assert_eq!(busy_frame(&durations, 0.0), 0);
        assert_eq!(busy_frame(&durations, 99.0), 0);
        assert_eq!(busy_frame(&durations, 120.0), 1);
        assert_eq!(busy_frame(&durations, 170.0), 2);
        assert_eq!(busy_frame(&durations, 210.0), 0);
        assert_eq!(busy_frame(&[], 210.0), 0);
    }

    #[test]
    fn loads_fetch_once_and_retry_a_failure_after_a_minute() {
        let mut loads = AvatarLoads::default();
        assert_eq!(loads.begin("h", &agent("a", None), 0.0), None);
        let fetch = loads.begin("h", &agent("a", Some("monkey:3")), 0.0).unwrap();
        assert_eq!(fetch.key, "h|monkey:3");
        assert_eq!(loads.begin("h", &agent("a", Some("monkey:3")), 1.0), None);
        loads.settle(&fetch.key, false, 1_000.0);
        assert_eq!(loads.begin("h", &agent("a", Some("monkey:3")), 30_000.0), None);
        assert!(loads.begin("h", &agent("a", Some("monkey:3")), 61_000.0).is_some());
        loads.settle(&fetch.key, true, 62_000.0);
        assert_eq!(loads.begin("h", &agent("a", Some("monkey:3")), 200_000.0), None);
        assert!(loads.begin("h", &agent("a", Some("monkey:4")), 200_000.0).is_some());
        loads.forget_host("h");
        assert!(loads.begin("h", &agent("a", Some("monkey:3")), 200_000.0).is_some());
    }
}
