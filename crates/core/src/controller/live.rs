use crate::controller::replay::{ReplayHold, initial_replay_target};
use crate::controller::seq_index::TranscriptSeqIndex;
use crate::controller::session::{self as connection, SessionConnection, Signal};
use crate::controller::shell::{ShellAction, ShellSession};
use crate::controller::transcript::{self as view, Navigation, TranscriptView, Update};
use crate::expansion::TermPress;
use crate::planner::Metrics;
use crate::protocol::{AttachedFrame, Body, Event};
use crate::rest::{PermissionMode, SessionInfo, ShellInfo};
use crate::transcript::{
    Item, TranscriptState, apply_event, hydrate_shell_output, hydrate_shell_row, hydrate_tool_result, seed_from_session_info,
};
use crate::vt::VtKey;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub const OFFLINE_AFTER_ATTEMPTS: u32 = 3;
pub const PROGRESS_INTERVAL_SECONDS: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Live,
    Reconnecting,
    Offline,
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Changed {
    pub transcript: bool,
    pub chrome: bool,
    pub progress: bool,
    pub shells: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open { after_seq: i64 },
    Send { id: u64, text: String },
    Close,
    WakeAt(f64),
    FetchResult { call_id: String },
    FetchShellOutput { shell_id: String },
    VerifyShell { shell_id: String },
    KillShell { shell_id: String },
    OpenSubagent { task_id: String },
    OpenShell { shell_id: String },
    Changed(Changed),
}

pub struct LiveSession {
    conn: SessionConnection,
    state: TranscriptState,
    buffer: Option<TranscriptState>,
    hold: Option<ReplayHold>,
    progress: Option<(i64, i64)>,
    progress_published_at: f64,
    seq_index: TranscriptSeqIndex,
    view: TranscriptView,
    connection: ConnectionState,
    attached: Option<Box<AttachedFrame>>,
    protocol_mismatch: Option<i64>,
    protocol_error: Option<String>,
    init_model: Option<String>,
    verifying: HashSet<String>,
    shells: HashMap<String, ShellSession>,
    hide_thinking: bool,
    navigation: Navigation,
    metrics: Metrics,
    dirty: bool,
    now: f64,
    now_ms: f64,
    wake: Option<f64>,
    changed: Changed,
    finished: bool,
    effects: Vec<Effect>,
}

impl LiveSession {
    pub fn new(after_seq: i64, reconnect: bool, nonce: String, metrics: Metrics) -> Self {
        let mut session = LiveSession {
            conn: SessionConnection::new(after_seq, reconnect, nonce),
            state: TranscriptState::default(),
            buffer: None,
            hold: None,
            progress: None,
            progress_published_at: 0.0,
            seq_index: TranscriptSeqIndex::new(),
            view: TranscriptView::new(metrics, None),
            connection: ConnectionState::Connecting,
            attached: None,
            protocol_mismatch: None,
            protocol_error: None,
            init_model: None,
            verifying: HashSet::new(),
            shells: HashMap::new(),
            hide_thinking: false,
            navigation: Navigation::default(),
            metrics,
            dirty: false,
            now: 0.0,
            now_ms: 0.0,
            wake: None,
            changed: Changed::default(),
            finished: false,
            effects: Vec::new(),
        };
        session.pump();
        session
    }

    pub fn state(&self) -> &TranscriptState {
        &self.state
    }

    pub fn view(&self) -> &TranscriptView {
        &self.view
    }

    pub fn connection(&self) -> ConnectionState {
        self.connection
    }

    pub fn replaying(&self) -> bool {
        self.hold.is_some()
    }

    pub fn replay_progress(&self) -> Option<(i64, i64)> {
        self.progress
    }

    pub fn session_info(&self) -> Option<&SessionInfo> {
        self.attached.as_ref().map(|frame| &frame.session)
    }

    pub fn can_run_shell(&self) -> bool {
        self.attached.as_ref().is_some_and(|frame| frame.shell == Some(true))
    }

    pub fn protocol_mismatch(&self) -> Option<i64> {
        self.protocol_mismatch
    }

    pub fn take_protocol_error(&mut self) -> Option<String> {
        self.protocol_error.take()
    }

    pub fn init_model(&self) -> Option<&str> {
        self.init_model.as_deref()
    }

    pub fn item_for_seq(&self, seq: i64) -> Option<usize> {
        self.seq_index.item_for_seq(seq)
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn queued(&self) -> usize {
        self.conn.queued()
    }

    pub fn shell(&self, shell_id: &str) -> Option<&ShellSession> {
        self.shells.get(shell_id)
    }

    // Drained after every call. Folds whatever changed into one view update and one `Changed`.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        self.settle();
        std::mem::take(&mut self.effects)
    }

    pub fn opened(&mut self) {
        self.conn.opened();
        self.pump();
    }

    pub fn received(&mut self, text: &str, now: f64) {
        self.now = now;
        self.conn.received(text);
        self.pump();
    }

    pub fn closed(&mut self, now: f64) {
        self.now = now;
        self.conn.closed(now);
        self.pump();
    }

    pub fn send_done(&mut self, id: u64, ok: bool) {
        self.conn.send_done(id, ok);
        self.pump();
    }

    pub fn tick(&mut self, now: f64) {
        self.now = now;
        self.conn.tick(now);
        if self.hold.is_some_and(|hold| hold.expired(now)) {
            self.end_hold();
        }
        self.pump();
    }

    pub fn set_wall_clock(&mut self, now_ms: f64) {
        self.now_ms = now_ms;
    }

    pub fn resize(&mut self, metrics: Metrics) {
        if self.metrics != metrics {
            self.metrics = metrics;
            self.dirty = true;
        }
    }

    pub fn set_hide_thinking(&mut self, hide: bool) {
        if self.hide_thinking != hide {
            self.hide_thinking = hide;
            self.dirty = true;
        }
    }

    pub fn set_navigation(&mut self, navigation: Navigation) {
        self.navigation = navigation;
    }

    pub fn set_recap(&mut self, boundary: Option<usize>, since_ms: Option<f64>) {
        self.view.set_recap(boundary, since_ms);
        self.dirty = true;
    }

    pub fn expand_everything(&mut self) {
        self.view.expand_everything();
        self.changed.transcript = true;
    }

    pub fn press(&mut self, press: &TermPress, row: usize) {
        let effects = self.view.press(press, row, self.navigation);
        self.changed.transcript = true;
        for effect in effects {
            self.effects.push(match effect {
                view::Effect::FetchResult { call_id } => Effect::FetchResult { call_id },
                view::Effect::FetchShellOutput { shell_id } => Effect::FetchShellOutput { shell_id },
                view::Effect::KillShell { shell_id } => Effect::KillShell { shell_id },
                view::Effect::OpenSubagent { task_id } => Effect::OpenSubagent { task_id },
                view::Effect::OpenShell { shell_id } => Effect::OpenShell { shell_id },
            });
        }
    }

    // `None` is a failed fetch: the row returns to its head and a later press may try again.
    pub fn result_fetched(&mut self, call_id: &str, text: Option<&str>) {
        match text {
            Some(text) => self.hydrate(|state| hydrate_tool_result(state, call_id, text)),
            None => {
                self.view.fetch_failed(call_id);
                self.changed.transcript = true;
            }
        }
    }

    pub fn shell_output_fetched(&mut self, shell_id: &str, text: &str) {
        self.hydrate(|state| hydrate_shell_output(state, shell_id, text));
    }

    // `None` is the 404: the gateway no longer knows the shell, so the row stops claiming it runs.
    pub fn shell_verified(&mut self, shell_id: &str, shell: Option<Value>) {
        self.verifying.remove(shell_id);
        if let Some(open) = self.shells.get_mut(shell_id) {
            open.set_record(shell.clone().and_then(|shell| serde_json::from_value::<ShellInfo>(shell).ok()));
            self.changed.shells = true;
        }
        let shell = shell.map(Arc::new);
        self.hydrate(|state| hydrate_shell_row(state, shell_id, shell.clone()));
    }

    pub fn send(&mut self, text: String, attachment_ids: Vec<String>) {
        self.act(|c| c.send(text, attachment_ids));
    }

    pub fn approve(&mut self, request_id: String, updated_input: Option<Map<String, Value>>) {
        self.act(|c| c.approve(request_id, updated_input));
    }

    pub fn deny(&mut self, request_id: String, message: Option<String>, interrupt: Option<bool>) {
        self.act(|c| c.deny(request_id, message, interrupt));
    }

    pub fn interrupt(&mut self) {
        self.act(SessionConnection::interrupt);
    }

    pub fn clear_context(&mut self) {
        self.act(SessionConnection::clear_context);
    }

    pub fn sleep(&mut self) {
        self.act(SessionConnection::sleep);
    }

    pub fn background_task(&mut self, tool_use_id: Option<String>) {
        self.act(|c| c.background_task(tool_use_id));
    }

    pub fn run_shell(&mut self, command: String) {
        self.act(|c| c.run_shell(command));
    }

    // Opening a screen subscribes this socket to the PTY; the `shell_attached` answer and every `shell_output`
    // after it land in the shell's emulator inside the core, never on the platform.
    pub fn open_shell(&mut self, shell_id: &str, shell: Option<ShellInfo>, cols: u32, rows: u32) {
        self.shells.entry(shell_id.to_owned()).or_insert_with(|| ShellSession::new(shell_id.to_owned(), shell, cols, rows));
        self.shell_act(shell_id, ShellSession::start);
        self.changed.shells = true;
        self.pump();
    }

    pub fn close_shell(&mut self, shell_id: &str) {
        self.shell_act(shell_id, ShellSession::stop);
        if self.shells.remove(shell_id).is_some() {
            self.changed.shells = true;
        }
        self.pump();
    }

    pub fn shell_resize(&mut self, shell_id: &str, cols: u32, rows: u32) {
        self.shell_act(shell_id, |shell| shell.resize(cols, rows));
        self.pump();
    }

    pub fn shell_key(&mut self, shell_id: &str, key: VtKey) {
        self.shell_act(shell_id, |shell| shell.key(key));
        self.pump();
    }

    pub fn shell_text(&mut self, shell_id: &str, text: &str) {
        self.shell_act(shell_id, |shell| shell.text(text));
        self.pump();
    }

    pub fn shell_paste(&mut self, shell_id: &str, text: &str) {
        self.shell_act(shell_id, |shell| shell.paste(text));
        self.pump();
    }

    pub fn kill_shell(&mut self, shell_id: &str) {
        self.effects.push(Effect::KillShell { shell_id: shell_id.to_owned() });
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.act(|c| c.set_permission_mode(mode));
    }

    pub fn set_model(&mut self, model: Option<String>) {
        self.act(|c| c.set_model(model));
    }

    pub fn set_effort(&mut self, effort: Option<String>) {
        self.act(|c| c.set_effort(effort));
    }

    pub fn close_session(&mut self) {
        self.act(SessionConnection::close_session);
    }

    pub fn reconnect_now(&mut self) {
        self.act(SessionConnection::reconnect_now);
    }

    pub fn detach(&mut self) {
        self.act(SessionConnection::detach);
        self.end_hold();
    }

    fn act(&mut self, action: impl FnOnce(&mut SessionConnection)) {
        action(&mut self.conn);
        self.pump();
    }

    // Never pumps: it also runs inside `signal`, whose caller is already pumping.
    fn shell_act(&mut self, shell_id: &str, action: impl FnOnce(&mut ShellSession) -> Option<ShellAction>) {
        let Some(shell) = self.shells.get_mut(shell_id) else { return };
        let before = shell.revision();
        let action = action(shell);
        self.changed.shells |= shell.revision() != before;
        let Some(action) = action else { return };
        let id = shell_id.to_owned();
        match action {
            ShellAction::Attach { cols, rows } => self.conn.attach_shell(id, cols, rows),
            ShellAction::Write(data) => self.conn.write_shell(&id, &data),
            ShellAction::Resize { cols, rows } => self.conn.resize_shell(id, cols, rows),
            ShellAction::Detach => self.conn.detach_shell(id),
        }
    }

    fn hydrate(&mut self, apply: impl Fn(&mut TranscriptState) -> bool) {
        self.dirty |= apply(&mut self.state);
        if let Some(buffer) = &mut self.buffer {
            apply(buffer);
        }
    }

    // Loops because a signal can act on the connection again (a stale attach resyncs it).
    fn pump(&mut self) {
        loop {
            let effects = self.conn.take_effects();
            let signals = self.conn.take_signals();
            if effects.is_empty() && signals.is_empty() {
                return;
            }
            for effect in effects {
                match effect {
                    connection::Effect::Open { after_seq } => self.effects.push(Effect::Open { after_seq }),
                    connection::Effect::Send { id, text } => self.effects.push(Effect::Send { id, text }),
                    connection::Effect::Close => self.effects.push(Effect::Close),
                    connection::Effect::WakeAt(_) => {}
                }
            }
            for signal in signals {
                self.signal(signal);
            }
        }
    }

    fn signal(&mut self, signal: Signal) {
        match signal {
            Signal::Attached(frame) => self.attach(frame),
            Signal::Event(event) => self.event(event),
            Signal::ConnectionChange(open) => {
                self.set_connection(if open { ConnectionState::Live } else { ConnectionState::Reconnecting });
                if open {
                    let ids: Vec<String> = self.shells.keys().cloned().collect();
                    for id in ids {
                        self.shell_act(&id, |shell| shell.reconnected());
                    }
                }
            }
            Signal::ReconnectAttempt(attempts) => {
                let down = attempts >= OFFLINE_AFTER_ATTEMPTS;
                self.set_connection(match (self.conn.ever_connected(), down) {
                    (true, true) => ConnectionState::Offline,
                    (true, false) => ConnectionState::Reconnecting,
                    (false, true) => ConnectionState::Unreachable,
                    (false, false) => ConnectionState::Connecting,
                });
            }
            Signal::ProtocolError(message) => {
                self.protocol_error = Some(message);
                self.changed.chrome = true;
            }
            Signal::ProtocolMismatch { server_version } => {
                self.protocol_mismatch = Some(server_version);
                self.changed.chrome = true;
            }
            Signal::ShellAttached(frame) => self.shell_act(&frame.shell_id, |shell| shell.attached(&frame)),
            Signal::ShellOutput { shell_id, data } => self.shell_act(&shell_id, |shell| shell.output(&data)),
            Signal::ShellDetached { shell_id, reason } => {
                if self.shells.contains_key(&shell_id) {
                    self.shell_act(&shell_id, |shell| {
                        shell.detached(reason);
                        None
                    });
                    self.verify(shell_id);
                }
            }
            Signal::Finished => {
                self.finished = true;
                self.changed.chrome = true;
            }
        }
    }

    fn set_connection(&mut self, state: ConnectionState) {
        if self.connection != state {
            self.connection = state;
            self.changed.chrome = true;
        }
    }

    // A gateway whose log restarted (a dormant wake) or was replaced answers a resume with a seq this client never
    // saw; the held transcript then belongs to another log and is dropped for a replay from zero.
    fn stale(&self, frame: &AttachedFrame) -> bool {
        let held = self.buffer.as_ref().unwrap_or(&self.state);
        if frame.replaying_from == 0 || held.last_seq == 0 {
            return false;
        }
        if frame.session.last_seq < held.last_seq {
            return true;
        }
        held.session.as_ref().is_some_and(|session| session.created_at != frame.session.created_at)
    }

    fn attach(&mut self, frame: Box<AttachedFrame>) {
        if self.stale(&frame) {
            self.end_hold();
            self.state = TranscriptState::default();
            self.seq_index = TranscriptSeqIndex::new();
            self.verifying.clear();
            self.dirty = true;
            self.conn.resync();
            return;
        }
        self.end_hold();
        seed_from_session_info(&mut self.state, &frame.session);
        self.dirty = true;
        self.changed.chrome = true;
        if let Some(target) = initial_replay_target(frame.replaying_from, frame.session.last_seq) {
            let hold = ReplayHold::new(target, self.state.last_seq, self.now);
            if !hold.landed() {
                self.hold = Some(hold);
                self.progress = Some((hold.seq, hold.target));
                self.progress_published_at = self.now;
                self.changed.progress = true;
            }
        }
        self.attached = Some(frame);
    }

    fn event(&mut self, event: Event) {
        match &event.body {
            Body::UserMessage(message) if message.replay => {
                if let Some(id) = running_shell(message.shell.as_deref()) {
                    self.verify(id);
                }
            }
            Body::SystemInit { model, .. } if self.init_model.is_none() => self.init_model = Some(model.clone()),
            _ => {}
        }
        let seq = event.seq;
        let Some(mut hold) = self.hold else {
            let before = self.state.items.clone();
            apply_event(&mut self.state, event);
            self.seq_index.note(seq, &before, &self.state.items);
            self.dirty = true;
            return;
        };
        if self.buffer.is_none() {
            self.buffer = Some(self.state.clone());
        }
        let buffer = self.buffer.as_mut().expect("buffer");
        let before = buffer.items.clone();
        apply_event(buffer, event);
        self.seq_index.note(seq, &before, &buffer.items);
        hold.advance(buffer.last_seq, self.now);
        self.hold = Some(hold);
        if hold.landed() {
            self.end_hold();
        } else if self.now - self.progress_published_at >= PROGRESS_INTERVAL_SECONDS {
            self.progress_published_at = self.now;
            self.progress = Some((hold.seq, hold.target));
            self.changed.progress = true;
        }
    }

    // Every exit goes through here (the stated seq, the stall backstop, a detach, a new attach): a buffer left
    // unpublished is a transcript that silently lost its history.
    fn end_hold(&mut self) {
        if self.hold.take().is_some() {
            self.progress = None;
            self.changed.progress = true;
        }
        let Some(buffer) = self.buffer.take() else { return };
        self.state = buffer;
        self.dirty = true;
        self.changed.chrome = true;
        let running: Vec<String> = self
            .state
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Shell(shell) => running_shell(Some(&shell.shell)),
                _ => None,
            })
            .collect();
        for id in running {
            self.verify(id);
        }
    }

    fn verify(&mut self, shell_id: String) {
        if self.verifying.insert(shell_id.clone()) {
            self.effects.push(Effect::VerifyShell { shell_id });
        }
    }

    fn update_view(&mut self) {
        let changed = self.view.update(Update {
            items: &self.state.items,
            metrics: self.metrics,
            pending_approvals: self.state.pending_approvals.len(),
            frame_task: None,
            hide_thinking: self.hide_thinking,
            now_ms: self.now_ms,
        });
        self.changed.transcript |= changed;
    }

    fn settle(&mut self) {
        if std::mem::take(&mut self.dirty) {
            self.update_view();
        }
        let wake = match (self.conn.wake_at(), self.hold.map(|hold| hold.deadline())) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if wake != self.wake {
            self.wake = wake;
            if let Some(at) = wake {
                self.effects.push(Effect::WakeAt(at));
            }
        }
        let changed = std::mem::take(&mut self.changed);
        if changed != Changed::default() {
            self.effects.push(Effect::Changed(changed));
        }
    }
}

fn running_shell(shell: Option<&Value>) -> Option<String> {
    let shell = shell?;
    (shell.get("status").and_then(Value::as_str) == Some("running")).then(|| shell.get("id")?.as_str().map(str::to_owned))?
}
