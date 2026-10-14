// The native apps' one door into the core: UniFFI records for commands and effects, versioned byte buffers
// (`wd_native::snapshot`) for everything a renderer draws. The platform drives one `Session` from one thread; the
// mutex only makes the object `Sync` for UniFFI.
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::controller::live::{self, LiveSession};
use wd_native::controller::transcript::Navigation;
use wd_native::controller::viewport::Viewport;
use wd_native::planner;
use wd_native::rest::{PermissionMode, ShellInfo};
use wd_native::snapshot;
use wd_native::vt::VtKey;

mod list;
mod prompt;
pub use list::{ListError, ListGroup, ListRow, RowState, SessionList};
pub use prompt::{ChoiceKey, Prompt, PromptChoice, PromptKind, Question, QuestionOption, Selection};

uniffi::setup_scaffolding!();

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct Metrics {
    pub cell: f64,
    pub line: f64,
    pub width: f64,
    pub font_size: f64,
}

impl From<Metrics> for planner::Metrics {
    fn from(m: Metrics) -> Self {
        planner::Metrics { cell: m.cell, line: m.line, width: m.width, font_size: m.font_size }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ConnectionState {
    Connecting,
    Live,
    Reconnecting,
    Offline,
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct Changed {
    pub transcript: bool,
    pub chrome: bool,
    pub progress: bool,
    pub shells: bool,
    pub frames: bool,
    pub prompt: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum Effect {
    Open { after_seq: i64 },
    Send { id: u64, text: String },
    Close,
    WakeAt { at: f64 },
    Request { id: u64, method: String, path: String },
    OpenSubagent { task_id: String },
    OpenShell { shell_id: String },
    Changed { changed: Changed },
}

impl From<live::Effect> for Effect {
    fn from(effect: live::Effect) -> Self {
        match effect {
            live::Effect::Open { after_seq } => Effect::Open { after_seq },
            live::Effect::Send { id, text } => Effect::Send { id, text },
            live::Effect::Close => Effect::Close,
            live::Effect::WakeAt(at) => Effect::WakeAt { at },
            live::Effect::Request { id, method, path } => Effect::Request { id, method: method.to_owned(), path },
            live::Effect::OpenSubagent { task_id } => Effect::OpenSubagent { task_id },
            live::Effect::OpenShell { shell_id } => Effect::OpenShell { shell_id },
            live::Effect::Changed(c) => Effect::Changed {
                changed: Changed {
                    transcript: c.transcript,
                    chrome: c.chrome,
                    progress: c.progress,
                    shells: c.shells,
                    frames: c.frames,
                    prompt: c.prompt,
                },
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Mode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
}

impl From<Mode> for PermissionMode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Default => PermissionMode::Default,
            Mode::AcceptEdits => PermissionMode::AcceptEdits,
            Mode::BypassPermissions => PermissionMode::BypassPermissions,
            Mode::Plan => PermissionMode::Plan,
            Mode::DontAsk => PermissionMode::DontAsk,
            Mode::Auto => PermissionMode::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Key {
    Char { text: String },
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Delete,
    Function { n: u8 },
    Control { text: String },
}

impl Key {
    fn vt(&self) -> Option<VtKey> {
        Some(match self {
            Key::Char { text } => VtKey::Char(text.chars().next()?),
            Key::Enter => VtKey::Enter,
            Key::Tab => VtKey::Tab,
            Key::Backspace => VtKey::Backspace,
            Key::Escape => VtKey::Escape,
            Key::Up => VtKey::Up,
            Key::Down => VtKey::Down,
            Key::Left => VtKey::Left,
            Key::Right => VtKey::Right,
            Key::Home => VtKey::Home,
            Key::End => VtKey::End,
            Key::PageUp => VtKey::PageUp,
            Key::PageDown => VtKey::PageDown,
            Key::Delete => VtKey::Delete,
            Key::Function { n } => VtKey::Function(*n),
            Key::Control { text } => VtKey::Control(text.chars().next()?),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ReplayProgress {
    pub seq: i64,
    pub target: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SessionChrome {
    pub status: String,
    pub status_label: String,
    pub busy: bool,
    pub enabled: bool,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub mode_label: Option<String>,
    pub can_run_shell: bool,
    pub queued: u32,
}

impl From<wd_native::vm::session_chrome::SessionChrome> for SessionChrome {
    fn from(c: wd_native::vm::session_chrome::SessionChrome) -> Self {
        Self {
            status: c.status,
            status_label: c.status_label,
            busy: c.busy,
            enabled: c.enabled,
            model: c.model,
            permission_mode: c.permission_mode,
            mode_label: c.mode_label,
            can_run_shell: c.can_run_shell,
            queued: c.queued,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ComposerTrigger {
    Enter,
    Leave,
    Pass,
}

#[derive(uniffi::Object)]
pub struct Session {
    inner: Mutex<LiveSession>,
    viewport: Mutex<Viewport>,
}

impl Session {
    fn live(&self) -> MutexGuard<'_, LiveSession> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // Every input hands back what it caused, so a host never pays a second crossing to drain, and never forgets to.
    fn act(&self, action: impl FnOnce(&mut LiveSession)) -> Vec<Effect> {
        let mut live = self.live();
        action(&mut live);
        live.take_effects().into_iter().map(Effect::from).collect()
    }
}

fn parse<T: serde::de::DeserializeOwned>(json: Option<String>) -> Option<T> {
    serde_json::from_str(&json?).ok()
}

#[uniffi::export]
impl Session {
    #[uniffi::constructor]
    pub fn new(after_seq: i64, reconnect: bool, nonce: String, metrics: Metrics) -> Arc<Self> {
        let live = LiveSession::new(after_seq, reconnect, nonce, metrics.into());
        Arc::new(Session { inner: Mutex::new(live), viewport: Mutex::new(Viewport::default()) })
    }

    pub fn take_effects(&self) -> Vec<Effect> {
        self.live().take_effects().into_iter().map(Effect::from).collect()
    }

    pub fn opened(&self) -> Vec<Effect> {
        self.act(|live| live.opened())
    }

    pub fn received(&self, text: String, now: f64) -> Vec<Effect> {
        self.act(|live| live.received(&text, now))
    }

    // Frames that arrived together, newline-separated: one crossing instead of one per frame during a replay.
    pub fn received_batch(&self, frames: String, now: f64) -> Vec<Effect> {
        self.act(|live| {
            for frame in frames.split('\n').filter(|frame| !frame.is_empty()) {
                live.received(frame, now);
            }
        })
    }

    pub fn closed(&self, now: f64) -> Vec<Effect> {
        self.act(|live| live.closed(now))
    }

    pub fn send_done(&self, id: u64, ok: bool) -> Vec<Effect> {
        self.act(|live| live.send_done(id, ok))
    }

    pub fn tick(&self, now: f64) -> Vec<Effect> {
        self.act(|live| live.tick(now))
    }

    pub fn set_wall_clock(&self, now_ms: f64) -> Vec<Effect> {
        self.act(|live| live.set_wall_clock(now_ms))
    }

    pub fn resize(&self, metrics: Metrics) -> Vec<Effect> {
        self.act(|live| live.resize(metrics.into()))
    }

    pub fn set_hide_thinking(&self, hide: bool) -> Vec<Effect> {
        self.act(|live| live.set_hide_thinking(hide))
    }

    pub fn set_navigation(&self, subagents: bool, shells: bool) -> Vec<Effect> {
        self.act(|live| live.set_navigation(Navigation { subagents, shells }))
    }

    pub fn set_recap(&self, boundary: Option<u32>, since_ms: Option<f64>) -> Vec<Effect> {
        self.act(|live| live.set_recap(boundary.map(|b| b as usize), since_ms))
    }

    pub fn expand_everything(&self) -> Vec<Effect> {
        self.act(|live| live.expand_everything())
    }

    pub fn press_line(&self, row: u32, line: u32) -> Vec<Effect> {
        self.act(|live| live.press_line(row as usize, line as usize))
    }

    // The answer to an `Effect::Request`; status 0 when the request got no answer.
    pub fn responded(&self, id: u64, status: u16, body: String) -> Vec<Effect> {
        self.act(|live| live.responded(id, status, &body))
    }

    pub fn send(&self, text: String, attachment_ids: Vec<String>) -> Vec<Effect> {
        self.act(|live| live.send(text, attachment_ids))
    }

    pub fn approve(&self, request_id: String, updated_input_json: Option<String>) -> Vec<Effect> {
        self.act(|live| live.approve(request_id, parse(updated_input_json)))
    }

    pub fn deny(&self, request_id: String, message: Option<String>, interrupt: Option<bool>) -> Vec<Effect> {
        self.act(|live| live.deny(request_id, message, interrupt))
    }

    // The answers ride on an allow: `selections[i]` answers question `i` of the prompt.
    pub fn answer(&self, request_id: String, selections: Vec<Selection>) -> Vec<Effect> {
        let selections: Vec<_> = selections.into_iter().map(Into::into).collect();
        self.act(|live| live.answer(request_id, &selections))
    }

    pub fn dismiss_question(&self, request_id: String) -> Vec<Effect> {
        self.act(|live| live.dismiss_question(request_id))
    }

    pub fn prompt(&self) -> Option<Prompt> {
        self.live().prompt().map(Prompt::from)
    }

    // A plan prompt's markdown, laid out at the session's metrics, in the `transcript_lines` shape (one row).
    pub fn prompt_plan_lines(&self) -> Vec<u8> {
        snapshot::lines_block(&self.live().prompt_plan_lines())
    }

    pub fn interrupt(&self) -> Vec<Effect> {
        self.act(|live| live.interrupt())
    }

    pub fn clear_context(&self) -> Vec<Effect> {
        self.act(|live| live.clear_context())
    }

    pub fn sleep(&self) -> Vec<Effect> {
        self.act(|live| live.sleep())
    }

    pub fn background_task(&self, tool_use_id: Option<String>) -> Vec<Effect> {
        self.act(|live| live.background_task(tool_use_id))
    }

    pub fn run_shell(&self, command: String) -> Vec<Effect> {
        self.act(|live| live.run_shell(command))
    }

    pub fn set_permission_mode(&self, mode: Mode) -> Vec<Effect> {
        self.act(|live| live.set_permission_mode(mode.into()))
    }

    pub fn set_model(&self, model: Option<String>) -> Vec<Effect> {
        self.act(|live| live.set_model(model))
    }

    pub fn set_effort(&self, effort: Option<String>) -> Vec<Effect> {
        self.act(|live| live.set_effort(effort))
    }

    pub fn close_session(&self) -> Vec<Effect> {
        self.act(|live| live.close_session())
    }

    pub fn reconnect_now(&self) -> Vec<Effect> {
        self.act(|live| live.reconnect_now())
    }

    pub fn detach(&self) -> Vec<Effect> {
        self.act(|live| live.detach())
    }

    pub fn connection(&self) -> ConnectionState {
        match self.live().connection() {
            live::ConnectionState::Connecting => ConnectionState::Connecting,
            live::ConnectionState::Live => ConnectionState::Live,
            live::ConnectionState::Reconnecting => ConnectionState::Reconnecting,
            live::ConnectionState::Offline => ConnectionState::Offline,
            live::ConnectionState::Unreachable => ConnectionState::Unreachable,
        }
    }

    pub fn replay_progress(&self) -> Option<ReplayProgress> {
        self.live().replay_progress().map(|(seq, target)| ReplayProgress { seq, target })
    }

    // The session's name as every list draws it: its title, else the head of its id.
    pub fn session_title(&self) -> Option<String> {
        self.live().session_info().map(wd_native::vm::session_list::session_label)
    }

    pub fn session_info_json(&self) -> Option<String> {
        self.live().session_info().and_then(|info| serde_json::to_string(info).ok())
    }

    pub fn can_run_shell(&self) -> bool {
        self.live().can_run_shell()
    }

    pub fn protocol_mismatch(&self) -> Option<i64> {
        self.live().protocol_mismatch()
    }

    pub fn take_protocol_error(&self) -> Option<String> {
        self.live().take_protocol_error()
    }

    pub fn init_model(&self) -> Option<String> {
        self.live().init_model().map(str::to_owned)
    }

    pub fn item_for_seq(&self, seq: i64) -> Option<u32> {
        self.live().item_for_seq(seq).map(|i| i as u32)
    }

    pub fn row_for_item(&self, item: u32) -> u32 {
        self.live().view().row_index_for_item(item as usize) as u32
    }

    pub fn is_finished(&self) -> bool {
        self.live().is_finished()
    }

    pub fn queued(&self) -> u32 {
        self.live().queued() as u32
    }

    pub fn chrome(&self) -> SessionChrome {
        self.live().chrome().into()
    }

    pub fn transcript_layout(&self) -> Vec<u8> {
        snapshot::transcript_layout(self.live().view())
    }

    pub fn transcript_lines(&self, start: u32, end: u32) -> Vec<u8> {
        snapshot::transcript_lines(self.live().view(), start as usize, end as usize)
    }

    // The rows on screen, `first..=last`; answers lines (as `transcript_lines` does) only when the held window moved.
    pub fn show_rows(&self, first: u32, last: u32) -> Option<Vec<u8>> {
        let mut viewport = self.viewport.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let live = self.live();
        let rows = viewport.show(first as usize, last as usize, live.view().rows().len())?;
        Some(snapshot::transcript_lines(live.view(), rows.start, rows.end))
    }

    // The lines of the held window, re-read after `Changed.transcript`; at the tail the window follows new rows.
    pub fn viewport_lines(&self) -> Vec<u8> {
        let mut viewport = self.viewport.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let live = self.live();
        let rows = viewport.window(live.view().rows().len());
        snapshot::transcript_lines(live.view(), rows.start, rows.end)
    }

    // The layout and the lines of `start..end` in one crossing: what a redraw needs.
    pub fn transcript_frame(&self, start: u32, end: u32) -> Vec<u8> {
        let live = self.live();
        let mut bytes = snapshot::transcript_layout(live.view());
        bytes.extend(snapshot::transcript_lines(live.view(), start as usize, end as usize));
        bytes
    }

    pub fn open_frame(&self, task_id: String) -> Vec<Effect> {
        self.act(|live| live.open_frame(&task_id))
    }

    pub fn close_frame(&self, task_id: String) -> Vec<Effect> {
        self.act(|live| live.close_frame(&task_id))
    }

    pub fn frame_press_line(&self, task_id: String, row: u32, line: u32) -> Vec<Effect> {
        self.act(|live| live.frame_press_line(&task_id, row as usize, line as usize))
    }

    pub fn frame_expand_everything(&self, task_id: String) -> Vec<Effect> {
        self.act(|live| live.frame_expand_everything(&task_id))
    }

    pub fn frame_layout(&self, task_id: String) -> Option<Vec<u8>> {
        self.live().frame(&task_id).map(snapshot::transcript_layout)
    }

    pub fn frame_lines(&self, task_id: String, start: u32, end: u32) -> Option<Vec<u8>> {
        self.live().frame(&task_id).map(|frame| snapshot::transcript_lines(frame, start as usize, end as usize))
    }

    pub fn open_shell(&self, shell_id: String, shell_json: Option<String>, cols: u32, rows: u32) -> Vec<Effect> {
        let shell: Option<ShellInfo> = parse(shell_json);
        self.act(|live| live.open_shell(&shell_id, shell, cols, rows))
    }

    pub fn close_shell(&self, shell_id: String) -> Vec<Effect> {
        self.act(|live| live.close_shell(&shell_id))
    }

    pub fn shell_resize(&self, shell_id: String, cols: u32, rows: u32) -> Vec<Effect> {
        self.act(|live| live.shell_resize(&shell_id, cols, rows))
    }

    pub fn shell_key(&self, shell_id: String, key: Key) -> Vec<Effect> {
        self.act(|live| {
            if let Some(key) = key.vt() {
                live.shell_key(&shell_id, key);
            }
        })
    }

    pub fn shell_text(&self, shell_id: String, text: String) -> Vec<Effect> {
        self.act(|live| live.shell_text(&shell_id, &text))
    }

    pub fn shell_paste(&self, shell_id: String, text: String) -> Vec<Effect> {
        self.act(|live| live.shell_paste(&shell_id, &text))
    }

    pub fn kill_shell(&self, shell_id: String) -> Vec<Effect> {
        self.act(|live| live.kill_shell(&shell_id))
    }

    pub fn shell_grid(&self, shell_id: String, start: u32, count: u32) -> Option<Vec<u8>> {
        self.live().shell(&shell_id).map(|shell| snapshot::shell_grid(shell, start as usize, count as usize))
    }
}

// A line's `tone` / `gutterTone` / `band` byte indexes these, so a palette keys on the name and never mirrors the order.
#[uniffi::export]
pub fn tone_names() -> Vec<String> {
    planner::Tone::ALL.iter().map(|t| t.raw().to_owned()).collect()
}

#[uniffi::export]
pub fn band_names() -> Vec<String> {
    planner::Band::ALL.iter().map(|b| b.raw().to_owned()).collect()
}

#[uniffi::export]
pub fn snapshot_version() -> u8 {
    snapshot::VERSION
}

#[uniffi::export]
pub fn normalize_base_url(raw: String) -> String {
    wd_native::vm::gateway::normalize_base_url(&raw)
}

#[uniffi::export]
pub fn api_base(base_url: String) -> String {
    wd_native::vm::gateway::api_base(&base_url)
}

#[uniffi::export]
pub fn socket_url(base_url: String, session_id: String, after_seq: i64) -> String {
    wd_native::vm::gateway::socket_url(&base_url, &session_id, after_seq)
}

#[uniffi::export]
pub fn gateway_name(base_url: String) -> String {
    wd_native::vm::gateway::gateway_name(&base_url)
}

#[uniffi::export]
pub fn cleartext_refusal(base_url: String) -> Option<String> {
    wd_native::vm::gateway::cleartext_refusal(&base_url)
}

#[uniffi::export]
pub fn classify_answer(status: u16, content_type: Option<String>) -> Option<String> {
    wd_native::vm::gateway::classify_answer(status, content_type.as_deref())
}

#[uniffi::export]
pub fn friendly_model(id: Option<String>) -> Option<String> {
    wd_native::vm::model_name::friendly_model(id.as_deref())
}

#[uniffi::export]
pub fn ago(epoch_ms: f64, now_ms: f64) -> String {
    wd_native::vm::fmt::ago(epoch_ms, now_ms)
}

#[uniffi::export]
pub fn composer_trigger(character: String, is_shell_mode: bool, can_run_shell: bool) -> ComposerTrigger {
    use wd_native::controller::shell::{self, ComposerTrigger as Core};
    match shell::composer_trigger(&character, is_shell_mode, can_run_shell) {
        Core::Enter => ComposerTrigger::Enter,
        Core::Leave => ComposerTrigger::Leave,
        Core::Pass => ComposerTrigger::Pass,
    }
}

#[uniffi::export]
pub fn exit_draft(draft: String) -> String {
    wd_native::controller::shell::exit_draft(&draft)
}
