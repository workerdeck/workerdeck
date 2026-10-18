// Staged composer files, from picked to sent. A file exists before its upload lands, so its chip shows the moment
// it is picked; uploads start at once, so a send only names ids that already landed.
use crate::rest::calls::{self, HttpCall};
use crate::rest::error::Answer;
use crate::rest::files::UploadedAttachment;

pub const ACCEPTED_IMAGE_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
pub const MAX_IMAGE_EDGE: u32 = 1568;
pub const JPEG_QUALITY: f32 = 0.8;
pub const THUMBNAIL_EDGE: u32 = 120;
pub const NOT_CONNECTED: &str = "Not connected";

const TEXT_TYPES: [&str; 10] = [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/typescript",
    "application/x-sh",
    "application/x-httpd-php",
    "application/sql",
];

fn essence(media_type: &str) -> String {
    media_type.split(';').next().unwrap_or_default().trim().to_lowercase()
}

// The capability kind a media type lands as; None when unknown here, and then the gateway decides.
pub fn attachment_kind(media_type: &str) -> Option<&'static str> {
    let essence = essence(media_type);
    if essence.starts_with("image/") {
        Some("image")
    } else if essence == "application/pdf" {
        Some("pdf")
    } else if essence.starts_with("text/") || TEXT_TYPES.contains(&essence.as_str()) {
        Some("text")
    } else {
        None
    }
}

// Why a file of this type cannot be staged on a session taking `kinds`, or None when it can.
pub fn refusal(media_type: &str, kinds: &[String]) -> Option<String> {
    let kind = attachment_kind(media_type)?;
    (!kinds.iter().any(|k| k == kind)).then(|| format!("This session's engine does not take {kind} attachments."))
}

pub fn unreadable(name: &str) -> String {
    format!("Could not read {name}.")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImagePlan {
    // The bytes as picked: a screenshot re-encoded to JPEG reads measurably worse.
    Keep,
    Jpeg { name: String, width: u32, height: u32 },
}

fn renamed(name: &str, ext: &str) -> String {
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    format!("{}.{ext}", if stem.is_empty() { "photo" } else { stem })
}

// iPhone photos are usually HEIC, which no model takes: anything else is scaled to what a vision model uses and sent
// as JPEG. `media_type` is None for a picture with no bytes of its own (a camera shot).
pub fn image_plan(name: &str, media_type: Option<&str>, width: u32, height: u32) -> ImagePlan {
    let longest = width.max(height);
    let fits = longest <= MAX_IMAGE_EDGE;
    if fits && media_type.is_some_and(|t| ACCEPTED_IMAGE_TYPES.contains(&essence(t).as_str())) {
        return ImagePlan::Keep;
    }
    let (width, height) = if fits {
        (width, height)
    } else {
        let scale = f64::from(MAX_IMAGE_EDGE) / f64::from(longest);
        ((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
    };
    ImagePlan::Jpeg { name: renamed(name, "jpg"), width: width.max(1), height: height.max(1) }
}

pub fn thumbnail_size(width: u32, height: u32) -> (u32, u32) {
    let scale = f64::from(THUMBNAIL_EDGE) / f64::from(width.max(height).max(1));
    ((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
}

// What a chip without a thumbnail says: the file's extension, or FILE.
pub fn extension_label(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_uppercase(),
        _ => "FILE".to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentState {
    Uploading,
    Ready { remote_id: String },
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub id: u64,
    pub name: String,
    pub media_type: String,
    pub state: AttachmentState,
    announce: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub id: u64,
    pub call: HttpCall,
}

#[derive(Debug, Clone, Default)]
pub struct Attachments {
    items: Vec<Attachment>,
    next: u64,
    error: Option<String>,
}

impl Attachments {
    pub fn items(&self) -> &[Attachment] {
        &self.items
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn is_uploading(&self) -> bool {
        self.items.iter().any(|a| a.state == AttachmentState::Uploading)
    }

    // A failed upload blocks the send rather than silently dropping the file from it.
    pub fn has_failure(&self) -> bool {
        self.items.iter().any(|a| matches!(a.state, AttachmentState::Failed { .. }))
    }

    pub fn ready_ids(&self) -> Vec<String> {
        self.items
            .iter()
            .filter_map(|a| match &a.state {
                AttachmentState::Ready { remote_id } => Some(remote_id.clone()),
                _ => None,
            })
            .collect()
    }

    // The failure to announce once, the first upload's only: a retry shows on its chip.
    pub fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    pub fn announce(&mut self, message: String) {
        self.error = Some(message);
    }

    // None without a session to upload into: the file is staged as failed, so the send stays blocked.
    pub fn add(&mut self, session_id: Option<&str>, name: &str, media_type: &str) -> Option<Upload> {
        self.next += 1;
        let id = self.next;
        self.items.push(Attachment {
            id,
            name: name.to_owned(),
            media_type: media_type.to_owned(),
            state: AttachmentState::Uploading,
            announce: true,
        });
        self.start(id, session_id)
    }

    pub fn retry(&mut self, id: u64, session_id: Option<&str>) -> Option<Upload> {
        let item = self.items.iter_mut().find(|a| a.id == id && matches!(a.state, AttachmentState::Failed { .. }))?;
        item.state = AttachmentState::Uploading;
        item.announce = false;
        self.start(id, session_id)
    }

    fn start(&mut self, id: u64, session_id: Option<&str>) -> Option<Upload> {
        let Some(session_id) = session_id else {
            self.settle(id, Err(NOT_CONNECTED.to_owned()));
            return None;
        };
        let name = &self.items.iter().find(|a| a.id == id)?.name;
        Some(Upload { id, call: calls::upload_attachment(session_id, name) })
    }

    // Answers whether the item was still staged.
    pub fn uploaded(&mut self, id: u64, answer: Answer<'_>) -> bool {
        self.settle(id, answer.read::<UploadedAttachment>().map(|a| a.attachment.id).map_err(|e| e.message))
    }

    fn settle(&mut self, id: u64, outcome: Result<String, String>) -> bool {
        let Some(item) = self.items.iter_mut().find(|a| a.id == id) else {
            return false;
        };
        item.state = match outcome {
            Ok(remote_id) => AttachmentState::Ready { remote_id },
            Err(message) => {
                if item.announce {
                    self.error = Some(message.clone());
                }
                AttachmentState::Failed { message }
            }
        };
        true
    }

    pub fn remove(&mut self, id: u64) {
        self.items.retain(|a| a.id != id);
    }

    // Every staged file goes up again into `session_id` under a fresh id, so an answer still in flight for the old
    // session settles nothing. Answers each new upload with the id it replaces.
    pub fn retarget(&mut self, session_id: &str) -> Vec<(u64, Upload)> {
        let old: Vec<u64> = self.items.iter().map(|a| a.id).collect();
        let mut moved = Vec::new();
        for id in old {
            self.next += 1;
            let next = self.next;
            let Some(item) = self.items.iter_mut().find(|a| a.id == id) else { continue };
            item.id = next;
            item.state = AttachmentState::Uploading;
            item.announce = true;
            if let Some(upload) = self.start(next, Some(session_id)) {
                moved.push((id, upload));
            }
        }
        moved
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&str> = Some("application/json");

    #[test]
    fn kinds_follow_the_media_type() {
        assert_eq!(attachment_kind("image/HEIC"), Some("image"));
        assert_eq!(attachment_kind("application/pdf"), Some("pdf"));
        assert_eq!(attachment_kind("text/plain; charset=utf-8"), Some("text"));
        assert_eq!(attachment_kind("application/x-yaml"), Some("text"));
        assert_eq!(attachment_kind("application/zip"), None);
        let kinds = vec!["image".to_owned()];
        assert_eq!(refusal("application/pdf", &kinds).as_deref(), Some("This session's engine does not take pdf attachments."));
        assert_eq!(refusal("image/png", &kinds), None);
        assert_eq!(refusal("application/zip", &kinds), None);
    }

    #[test]
    fn images_keep_their_bytes_only_when_the_format_and_size_suit() {
        assert_eq!(image_plan("shot.png", Some("image/png"), 1200, 800), ImagePlan::Keep);
        assert_eq!(
            image_plan("big.png", Some("image/png"), 3136, 1000),
            ImagePlan::Jpeg { name: "big.jpg".into(), width: 1568, height: 500 }
        );
        assert_eq!(
            image_plan("IMG_1.HEIC", Some("image/heic"), 100, 50),
            ImagePlan::Jpeg { name: "IMG_1.jpg".into(), width: 100, height: 50 }
        );
        assert_eq!(image_plan("photo.jpg", None, 10, 10), ImagePlan::Jpeg { name: "photo.jpg".into(), width: 10, height: 10 });
        assert_eq!(image_plan(".hidden", None, 10, 10), ImagePlan::Jpeg { name: ".hidden.jpg".into(), width: 10, height: 10 });
        assert_eq!(thumbnail_size(240, 120), (120, 60));
        assert_eq!(extension_label("notes.md"), "MD");
        assert_eq!(extension_label("Makefile"), "FILE");
    }

    #[test]
    fn an_upload_moves_from_uploading_to_ready_and_a_failure_is_announced_once() {
        let mut staged = Attachments::default();
        let first = staged.add(Some("s1"), "a b.png", "image/png").unwrap();
        assert_eq!(first.call.path, "/sessions/s1/attachments?name=a%20b.png");
        let second = staged.add(Some("s1"), "c.pdf", "application/pdf").unwrap();
        assert!(staged.is_uploading());
        assert!(staged.uploaded(first.id, Answer::new(200, JSON, r#"{"attachment":{"id":"att-1"}}"#)));
        staged.uploaded(second.id, Answer::new(413, JSON, r#"{"error":"too large"}"#));
        assert!(!staged.is_uploading());
        assert!(staged.has_failure());
        assert_eq!(staged.take_error().as_deref(), Some("too large"));
        assert_eq!(staged.ready_ids(), vec!["att-1"]);
        let retried = staged.retry(second.id, Some("s1")).unwrap();
        assert_eq!(staged.retry(first.id, Some("s1")), None);
        staged.uploaded(retried.id, Answer::new(0, None, ""));
        assert_eq!(staged.take_error(), None);
        staged.remove(second.id);
        assert!(!staged.has_failure());
        assert!(!staged.uploaded(second.id, Answer::new(200, JSON, r#"{"attachment":{"id":"x"}}"#)));
    }

    #[test]
    fn a_retarget_uploads_every_file_again_under_a_new_id() {
        let mut staged = Attachments::default();
        let first = staged.add(Some("s1"), "a.png", "image/png").unwrap();
        let second = staged.add(Some("s1"), "b.pdf", "application/pdf").unwrap();
        staged.uploaded(first.id, Answer::new(200, JSON, r#"{"attachment":{"id":"att-1"}}"#));
        let moved = staged.retarget("s2");
        assert_eq!(moved.iter().map(|(old, _)| *old).collect::<Vec<_>>(), vec![first.id, second.id]);
        assert!(moved.iter().all(|(old, upload)| upload.id != *old && upload.call.path.starts_with("/sessions/s2/attachments")));
        assert!(staged.ready_ids().is_empty());
        assert!(!staged.uploaded(second.id, Answer::new(200, JSON, r#"{"attachment":{"id":"stale"}}"#)));
        staged.uploaded(moved[0].1.id, Answer::new(200, JSON, r#"{"attachment":{"id":"att-2"}}"#));
        staged.uploaded(moved[1].1.id, Answer::new(200, JSON, r#"{"attachment":{"id":"att-3"}}"#));
        assert_eq!(staged.ready_ids(), vec!["att-2", "att-3"]);
    }

    #[test]
    fn without_a_session_the_file_fails_at_once() {
        let mut staged = Attachments::default();
        assert_eq!(staged.add(None, "a.png", "image/png"), None);
        assert_eq!(staged.items()[0].state, AttachmentState::Failed { message: NOT_CONNECTED.into() });
        assert_eq!(staged.take_error().as_deref(), Some(NOT_CONNECTED));
    }
}
