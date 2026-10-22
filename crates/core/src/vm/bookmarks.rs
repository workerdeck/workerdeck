// The reader's marks on a transcript: item ids per `host:session#n`, in the order they were set. A conversation's
// item ids restart with its log, so marks are kept per conversation. An emptied conversation leaves the map, and an
// unreadable store (or a mark from before conversations were numbered) starts empty rather than failing.
use crate::rest::Entries;
use crate::vm::conversations::SessionAddress;
use crate::vm::watermarks::watermark_key;
use serde_json::Value;

fn key(host_id: &str, session_id: &str, conversation: i64) -> String {
    watermark_key(host_id, &SessionAddress { id: session_id.to_owned(), conversation: Some(conversation) }.key())
}

fn numbered(key: &str) -> bool {
    key.rsplit_once('#').is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bookmarks {
    marks: Entries<Vec<String>>,
}

impl Bookmarks {
    pub fn from_json(json: Option<&str>) -> Self {
        let Some(Value::Object(map)) = json.and_then(|json| serde_json::from_str::<Value>(json).ok()) else {
            return Self::default();
        };
        let mut marks = Entries::new();
        for (key, value) in map {
            if let Value::Array(ids) = value
                && numbered(&key)
            {
                marks.set(key, ids.into_iter().filter_map(|id| id.as_str().map(str::to_owned)).collect());
            }
        }
        Self { marks }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.marks).unwrap_or_default()
    }

    pub fn for_session(&self, host_id: &str, session_id: &str, conversation: i64) -> &[String] {
        self.marks.get(&key(host_id, session_id, conversation)).map_or(&[], Vec::as_slice)
    }

    pub fn contains(&self, host_id: &str, session_id: &str, conversation: i64, item_id: &str) -> bool {
        self.for_session(host_id, session_id, conversation).iter().any(|id| id == item_id)
    }

    // Returns whether the item is bookmarked now.
    pub fn toggle(&mut self, host_id: &str, session_id: &str, conversation: i64, item_id: &str) -> bool {
        let key = key(host_id, session_id, conversation);
        let mut ids = self.marks.get(&key).cloned().unwrap_or_default();
        let added = if let Some(at) = ids.iter().position(|id| id == item_id) {
            ids.remove(at);
            false
        } else {
            ids.push(item_id.to_owned());
            true
        };
        if ids.is_empty() {
            self.marks.0.retain(|(k, _)| *k != key);
        } else {
            self.marks.set(key, ids);
        }
        added
    }

    // Forgetting a gateway forgets its marks, as it does its read watermarks.
    pub fn remove_host(&mut self, host_id: &str) -> bool {
        let prefix = format!("{host_id}:");
        let before = self.marks.len();
        self.marks.0.retain(|(key, _)| !key.starts_with(&prefix));
        self.marks.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggling_keeps_insertion_order_and_drops_an_emptied_session() {
        let mut marks = Bookmarks::default();
        assert!(marks.toggle("h", "s", 1, "a"));
        assert!(marks.toggle("h", "s", 1, "b"));
        assert_eq!(marks.for_session("h", "s", 1), ["a", "b"]);
        assert!(!marks.toggle("h", "s", 1, "a"));
        assert_eq!(marks.to_json(), r#"{"h:s#1":["b"]}"#);
        assert!(!marks.toggle("h", "s", 1, "b"));
        assert_eq!(marks.to_json(), "{}");
    }

    #[test]
    fn a_damaged_store_reads_what_it_can() {
        let marks = Bookmarks::from_json(Some(r#"{"h:s#1":["a",1,"b"],"h:t":"x","g:u":[]}"#));
        assert_eq!(marks.for_session("h", "s", 1), ["a", "b"]);
        assert!(marks.for_session("h", "t", 1).is_empty());
        assert!(marks.contains("h", "s", 1, "b"));
        assert_eq!(Bookmarks::from_json(Some("[1]")), Bookmarks::default());
        assert_eq!(Bookmarks::from_json(Some("not json")), Bookmarks::default());
    }

    #[test]
    fn a_mark_from_before_conversations_were_numbered_is_dropped() {
        let marks = Bookmarks::from_json(Some(r#"{"h:s":["a"],"h:s#":["b"],"h:s#2":["c"]}"#));
        assert_eq!(marks.to_json(), r#"{"h:s#2":["c"]}"#);
        assert!(marks.for_session("h", "s", 1).is_empty());
    }

    #[test]
    fn removing_a_host_forgets_only_its_sessions() {
        let mut marks = Bookmarks::from_json(Some(r#"{"h:s#1":["a"],"hh:s#2":["b"]}"#));
        assert!(marks.remove_host("h"));
        assert_eq!(marks.to_json(), r#"{"hh:s#2":["b"]}"#);
        assert!(!marks.remove_host("h"));
    }
}
