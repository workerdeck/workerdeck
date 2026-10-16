use crate::rest::calls::{self, HostWrite, HttpCall};
use crate::rest::error::Answer;
use crate::rest::files::{HostEntryKind, HostListing, HostRead, HostRoot, HostRoots, HostWritten};
use std::collections::{HashMap, HashSet};

// A gateway started without `--fs-root` 404s `/fs/roots`: that is an answer (`Unavailable`), not a failure. Every
// filesystem refusal is a uniform 404, so a 404 on the session's own directory reads as `OutsideRoots`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    Loading,
    Unavailable,
    OutsideRoots,
    Ready { can_write: bool },
    Failed(String),
}

// One window onto the host filesystem: rooted at a session's working directory, or (no `cwd`) the folder picker,
// which shows the roots and keeps only what can be entered. Listings are cached under the canonical path the
// gateway answered with and under the path asked for, which differ across a symlink.
#[derive(Debug)]
pub struct HostBrowser {
    cwd: Option<String>,
    availability: Availability,
    roots: Vec<HostRoot>,
    writable: bool,
    listings: HashMap<String, HostListing>,
    loading: HashSet<String>,
    error: Option<String>,
}

impl HostBrowser {
    pub fn session(cwd: &str) -> Self {
        Self::new(Some(cwd.to_owned()))
    }

    pub fn folders() -> Self {
        Self::new(None)
    }

    fn new(cwd: Option<String>) -> Self {
        Self {
            cwd,
            availability: Availability::Loading,
            roots: Vec::new(),
            writable: false,
            listings: HashMap::new(),
            loading: HashSet::new(),
            error: None,
        }
    }

    pub fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }

    pub fn availability(&self) -> &Availability {
        &self.availability
    }

    pub fn roots(&self) -> &[HostRoot] {
        &self.roots
    }

    pub fn can_write(&self) -> bool {
        matches!(self.availability, Availability::Ready { can_write: true })
    }

    pub fn listing(&self, path: &str) -> Option<&HostListing> {
        self.listings.get(path)
    }

    pub fn is_loading(&self, path: &str) -> bool {
        self.loading.contains(path)
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn clear_error(&mut self) {
        self.error = None;
    }

    // The first question: does this gateway serve files at all. Nothing to ask once ready.
    pub fn load(&mut self) -> Option<HttpCall> {
        if matches!(self.availability, Availability::Ready { .. }) {
            return None;
        }
        self.availability = Availability::Loading;
        Some(calls::host_roots())
    }

    // The second, for a session: is its own directory one the gateway serves. The answer goes to `cwd_answered`.
    pub fn roots_answered(&mut self, answer: Answer) -> Option<HttpCall> {
        match answer.read::<HostRoots>() {
            Err(error) => {
                self.availability = if answer.status == 404 { Availability::Unavailable } else { Availability::Failed(error.message) };
                None
            }
            Ok(roots) => {
                self.roots = roots.roots;
                self.writable = roots.can_write;
                match &self.cwd {
                    Some(cwd) => Some(calls::host_dir(cwd)),
                    None => {
                        self.availability = Availability::Ready { can_write: roots.can_write };
                        None
                    }
                }
            }
        }
    }

    pub fn cwd_answered(&mut self, answer: Answer) {
        let Some(cwd) = self.cwd.clone() else { return };
        let can_write = self.writable;
        match answer.read::<HostListing>() {
            Ok(listing) => {
                self.store(&cwd, listing);
                self.availability = Availability::Ready { can_write };
            }
            Err(error) => {
                self.availability = if answer.status == 404 { Availability::OutsideRoots } else { Availability::Failed(error.message) };
            }
        }
    }

    // A directory's listing, unless cached or in flight; `force` re-fetches, since the agent edits this same tree.
    pub fn list(&mut self, path: &str, force: bool) -> Option<HttpCall> {
        if (!force && self.listings.contains_key(path)) || self.loading.contains(path) {
            return None;
        }
        self.loading.insert(path.to_owned());
        Some(calls::host_dir(path))
    }

    pub fn listed(&mut self, path: &str, answer: Answer) {
        self.loading.remove(path);
        match answer.read::<HostListing>() {
            Ok(listing) => {
                self.store(path, listing);
                if self.cwd.is_none() {
                    self.error = None;
                }
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    fn store(&mut self, asked: &str, mut listing: HostListing) {
        if self.cwd.is_none() {
            listing.entries.retain(|e| matches!(e.kind, HostEntryKind::Dir | HostEntryKind::Symlink));
        }
        if listing.path != asked {
            self.listings.insert(asked.to_owned(), listing.clone());
        }
        self.listings.insert(listing.path.clone(), listing);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileContent {
    Loading,
    Text { original: String, hash: String },
    Binary { bytes: u64 },
    Failed(String),
}

// One host file in the editor. Every write is conditional on the hash of the read (or the last save) it started
// from; a 409 means the file changed on disk, which is fixed by reloading, never by forcing.
#[derive(Debug)]
pub struct HostFileEditor {
    path: String,
    content: FileContent,
    modified_at: Option<f64>,
    draft: String,
    saving: Option<String>,
    error: Option<String>,
    conflict: bool,
}

impl HostFileEditor {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            content: FileContent::Loading,
            modified_at: None,
            draft: String::new(),
            saving: None,
            error: None,
            conflict: false,
        }
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn content(&self) -> &FileContent {
        &self.content
    }

    pub fn modified_at(&self) -> Option<f64> {
        self.modified_at
    }

    pub fn draft(&self) -> &str {
        &self.draft
    }

    pub fn set_draft(&mut self, draft: String) {
        self.draft = draft;
    }

    pub fn saving(&self) -> bool {
        self.saving.is_some()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn clear_error(&mut self) {
        self.error = None;
    }

    pub fn conflict(&self) -> bool {
        self.conflict
    }

    pub fn is_dirty(&self) -> bool {
        matches!(&self.content, FileContent::Text { original, .. } if *original != self.draft)
    }

    pub fn load(&mut self) -> HttpCall {
        self.content = FileContent::Loading;
        self.conflict = false;
        calls::read_host_file(&self.path)
    }

    pub fn read_answered(&mut self, answer: Answer) {
        match answer.read::<HostRead>() {
            Ok(read) => {
                self.modified_at = Some(read.modified_at);
                self.content = match read.text() {
                    Some(text) => {
                        self.draft = text.to_owned();
                        FileContent::Text { original: text.to_owned(), hash: read.hash.clone() }
                    }
                    None => FileContent::Binary { bytes: read.bytes },
                };
            }
            Err(error) => self.content = FileContent::Failed(error.message),
        }
    }

    pub fn save(&mut self) -> Option<HttpCall> {
        let FileContent::Text { hash, .. } = &self.content else { return None };
        if self.saving.is_some() {
            return None;
        }
        let write = HostWrite { path: self.path.clone(), content: self.draft.clone(), base64: false, expected_hash: Some(hash.clone()) };
        self.saving = Some(self.draft.clone());
        Some(calls::write_host_file(&write))
    }

    // The write's own hash is the base of the next one, so a second save needs no read in between.
    pub fn save_answered(&mut self, answer: Answer) {
        let Some(sent) = self.saving.take() else { return };
        match answer.read::<HostWritten>() {
            Ok(written) => {
                self.content = FileContent::Text { original: sent, hash: written.hash };
                self.modified_at = Some(written.modified_at);
                self.conflict = false;
            }
            Err(error) => {
                self.conflict = answer.status == 409;
                self.error = Some(error.message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&str> = Some("application/json");
    const ROOTS: &str = r#"{"roots":[{"path":"/r","name":"r"}],"canWrite":true}"#;

    fn ok(body: &str) -> Answer<'_> {
        Answer::new(200, JSON, body)
    }

    fn refused(status: u16) -> Answer<'static> {
        Answer::new(status, JSON, r#"{"error":"nope"}"#)
    }

    #[test]
    fn a_session_browser_asks_for_roots_then_its_own_directory() {
        let mut b = HostBrowser::session("/r/link");
        assert_eq!(b.load().unwrap().path, "/fs/roots");
        let next = b.roots_answered(ok(ROOTS)).unwrap();
        assert_eq!(b.availability(), &Availability::Loading);
        assert_eq!(next.path, "/fs/list?path=%2Fr%2Flink");
        b.cwd_answered(ok(r#"{"path":"/r/real","entries":[{"name":"a","path":"/r/real/a","type":"file","bytes":3}]}"#));
        assert_eq!(b.availability(), &Availability::Ready { can_write: true });
        assert!(b.can_write());
        assert_eq!(b.listing("/r/link").unwrap().path, "/r/real");
        assert_eq!(b.listing("/r/real").unwrap().entries.len(), 1);
        assert_eq!(b.load(), None);
    }

    #[test]
    fn a_404_on_roots_is_no_file_access_and_on_the_cwd_is_outside_the_roots() {
        let mut none = HostBrowser::session("/w");
        none.load();
        assert_eq!(none.roots_answered(Answer::new(404, Some("text/html"), "")), None);
        assert_eq!(none.availability(), &Availability::Unavailable);

        let mut outside = HostBrowser::session("/w");
        outside.load();
        outside.roots_answered(ok(ROOTS));
        outside.cwd_answered(refused(404));
        assert_eq!(outside.availability(), &Availability::OutsideRoots);

        let mut broken = HostBrowser::session("/w");
        broken.load();
        broken.roots_answered(Answer::new(0, None, ""));
        assert_eq!(broken.availability(), &Availability::Failed("The gateway did not answer".into()));
        assert!(broken.load().is_some());
        broken.roots_answered(ok(ROOTS));
        broken.cwd_answered(refused(500));
        assert_eq!(broken.availability(), &Availability::Failed("nope".into()));
    }

    #[test]
    fn a_listing_is_fetched_once_unless_forced() {
        let mut b = HostBrowser::session("/w");
        assert!(b.list("/w/a", false).is_some());
        assert!(b.is_loading("/w/a"));
        assert_eq!(b.list("/w/a", true), None);
        b.listed("/w/a", ok(r#"{"path":"/w/a","entries":[],"truncated":true}"#));
        assert!(!b.is_loading("/w/a"));
        assert!(b.listing("/w/a").unwrap().truncated);
        assert_eq!(b.list("/w/a", false), None);
        assert!(b.list("/w/a", true).is_some());
        b.listed("/w/a", refused(404));
        assert_eq!(b.error(), Some("nope"));
        assert!(b.listing("/w/a").is_some());
    }

    #[test]
    fn the_folder_picker_shows_roots_and_keeps_only_folders() {
        let mut p = HostBrowser::folders();
        p.load();
        assert_eq!(p.roots_answered(ok(ROOTS)), None);
        assert_eq!(p.roots().len(), 1);
        assert!(matches!(p.availability(), Availability::Ready { .. }));
        p.list("/r/x", false);
        p.listed("/r/x", refused(404));
        assert_eq!(p.error(), Some("nope"));
        p.list("/r", false);
        p.listed(
            "/r",
            ok(r#"{"path":"/r","entries":[{"name":"d","path":"/r/d","type":"dir"},{"name":"f","path":"/r/f","type":"file"},{"name":"s","path":"/r/s","type":"symlink"},{"name":"o","path":"/r/o","type":"socket"}]}"#),
        );
        let names: Vec<&str> = p.listing("/r").unwrap().entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["d", "s"]);
        assert_eq!(p.error(), None);
    }

    const READ: &str = r#"{"path":"/w/a","content":"hi","encoding":"utf8","bytes":2,"hash":"h1","modifiedAt":5}"#;
    const WRITTEN: &str = r#"{"path":"/w/a","bytes":3,"hash":"h2","modifiedAt":6}"#;

    #[test]
    fn an_edit_saves_against_the_hash_it_started_from() {
        let mut e = HostFileEditor::new("/w/a");
        assert_eq!(e.load().path, "/fs/read?path=%2Fw%2Fa");
        e.read_answered(ok(READ));
        assert_eq!(e.content(), &FileContent::Text { original: "hi".into(), hash: "h1".into() });
        assert!(!e.is_dirty());
        e.set_draft("hi!".into());
        assert!(e.is_dirty());
        let save = e.save().unwrap();
        assert_eq!((save.method, save.path.as_str()), ("PUT", "/fs/write"));
        assert_eq!(save.body.as_deref(), Some(r#"{"path":"/w/a","content":"hi!","encoding":"utf8","expectedHash":"h1"}"#));
        assert!(e.saving());
        assert_eq!(e.save(), None);
        e.set_draft("hi!?".into());
        e.save_answered(ok(WRITTEN));
        assert_eq!(e.content(), &FileContent::Text { original: "hi!".into(), hash: "h2".into() });
        assert!(e.is_dirty());
        assert_eq!(e.modified_at(), Some(6.0));
        assert!(e.save().unwrap().body.unwrap().contains(r#""expectedHash":"h2""#));
    }

    #[test]
    fn a_conflict_is_its_own_answer() {
        let mut e = HostFileEditor::new("/w/a");
        e.load();
        e.read_answered(ok(READ));
        e.save();
        e.save_answered(Answer::new(409, JSON, r#"{"error":"changed on disk"}"#));
        assert!(e.conflict() && !e.saving());
        assert_eq!(e.error(), Some("changed on disk"));
        e.load();
        assert!(!e.conflict());
        e.read_answered(refused(404));
        assert_eq!(e.content(), &FileContent::Failed("nope".into()));
        assert_eq!(e.save(), None);
    }

    #[test]
    fn a_binary_file_is_never_opened_for_editing() {
        let mut e = HostFileEditor::new("/w/b");
        e.load();
        e.read_answered(ok(r#"{"path":"/w/b","content":"AAE=","encoding":"base64","bytes":2,"hash":"h","modifiedAt":1}"#));
        assert_eq!(e.content(), &FileContent::Binary { bytes: 2 });
        assert!(!e.is_dirty());
        assert_eq!(e.save(), None);
    }
}
