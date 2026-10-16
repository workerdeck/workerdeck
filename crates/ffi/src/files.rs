use crate::{HttpAnswer, HttpCall};
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::rest::files as wire;
use wd_native::vm::host_files::{self as core, FileContent};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum HostFilesAvailability {
    Loading,
    Unavailable,
    OutsideRoots,
    Ready { can_write: bool },
    Failed { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum HostEntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HostEntry {
    pub name: String,
    pub path: String,
    pub kind: HostEntryKind,
    pub bytes: Option<u64>,
    pub modified_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HostListing {
    pub path: String,
    pub entries: Vec<HostEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HostRoot {
    pub path: String,
    pub name: String,
}

fn entry(e: &wire::HostEntry) -> HostEntry {
    let kind = match e.kind {
        wire::HostEntryKind::File => HostEntryKind::File,
        wire::HostEntryKind::Dir => HostEntryKind::Dir,
        wire::HostEntryKind::Symlink => HostEntryKind::Symlink,
        wire::HostEntryKind::Other => HostEntryKind::Other,
    };
    HostEntry { name: e.name.clone(), path: e.path.clone(), kind, bytes: e.bytes, modified_at: e.modified_at }
}

// The host file browser (`HostFiles.session`, rooted at a session's cwd) or the folder picker (`HostFiles.folders`).
// Each `*_call` that answers a call marks it asked; its answer goes back whole to the matching `*_answered`.
#[derive(uniffi::Object)]
pub struct HostFiles {
    inner: Mutex<core::HostBrowser>,
}

impl HostFiles {
    fn lock(&self) -> MutexGuard<'_, core::HostBrowser> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[uniffi::export]
impl HostFiles {
    #[uniffi::constructor]
    pub fn session(cwd: String) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(core::HostBrowser::session(&cwd)) })
    }

    #[uniffi::constructor]
    pub fn folders() -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(core::HostBrowser::folders()) })
    }

    pub fn cwd(&self) -> Option<String> {
        self.lock().cwd().map(str::to_owned)
    }

    // `/fs/roots`, unless already ready.
    pub fn load_call(&self) -> Option<HttpCall> {
        self.lock().load().map(Into::into)
    }

    // For a session, the call that lists its own directory next.
    pub fn roots_answered(&self, answer: HttpAnswer) -> Option<HttpCall> {
        self.lock().roots_answered(answer.core()).map(Into::into)
    }

    pub fn cwd_answered(&self, answer: HttpAnswer) {
        self.lock().cwd_answered(answer.core());
    }

    #[uniffi::method(default(force = false))]
    pub fn list_call(&self, path: String, force: bool) -> Option<HttpCall> {
        self.lock().list(&path, force).map(Into::into)
    }

    pub fn listed(&self, path: String, answer: HttpAnswer) {
        self.lock().listed(&path, answer.core());
    }

    pub fn availability(&self) -> HostFilesAvailability {
        match self.lock().availability() {
            core::Availability::Loading => HostFilesAvailability::Loading,
            core::Availability::Unavailable => HostFilesAvailability::Unavailable,
            core::Availability::OutsideRoots => HostFilesAvailability::OutsideRoots,
            core::Availability::Ready { can_write } => HostFilesAvailability::Ready { can_write: *can_write },
            core::Availability::Failed(message) => HostFilesAvailability::Failed { message: message.clone() },
        }
    }

    pub fn roots(&self) -> Vec<HostRoot> {
        self.lock().roots().iter().map(|r| HostRoot { path: r.path.clone(), name: r.name.clone() }).collect()
    }

    pub fn can_write(&self) -> bool {
        self.lock().can_write()
    }

    pub fn listing(&self, path: String) -> Option<HostListing> {
        self.lock().listing(&path).map(|l| HostListing {
            path: l.path.clone(),
            entries: l.entries.iter().map(entry).collect(),
            truncated: l.truncated,
        })
    }

    pub fn is_loading(&self, path: String) -> bool {
        self.lock().is_loading(&path)
    }

    pub fn error(&self) -> Option<String> {
        self.lock().error().map(str::to_owned)
    }

    pub fn clear_error(&self) {
        self.lock().clear_error();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum HostFileContent {
    Loading,
    Text { original: String, hash: String },
    Binary { bytes: u64 },
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HostFileState {
    pub content: HostFileContent,
    pub modified_at: Option<f64>,
    pub dirty: bool,
    pub saving: bool,
    pub conflict: bool,
    pub error: Option<String>,
}

// One host file open in the editor: the draft lives here, so dirtiness and the save's base hash are the core's.
#[derive(uniffi::Object)]
pub struct HostFileEditor {
    inner: Mutex<core::HostFileEditor>,
}

impl HostFileEditor {
    fn lock(&self) -> MutexGuard<'_, core::HostFileEditor> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[uniffi::export]
impl HostFileEditor {
    #[uniffi::constructor]
    pub fn new(path: String) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(core::HostFileEditor::new(&path)) })
    }

    pub fn path(&self) -> String {
        self.lock().path().to_owned()
    }

    pub fn load_call(&self) -> HttpCall {
        self.lock().load().into()
    }

    pub fn read_answered(&self, answer: HttpAnswer) {
        self.lock().read_answered(answer.core());
    }

    pub fn draft(&self) -> String {
        self.lock().draft().to_owned()
    }

    pub fn set_draft(&self, draft: String) {
        self.lock().set_draft(draft);
    }

    // None while a save is in flight or there is no text to save.
    pub fn save_call(&self) -> Option<HttpCall> {
        self.lock().save().map(Into::into)
    }

    pub fn save_answered(&self, answer: HttpAnswer) {
        self.lock().save_answered(answer.core());
    }

    pub fn clear_error(&self) {
        self.lock().clear_error();
    }

    pub fn state(&self) -> HostFileState {
        let editor = self.lock();
        let content = match editor.content() {
            FileContent::Loading => HostFileContent::Loading,
            FileContent::Text { original, hash } => HostFileContent::Text { original: original.clone(), hash: hash.clone() },
            FileContent::Binary { bytes } => HostFileContent::Binary { bytes: *bytes },
            FileContent::Failed(message) => HostFileContent::Failed { message: message.clone() },
        };
        HostFileState {
            content,
            modified_at: editor.modified_at(),
            dirty: editor.is_dirty(),
            saving: editor.saving(),
            conflict: editor.conflict(),
            error: editor.error().map(str::to_owned),
        }
    }
}
