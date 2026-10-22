// The docked composer minus the text field: shell mode, the suggestion list, staged files, what the gutter and the
// note under the field show, and what a send carries. The draft itself stays in the platform's text view.
use crate::controller::shell::{ComposerTrigger, composer_trigger, exit_draft};
use crate::rest::error::Answer;
use crate::vm::attachments::{Attachments, Upload, refusal};
use crate::vm::composer_lists::{Skill, SlashCommand};
use crate::vm::composer_tokens::{Completion, CompletionStep, DraftEdit, PromptToken, confirmed, peer_sessions};
use crate::vm::session_chrome::SessionChrome;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gutter {
    Shell,
    Interrupt,
    AddMedia,
    Prompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    Shell,
    SendNow,
    Queued,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub kind: NoteKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerView {
    pub enabled: bool,
    pub shell_mode: bool,
    pub can_send: bool,
    pub send_label: &'static str,
    pub placeholder: &'static str,
    pub gutter: Gutter,
    pub note: Option<Note>,
    pub attachment_kinds: Vec<String>,
    pub can_add_media: bool,
    pub suggestions_open: bool,
    // When (epoch ms) the view next changes on its own, Send now appearing; draw again then.
    pub wake_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Shell { command: String },
    // `background` moves the running command to the background after the message is queued.
    Message { text: String, attachment_ids: Vec<String>, background: bool },
}

pub const SHELL_NOTE: &str = "shell mode \u{00B7} tap $ to exit";
pub const SEND_NOW_NOTE: &str = "send now - moves the running command to the background";

#[derive(Debug, Clone, Default)]
pub struct Composer {
    pub session_id: String,
    chrome: SessionChrome,
    shell_mode: bool,
    pub completion: Completion,
    pub attachments: Attachments,
}

impl Composer {
    pub fn new(session_id: &str) -> Self {
        Self { session_id: session_id.to_owned(), ..Self::default() }
    }

    // A session that moved on to its next conversation takes its staged files along: they go up again there, and the
    // answer names each new upload with the id it replaces.
    pub fn set_chrome(&mut self, chrome: SessionChrome) -> Vec<(u64, Upload)> {
        let before = self.chrome.conversation;
        self.completion.set_cwd(chrome.cwd.clone());
        self.chrome = chrome;
        match self.target().map(|(id, n)| (id.to_owned(), n)) {
            Some((id, n)) if before.is_some_and(|before| before != n) => self.attachments.retarget((&id, n)),
            _ => Vec::new(),
        }
    }

    pub fn set_lists(&mut self, commands: Vec<SlashCommand>, skills: Vec<Skill>) {
        self.completion.commands = commands;
        self.completion.skills = skills;
    }

    // The body of `GET /v1/sessions`; answers false for another shape, which leaves the last list in place.
    pub fn set_peers(&mut self, body: &str) -> bool {
        match peer_sessions(body, &self.session_id) {
            Some(peers) => {
                self.completion.peers = peers;
                true
            }
            None => false,
        }
    }

    pub fn shell_mode(&self) -> bool {
        self.shell_mode
    }

    fn typed(draft: &str) -> bool {
        !draft.trim().is_empty()
    }

    // A file on its own is a message, but not before its upload landed; in shell mode the line alone decides.
    pub fn can_send(&self, draft: &str) -> bool {
        if !self.chrome.enabled {
            return false;
        }
        if self.shell_mode {
            return Self::typed(draft);
        }
        if self.attachments.is_uploading() || self.attachments.has_failure() {
            return false;
        }
        Self::typed(draft) || !self.attachments.is_empty()
    }

    fn can_add_media(&self) -> bool {
        !self.chrome.attachment_kinds.is_empty() && !self.shell_mode
    }

    pub fn view(&self, draft: &str, now_ms: i64) -> ComposerView {
        let can_send = self.can_send(draft);
        let send_now_at = self.chrome.send_now_at.filter(|_| !self.shell_mode);
        let send_now = can_send && send_now_at.is_some_and(|at| at <= now_ms);
        let note = if self.shell_mode {
            Some(Note { kind: NoteKind::Shell, text: SHELL_NOTE.to_owned() })
        } else if send_now {
            Some(Note { kind: NoteKind::SendNow, text: SEND_NOW_NOTE.to_owned() })
        } else if self.chrome.queued > 0 {
            Some(Note { kind: NoteKind::Queued, text: format!("{} queued \u{00B7} sends when the turn ends", self.chrome.queued) })
        } else {
            None
        };
        let gutter = if self.shell_mode {
            Gutter::Shell
        } else if self.chrome.busy {
            Gutter::Interrupt
        } else if self.can_add_media() {
            Gutter::AddMedia
        } else {
            Gutter::Prompt
        };
        ComposerView {
            enabled: self.chrome.enabled,
            shell_mode: self.shell_mode,
            can_send,
            send_label: if self.shell_mode { "Run" } else { "Send" },
            placeholder: if self.shell_mode { "Run a command on the host" } else { "Message" },
            gutter,
            note,
            attachment_kinds: self.chrome.attachment_kinds.clone(),
            can_add_media: self.can_add_media(),
            suggestions_open: self.completion.is_open() && !self.shell_mode,
            wake_at: send_now_at.filter(|at| *at > now_ms),
        }
    }

    pub fn edit(&mut self, draft: &str, cursor: usize) -> CompletionStep {
        if self.shell_mode {
            return CompletionStep::Unchanged;
        }
        self.completion.update(draft, cursor)
    }

    // The tokens a draft styles; the word still being typed stays plain.
    pub fn tokens(&self, draft: &str) -> Vec<PromptToken> {
        confirmed(draft, &self.completion.names())
    }

    pub fn accept(&mut self, index: usize, draft: &str, cursor: usize) -> Option<DraftEdit> {
        self.completion.accept(index, draft, cursor)
    }

    pub fn files_answered(&mut self, generation: u64, answer: Answer<'_>) -> bool {
        self.completion.files_answered(generation, answer)
    }

    // A character typed into an empty field; true when it was a mode switch and must not land in the draft.
    pub fn leading_trigger(&mut self, character: &str) -> bool {
        match composer_trigger(character, self.shell_mode, self.chrome.can_run_shell) {
            ComposerTrigger::Enter => {
                self.shell_mode = true;
                self.completion.cancel();
                true
            }
            ComposerTrigger::Leave => {
                self.shell_mode = false;
                true
            }
            ComposerTrigger::Pass => false,
        }
    }

    // The phone's Escape: the `$` goes back in front of the draft.
    pub fn exit_shell(&mut self, draft: &str) -> DraftEdit {
        self.shell_mode = false;
        let text = exit_draft(draft);
        DraftEdit { cursor: text.encode_utf16().count(), text }
    }

    // Answers why a picked file cannot be staged, before its bytes are read.
    pub fn refusal(&self, media_type: &str) -> Option<String> {
        refusal(media_type, &self.chrome.attachment_kinds)
    }

    // Uploads go to the conversation the screen attached to; none before the first attach.
    fn target(&self) -> Option<(&str, i64)> {
        Some(self.session_id.as_str()).filter(|id| !id.is_empty()).zip(self.chrome.conversation)
    }

    pub fn add_attachment(&mut self, name: &str, media_type: &str) -> Option<Upload> {
        let target = self.target().map(|(id, n)| (id.to_owned(), n));
        self.attachments.add(target.as_ref().map(|(id, n)| (id.as_str(), *n)), name, media_type)
    }

    pub fn retry_attachment(&mut self, id: u64) -> Option<Upload> {
        let target = self.target().map(|(id, n)| (id.to_owned(), n));
        self.attachments.retry(id, target.as_ref().map(|(id, n)| (id.as_str(), *n)))
    }

    // What a send carries, and the composer reset for the next message; None when nothing can be sent.
    pub fn send(&mut self, draft: &str, background: bool) -> Option<Outgoing> {
        if !self.can_send(draft) {
            return None;
        }
        self.completion.cancel();
        if self.shell_mode {
            self.shell_mode = false;
            return Some(Outgoing::Shell { command: draft.to_owned() });
        }
        let attachment_ids = self.attachments.ready_ids();
        self.attachments.clear();
        Some(Outgoing::Message { text: draft.to_owned(), attachment_ids, background })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vm::session_chrome::SEND_NOW_AFTER_MS;

    const JSON: Option<&str> = Some("application/json");

    fn chrome(busy: bool, kinds: &[&str]) -> SessionChrome {
        SessionChrome {
            enabled: true,
            busy,
            can_run_shell: true,
            attachment_kinds: kinds.iter().map(|k| (*k).to_owned()).collect(),
            conversation: Some(1),
            ..SessionChrome::default()
        }
    }

    fn composer(chrome: SessionChrome) -> Composer {
        let mut composer = Composer::new("s1");
        _ = composer.set_chrome(chrome);
        composer
    }

    #[test]
    fn the_gutter_follows_shell_busy_and_attachments() {
        let mut c = composer(chrome(false, &["image"]));
        assert_eq!(c.view("", 0).gutter, Gutter::AddMedia);
        _ = c.set_chrome(chrome(false, &[]));
        assert_eq!(c.view("", 0).gutter, Gutter::Prompt);
        _ = c.set_chrome(chrome(true, &["image"]));
        assert_eq!(c.view("", 0).gutter, Gutter::Interrupt);
        assert!(c.leading_trigger("$"));
        let view = c.view("ls", 0);
        assert_eq!((view.gutter, view.send_label, view.can_add_media), (Gutter::Shell, "Run", false));
        assert_eq!(view.note.unwrap().text, SHELL_NOTE);
    }

    #[test]
    fn shell_mode_needs_the_capability_and_backspace_leaves_it() {
        let mut c = composer(SessionChrome { can_run_shell: false, ..chrome(false, &[]) });
        assert!(!c.leading_trigger("$"));
        _ = c.set_chrome(chrome(false, &[]));
        assert!(!c.leading_trigger("a"));
        assert!(c.leading_trigger("$"));
        assert!(c.shell_mode());
        assert!(!c.leading_trigger("l"));
        assert!(c.leading_trigger(""));
        assert!(!c.shell_mode());
        c.leading_trigger("$");
        assert_eq!(c.exit_shell("ls"), DraftEdit { text: "$ls".into(), cursor: 3 });
    }

    #[test]
    fn can_send_waits_for_uploads_and_blocks_on_failures() {
        let mut c = composer(chrome(false, &["image"]));
        assert!(!c.can_send("  "));
        assert!(c.can_send("hi"));
        let upload = c.add_attachment("a.png", "image/png").unwrap();
        assert!(!c.can_send("hi"));
        c.attachments.uploaded(upload.id, Answer::new(200, JSON, r#"{"attachment":{"id":"att"}}"#));
        assert!(c.can_send(""));
        let failed = c.add_attachment("b.png", "image/png").unwrap();
        c.attachments.uploaded(failed.id, Answer::new(500, JSON, r#"{"error":"boom"}"#));
        assert!(!c.can_send("hi"));
        c.attachments.remove(failed.id);
        assert_eq!(
            c.send("", false),
            Some(Outgoing::Message { text: String::new(), attachment_ids: vec!["att".into()], background: false })
        );
        assert!(c.attachments.is_empty());
        _ = c.set_chrome(SessionChrome { enabled: false, ..chrome(false, &[]) });
        assert!(!c.can_send("hi"));
        assert_eq!(c.send("hi", false), None);
    }

    #[test]
    fn a_shell_send_runs_the_line_and_leaves_shell_mode() {
        let mut c = composer(chrome(false, &[]));
        c.leading_trigger("$");
        assert!(!c.can_send(" "));
        assert_eq!(c.send("ls -la", false), Some(Outgoing::Shell { command: "ls -la".into() }));
        assert!(!c.shell_mode());
    }

    #[test]
    fn send_now_shows_once_the_call_is_old_enough_and_names_its_wake() {
        let mut c = composer(SessionChrome { send_now_at: Some(1000 + SEND_NOW_AFTER_MS), queued: 2, ..chrome(true, &[]) });
        let early = c.view("next", 1000);
        assert_eq!(early.note.as_ref().map(|n| n.kind), Some(NoteKind::Queued));
        assert_eq!(early.note.unwrap().text, "2 queued \u{00B7} sends when the turn ends");
        assert_eq!(early.wake_at, Some(1000 + SEND_NOW_AFTER_MS));
        let late = c.view("next", 1000 + SEND_NOW_AFTER_MS);
        assert_eq!(late.note.map(|n| n.kind), Some(NoteKind::SendNow));
        assert_eq!(late.wake_at, None);
        assert_eq!(c.view("", 1000 + SEND_NOW_AFTER_MS).note.map(|n| n.kind), Some(NoteKind::Queued));
        assert!(matches!(c.send("next", true), Some(Outgoing::Message { background: true, .. })));
    }

    #[test]
    fn refusals_and_peers_use_the_session() {
        let mut c = composer(chrome(false, &["image"]));
        assert!(c.refusal("application/pdf").is_some());
        assert!(c.set_peers(r#"{"sessions":[{"id":"s1","createdAt":1},{"id":"s2","title":"Astra","createdAt":1}]}"#));
        assert!(!c.set_peers("nope"));
        assert_eq!(c.completion.peers.len(), 1);
        c.edit("ask #As", 7);
        assert!(c.view("ask #As", 0).suggestions_open);
        assert_eq!(c.tokens("ask #Astra now").len(), 1);
        c.leading_trigger("$");
        assert_eq!(c.edit("#", 1), CompletionStep::Unchanged);
    }
}
