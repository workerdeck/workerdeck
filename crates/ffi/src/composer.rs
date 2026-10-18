use crate::rest::HttpAnswer;
use crate::{HttpCall, Session};
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::vm::attachments::{self as files, AttachmentState};
use wd_native::vm::composer::{self as core, Gutter as CoreGutter, NoteKind as CoreNoteKind};
use wd_native::vm::composer_tokens::{self as tokens, SKILL_HINT, Suggestion as CoreSuggestion, TokenKind as CoreTokenKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TokenKind {
    File,
    Command,
    Skill,
    Session,
}

impl From<CoreTokenKind> for TokenKind {
    fn from(kind: CoreTokenKind) -> Self {
        match kind {
            CoreTokenKind::File => TokenKind::File,
            CoreTokenKind::Command => TokenKind::Command,
            CoreTokenKind::Skill => TokenKind::Skill,
            CoreTokenKind::Session => TokenKind::Session,
        }
    }
}

// UTF-16 offsets into the draft.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TokenSpan {
    pub kind: TokenKind,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DraftEdit {
    pub text: String,
    pub cursor: u32,
}

impl From<tokens::DraftEdit> for DraftEdit {
    fn from(edit: tokens::DraftEdit) -> Self {
        Self { text: edit.text, cursor: edit.cursor as u32 }
    }
}

// `Search`: wait `delay_ms`, then perform `call` if `is_current(generation)` still holds and hand the answer to
// `files_answered`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CompletionStep {
    Unchanged,
    Changed,
    Search { generation: u64, delay_ms: u32, call: HttpCall },
}

impl From<tokens::CompletionStep> for CompletionStep {
    fn from(step: tokens::CompletionStep) -> Self {
        match step {
            tokens::CompletionStep::Unchanged => CompletionStep::Unchanged,
            tokens::CompletionStep::Changed => CompletionStep::Changed,
            tokens::CompletionStep::Search { generation, delay_ms, call } => {
                CompletionStep::Search { generation, delay_ms, call: call.into() }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Suggestion {
    pub id: String,
    pub kind: TokenKind,
    pub title: String,
    pub hint: Option<String>,
    pub subtitle: Option<String>,
    // A path: monospaced, truncated at the head.
    pub path_subtitle: bool,
}

fn present(text: &Option<String>) -> Option<String> {
    text.clone().filter(|t| !t.is_empty())
}

impl From<&CoreSuggestion> for Suggestion {
    fn from(suggestion: &CoreSuggestion) -> Self {
        let id = suggestion.id();
        match suggestion {
            CoreSuggestion::File(m) => Suggestion {
                id,
                kind: TokenKind::File,
                title: m.relative.rsplit('/').find(|part| !part.is_empty()).unwrap_or(&m.relative).to_owned(),
                hint: None,
                subtitle: Some(m.relative.clone()),
                path_subtitle: true,
            },
            CoreSuggestion::Command(c) => Suggestion {
                id,
                kind: TokenKind::Command,
                title: format!("/{}", c.name),
                hint: present(&c.argument_hint),
                subtitle: present(&c.description),
                path_subtitle: false,
            },
            CoreSuggestion::Skill(s) => Suggestion {
                id,
                kind: TokenKind::Skill,
                title: s.display_name.clone().unwrap_or_else(|| s.name.clone()),
                hint: None,
                subtitle: Some(s.short_description.clone().or_else(|| s.description.clone()).unwrap_or_else(|| SKILL_HINT.to_owned())),
                path_subtitle: false,
            },
            CoreSuggestion::Session(p) => Suggestion {
                id,
                kind: TokenKind::Session,
                title: p.label.clone(),
                hint: None,
                subtitle: Some(p.detail.clone()),
                path_subtitle: false,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Gutter {
    Shell,
    Interrupt,
    AddMedia,
    Prompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum NoteKind {
    Shell,
    SendNow,
    Queued,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ComposerNote {
    pub kind: NoteKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ComposerView {
    pub enabled: bool,
    pub shell_mode: bool,
    pub can_send: bool,
    pub send_label: String,
    pub placeholder: String,
    pub gutter: Gutter,
    pub note: Option<ComposerNote>,
    pub attachment_kinds: Vec<String>,
    pub can_add_media: bool,
    pub suggestions_open: bool,
    // Draw again at this epoch ms: Send now appears on its own.
    pub wake_at: Option<i64>,
}

impl From<core::ComposerView> for ComposerView {
    fn from(v: core::ComposerView) -> Self {
        Self {
            enabled: v.enabled,
            shell_mode: v.shell_mode,
            can_send: v.can_send,
            send_label: v.send_label.to_owned(),
            placeholder: v.placeholder.to_owned(),
            gutter: match v.gutter {
                CoreGutter::Shell => Gutter::Shell,
                CoreGutter::Interrupt => Gutter::Interrupt,
                CoreGutter::AddMedia => Gutter::AddMedia,
                CoreGutter::Prompt => Gutter::Prompt,
            },
            note: v.note.map(|n| ComposerNote {
                kind: match n.kind {
                    CoreNoteKind::Shell => NoteKind::Shell,
                    CoreNoteKind::SendNow => NoteKind::SendNow,
                    CoreNoteKind::Queued => NoteKind::Queued,
                },
                text: n.text,
            }),
            attachment_kinds: v.attachment_kinds,
            can_add_media: v.can_add_media,
            suggestions_open: v.suggestions_open,
            wake_at: v.wake_at,
        }
    }
}

// `background`: after queueing the message, move the running command to the background (`Session.background_task`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Outgoing {
    Shell { command: String },
    Message { text: String, attachment_ids: Vec<String>, background: bool },
}

impl From<core::Outgoing> for Outgoing {
    fn from(o: core::Outgoing) -> Self {
        match o {
            core::Outgoing::Shell { command } => Outgoing::Shell { command },
            core::Outgoing::Message { text, attachment_ids, background } => Outgoing::Message { text, attachment_ids, background },
        }
    }
}

// Send the staged file's bytes as the body of `call`, under its media type, then hand the answer to `uploaded`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Upload {
    pub id: u64,
    pub call: HttpCall,
}

impl From<files::Upload> for Upload {
    fn from(u: files::Upload) -> Self {
        Self { id: u.id, call: u.call.into() }
    }
}

// A staged file going up again into another session: `upload.id` takes over from `replaces`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Reupload {
    pub replaces: u64,
    pub upload: Upload,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum AttachmentStatus {
    Uploading,
    Ready,
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AttachmentChip {
    pub id: u64,
    pub name: String,
    pub media_type: String,
    pub extension: String,
    pub status: AttachmentStatus,
    pub accessibility_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ImagePlan {
    Keep,
    Jpeg { name: String, width: u32, height: u32 },
}

#[uniffi::export]
pub fn image_plan(name: String, media_type: Option<String>, width: u32, height: u32) -> ImagePlan {
    match files::image_plan(&name, media_type.as_deref(), width, height) {
        files::ImagePlan::Keep => ImagePlan::Keep,
        files::ImagePlan::Jpeg { name, width, height } => ImagePlan::Jpeg { name, width, height },
    }
}

#[uniffi::export]
pub fn image_jpeg_quality() -> f32 {
    files::JPEG_QUALITY
}

#[uniffi::export]
pub fn attachment_thumbnail_size(width: u32, height: u32) -> Vec<u32> {
    let (w, h) = files::thumbnail_size(width, height);
    vec![w, h]
}

#[uniffi::export]
pub fn attachment_kind(media_type: String) -> Option<String> {
    files::attachment_kind(&media_type).map(str::to_owned)
}

#[uniffi::export]
pub fn unreadable_file(name: String) -> String {
    files::unreadable(&name)
}

// Text handed to the composer from elsewhere (a path, a quote), landing as its own word.
#[uniffi::export]
pub fn composer_insert(draft: String, text: String) -> DraftEdit {
    tokens::insert(&draft, &text).into()
}

// One composer per open session. The draft stays in the platform's text view and is passed in where it matters.
#[derive(uniffi::Object)]
pub struct Composer {
    inner: Mutex<core::Composer>,
}

impl Composer {
    fn lock(&self) -> MutexGuard<'_, core::Composer> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl Composer {
    #[uniffi::constructor]
    pub fn new(session_id: String) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(core::Composer::new(&session_id)) })
    }

    // After every session update: the chrome, commands and skills the composer reads.
    pub fn read_session(&self, session: Arc<Session>) {
        let (chrome, commands, skills) = {
            let live = session.live();
            (live.chrome(), live.commands(), live.skills())
        };
        let mut composer = self.lock();
        composer.set_chrome(chrome);
        composer.set_lists(commands, skills);
    }

    // The body of `list_sessions_call()`; false for another shape, which keeps the last list.
    pub fn set_peers(&self, body: String) -> bool {
        self.lock().set_peers(&body)
    }

    pub fn view(&self, draft: String, now_ms: i64) -> ComposerView {
        self.lock().view(&draft, now_ms).into()
    }

    // After every edit or caret move; `cursor` in UTF-16 units.
    pub fn edit(&self, draft: String, cursor: u32) -> CompletionStep {
        self.lock().edit(&draft, cursor as usize).into()
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.lock().completion.is_current(generation)
    }

    pub fn files_answered(&self, generation: u64, answer: HttpAnswer) -> bool {
        self.lock().files_answered(generation, answer.core())
    }

    pub fn suggestions(&self) -> Vec<Suggestion> {
        self.lock().completion.suggestions().iter().map(Into::into).collect()
    }

    pub fn accept(&self, index: u32, draft: String, cursor: u32) -> Option<DraftEdit> {
        self.lock().accept(index as usize, &draft, cursor as usize).map(Into::into)
    }

    pub fn dismiss_suggestions(&self) -> bool {
        self.lock().completion.cancel()
    }

    pub fn tokens(&self, draft: String) -> Vec<TokenSpan> {
        self.lock()
            .tokens(&draft)
            .into_iter()
            .map(|t| TokenSpan { kind: t.kind.into(), start: t.start as u32, end: t.end as u32 })
            .collect()
    }

    // A character typed into an empty field (empty for a backspace); true when it switched modes and must not land.
    pub fn leading_trigger(&self, character: String) -> bool {
        self.lock().leading_trigger(&character)
    }

    pub fn exit_shell(&self, draft: String) -> DraftEdit {
        self.lock().exit_shell(&draft).into()
    }

    pub fn refusal(&self, media_type: String) -> Option<String> {
        self.lock().refusal(&media_type)
    }

    pub fn add_attachment(&self, name: String, media_type: String) -> Option<Upload> {
        self.lock().add_attachment(&name, &media_type).map(Into::into)
    }

    pub fn retry_attachment(&self, id: u64) -> Option<Upload> {
        self.lock().retry_attachment(id).map(Into::into)
    }

    pub fn retarget(&self, session_id: String) -> Vec<Reupload> {
        self.lock().retarget(&session_id).into_iter().map(|(replaces, upload)| Reupload { replaces, upload: upload.into() }).collect()
    }

    // Status 0 for a transport failure.
    pub fn uploaded(&self, id: u64, answer: HttpAnswer) -> bool {
        self.lock().attachments.uploaded(id, answer.core())
    }

    pub fn remove_attachment(&self, id: u64) {
        self.lock().attachments.remove(id);
    }

    pub fn attachments(&self) -> Vec<AttachmentChip> {
        self.lock()
            .attachments
            .items()
            .iter()
            .map(|a| {
                let (status, accessibility_label) = match &a.state {
                    AttachmentState::Uploading => (AttachmentStatus::Uploading, a.name.clone()),
                    AttachmentState::Ready { .. } => (AttachmentStatus::Ready, a.name.clone()),
                    AttachmentState::Failed { message } => {
                        (AttachmentStatus::Failed { message: message.clone() }, format!("{}, failed: {message}. Tap to retry.", a.name))
                    }
                };
                AttachmentChip {
                    id: a.id,
                    name: a.name.clone(),
                    media_type: a.media_type.clone(),
                    extension: files::extension_label(&a.name),
                    status,
                    accessibility_label,
                }
            })
            .collect()
    }

    // An attachment failure to show once in an alert.
    pub fn take_error(&self) -> Option<String> {
        self.lock().attachments.take_error()
    }

    pub fn announce(&self, message: String) {
        self.lock().attachments.announce(message);
    }

    // None when nothing can be sent; otherwise the composer is reset for the next message and the platform clears
    // the draft.
    pub fn send(&self, draft: String, background: bool) -> Option<Outgoing> {
        self.lock().send(&draft, background).map(Into::into)
    }
}
