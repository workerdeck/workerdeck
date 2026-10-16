use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionFiles {
    pub files: Vec<SessionFile>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UploadedAttachment {
    pub attachment: AttachmentId,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AttachmentId {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HostRoot {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRoots {
    pub roots: Vec<HostRoot>,
    pub can_write: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostEntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

// A newer gateway's new category reads as `Other` rather than blanking the listing.
impl<'de> Deserialize<'de> for HostEntryKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "file" => HostEntryKind::File,
            "dir" => HostEntryKind::Dir,
            "symlink" => HostEntryKind::Symlink,
            _ => HostEntryKind::Other,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: HostEntryKind,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<f64>,
}

// `path` is the canonical directory listed, which differs from the one asked for across a symlink.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HostListing {
    pub path: String,
    pub entries: Vec<HostEntry>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HostFileMatch {
    pub path: String,
    pub relative: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HostMatches {
    pub base: String,
    pub matches: Vec<HostFileMatch>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRead {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub bytes: u64,
    pub hash: String,
    pub modified_at: f64,
}

impl HostRead {
    pub fn text(&self) -> Option<&str> {
        (self.encoding == "utf8").then_some(self.content.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWritten {
    pub path: String,
    pub bytes: u64,
    pub hash: String,
    pub modified_at: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_entry_type_reads_as_other() {
        let listing: HostListing = serde_json::from_str(
            r#"{"path":"/r","entries":[{"name":"a","path":"/r/a","type":"dir"},{"name":"p","path":"/r/p","type":"fifo","bytes":3}]}"#,
        )
        .unwrap();
        assert_eq!(listing.entries[0].kind, HostEntryKind::Dir);
        assert_eq!(listing.entries[1].kind, HostEntryKind::Other);
        assert_eq!(listing.entries[1].bytes, Some(3));
        assert!(!listing.truncated);
    }

    #[test]
    fn a_read_is_text_only_in_utf8() {
        let read = |encoding: &str| HostRead {
            path: "/a".into(),
            content: "aGk=".into(),
            encoding: encoding.into(),
            bytes: 2,
            hash: "h".into(),
            modified_at: 1.0,
        };
        assert_eq!(read("utf8").text(), Some("aGk="));
        assert_eq!(read("base64").text(), None);
    }
}
