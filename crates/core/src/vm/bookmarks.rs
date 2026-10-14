// The reader's marks on a transcript: item ids per `host:session`, in the order they were set. The web's
// `workerdeck.bookmarks.v1` map (`packages/react/src/lib/bookmark-store.ts`) and the iOS kit's `Bookmarks`: an emptied
// session leaves the map, and an unreadable store starts empty rather than failing.
use crate::rest::Entries;
use crate::vm::watermarks::watermark_key;
use serde_json::Value;

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
            if let Value::Array(ids) = value {
                marks.set(key, ids.into_iter().filter_map(|id| id.as_str().map(str::to_owned)).collect());
            }
        }
        Self { marks }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.marks).unwrap_or_default()
    }

    pub fn for_session(&self, host_id: &str, session_id: &str) -> &[String] {
        self.marks.get(&watermark_key(host_id, session_id)).map_or(&[], Vec::as_slice)
    }

    pub fn contains(&self, host_id: &str, session_id: &str, item_id: &str) -> bool {
        self.for_session(host_id, session_id).iter().any(|id| id == item_id)
    }

    // Returns whether the item is bookmarked now.
    pub fn toggle(&mut self, host_id: &str, session_id: &str, item_id: &str) -> bool {
        let key = watermark_key(host_id, session_id);
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
        assert!(marks.toggle("h", "s", "a"));
        assert!(marks.toggle("h", "s", "b"));
        assert_eq!(marks.for_session("h", "s"), ["a", "b"]);
        assert!(!marks.toggle("h", "s", "a"));
        assert_eq!(marks.to_json(), r#"{"h:s":["b"]}"#);
        assert!(!marks.toggle("h", "s", "b"));
        assert_eq!(marks.to_json(), "{}");
    }

    #[test]
    fn a_damaged_store_reads_what_it_can() {
        let marks = Bookmarks::from_json(Some(r#"{"h:s":["a",1,"b"],"h:t":"x","g:u":[]}"#));
        assert_eq!(marks.for_session("h", "s"), ["a", "b"]);
        assert!(marks.for_session("h", "t").is_empty());
        assert!(marks.contains("h", "s", "b"));
        assert_eq!(Bookmarks::from_json(Some("[1]")), Bookmarks::default());
        assert_eq!(Bookmarks::from_json(Some("not json")), Bookmarks::default());
    }

    #[test]
    fn removing_a_host_forgets_only_its_sessions() {
        let mut marks = Bookmarks::from_json(Some(r#"{"h:s":["a"],"hh:s":["b"]}"#));
        assert!(marks.remove_host("h"));
        assert_eq!(marks.to_json(), r#"{"hh:s":["b"]}"#);
        assert!(!marks.remove_host("h"));
    }
}
