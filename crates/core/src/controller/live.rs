use crate::controller::replay::{ReplayHold, initial_replay_target};
use crate::controller::seq_index::TranscriptSeqIndex;
use crate::controller::session::{self as connection, SessionConnection, Signal};
use crate::controller::shell::{ShellAction, ShellSession};
use crate::controller::transcript::{self as view, Navigation, TranscriptView, Update};
use crate::expansion::TermPress;
use crate::planner::{Metrics, SubagentStripLine, TermLine, prompt_markdown, subagent_strip_line};
use crate::protocol::{AttachedFrame, Body, Event};
use crate::rest::{ModelOption, PermissionMode, SessionInfo, ShellInfo, encode_component, shell_record, tool_result_text};
use crate::row_menu::{RowMenu, row_menu};
use crate::rows::{subagent_items, subagent_task, tool_call_item_index};
use crate::scrubber::{Cluster, Peek};
use crate::transcript::{
    Item, TranscriptState, apply_event, hydrate_shell_output, hydrate_shell_row, hydrate_tool_result, seed_from_session_info,
};
use crate::vm::composer_lists::{Skill, SlashCommand, skills, slash_commands};
use crate::vm::pickers::{ModePicker, ModelPicker, PickerSource, mode_picker, model_picker};
use crate::vm::prompt::{Prompt, PromptBody, Selection, answered_input, prompt_for};
use crate::vm::session_chrome::{SessionChrome, session_chrome};
use crate::vm::session_list::subagent_label;
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
    pub frames: bool,
    pub prompt: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open { after_seq: i64 },
    Send { id: u64, text: String },
    Close,
    WakeAt(f64),
    // A REST call the platform answers with `responded`; `path` is under the session's own (`/sessions/:id`) when
    // `scoped`, else under the API base.
    Request { id: u64, method: &'static str, path: String, scoped: bool },
    OpenSubagent { task_id: String },
    OpenShell { shell_id: String },
    Changed(Changed),
}

#[derive(Debug, Clone, PartialEq)]
enum Pending {
    Result(String),
    ShellOutput(String),
    Verify(String),
    Kill(String),
    Catalog(String),
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
    requests: HashMap<u64, Pending>,
    next_request: u64,
    shells: HashMap<String, ShellSession>,
    frames: HashMap<String, TranscriptView>,
    hide_thinking: bool,
    navigation: Navigation,
    metrics: Metrics,
    dirty: bool,
    now: f64,
    now_ms: f64,
    wake: Option<f64>,
    changed: Changed,
    published_chrome: SessionChrome,
    published_prompt: Option<Prompt>,
    published_pickers: (ModelPicker, ModePicker),
    published_usage: UsageMark,
    published_lists: (usize, usize),
    sleep_sent_at: Option<i64>,
    catalog: Vec<ModelOption>,
    catalog_requested: bool,
    finished: bool,
    superseded_by: Option<String>,
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
            requests: HashMap::new(),
            next_request: 0,
            shells: HashMap::new(),
            frames: HashMap::new(),
            hide_thinking: false,
            navigation: Navigation::default(),
            metrics,
            dirty: false,
            now: 0.0,
            now_ms: 0.0,
            wake: None,
            changed: Changed::default(),
            published_chrome: SessionChrome::default(),
            published_prompt: None,
            published_pickers: Default::default(),
            published_usage: UsageMark::default(),
            published_lists: (0, 0),
            sleep_sent_at: None,
            catalog: Vec::new(),
            catalog_requested: false,
            finished: false,
            superseded_by: None,
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

    // The operator's rate overrides from the attach frame, for merging over the bundled table.
    pub fn pricing_overrides(&self) -> Option<&Value> {
        self.attached.as_ref().and_then(|frame| frame.pricing_overrides.as_ref())
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

    // The row holding a tool call, for a route that lands on it (a task line on the sessions list).
    pub fn row_for_tool_call(&self, tool_use_id: &str) -> Option<usize> {
        tool_call_item_index(&self.state.items, tool_use_id).map(|item| self.view.row_index_for_item(item))
    }

    // A long-press on a row: what it bookmarks, copies and moves to the background. `None` past the end.
    pub fn row_menu(&self, row: usize) -> Option<RowMenu> {
        self.view.row(row).map(|row| row_menu(row, self.can_background_tasks()))
    }

    pub fn frame_row_menu(&self, task_id: &str, row: usize) -> Option<RowMenu> {
        self.frames.get(task_id)?.row(row).map(|row| row_menu(row, self.can_background_tasks()))
    }

    // The overview rail of the session (`task_id` none) or a takeover. A takeover's rail draws no bookmarks, as on the web.
    pub fn scrubber(&self, task_id: Option<&str>, bookmarks: &[String], rail_h: f64, viewport_h: f64) -> Option<Vec<Cluster>> {
        let (view, bookmarks) = match task_id {
            Some(id) => (self.frames.get(id)?, &[][..]),
            None => (&self.view, bookmarks),
        };
        Some(view.scrubber(self.state.pending_approvals.len(), bookmarks, rail_h, viewport_h))
    }

    pub fn scrubber_peek(&self, task_id: Option<&str>, cluster: &Cluster, y: f64) -> Option<Peek> {
        let view = match task_id {
            Some(id) => self.frames.get(id)?,
            None => &self.view,
        };
        Some(view.scrubber_peek(cluster, y, self.state.pending_approvals.first().map(|request| &**request)))
    }

    fn can_background_tasks(&self) -> bool {
        self.state.capabilities.as_ref().is_some_and(|c| c.background_tasks == Some(true))
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    // The head of the approval queue: approvals are answered in order, so only the first is ever drawn.
    pub fn prompt(&self) -> Option<Prompt> {
        let pending = &self.state.pending_approvals;
        prompt_for(pending.first()?, pending.len())
    }

    pub fn prompt_plan_lines(&self) -> Vec<TermLine> {
        match self.prompt().map(|prompt| prompt.body) {
            Some(PromptBody::Permission { model, .. }) => model.plan.map(|plan| prompt_markdown(&plan, &self.metrics)).unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    pub fn chrome(&self) -> SessionChrome {
        let effort = self.picker_source().shown_effort();
        let mut chrome = session_chrome(&self.state, self.init_model(), self.can_run_shell(), self.queued() as u32, effort);
        chrome.can_sleep &= self.sleep_sent_at != Some(self.state.last_seq);
        chrome.archived = self.archived();
        chrome.enabled &= !chrome.archived;
        chrome.superseded_by = self.superseded_by.clone();
        chrome
    }

    pub fn archived(&self) -> bool {
        self.session_info().is_some_and(|info| info.archived == Some(true))
    }

    // The conversation that replaced this one: from the live `session_superseded`, or an archive attach naming it.
    pub fn superseded_by(&self) -> Option<&str> {
        self.superseded_by.as_deref()
    }

    pub fn commands(&self) -> Vec<SlashCommand> {
        slash_commands(self.state.commands.as_deref())
    }

    pub fn skills(&self) -> Vec<Skill> {
        skills(self.state.skills.as_deref())
    }

    fn lists_mark(&self) -> (usize, usize) {
        let mark = |list: &Option<Arc<Value>>| list.as_ref().map_or(0, |list| Arc::as_ptr(list) as usize);
        (mark(&self.state.commands), mark(&self.state.skills))
    }

    fn picker_source(&self) -> PickerSource<'_> {
        PickerSource { state: &self.state, init_model: self.init_model(), catalog: &self.catalog }
    }

    pub fn model_picker(&self) -> ModelPicker {
        model_picker(&self.picker_source())
    }

    // The mode the session reported when it attached stands in for the one it started on.
    pub fn mode_picker(&self) -> ModePicker {
        let info = self.session_info();
        mode_picker(&self.state, info.and_then(|info| info.permission_mode), info.and_then(|info| info.can_bypass_permissions))
    }

    pub fn queued(&self) -> usize {
        self.conn.queued()
    }

    pub fn shell(&self, shell_id: &str) -> Option<&ShellSession> {
        self.shells.get(shell_id)
    }

    pub fn frame(&self, task_id: &str) -> Option<&TranscriptView> {
        self.frames.get(task_id)
    }

    // A subagent's own transcript: the items it spawned, opened by the brief its task was given. Never a recap seam,
    // which is a full-transcript index. Folds with the session's metrics; a frame drawn at another width is a P3 call.
    pub fn open_frame(&mut self, task_id: &str) {
        if self.frames.contains_key(task_id) {
            return;
        }
        let mut frame = TranscriptView::new(self.metrics, Some(task_id.to_owned()));
        self.fold_frame(task_id, &mut frame);
        self.frames.insert(task_id.to_owned(), frame);
        self.changed.frames = true;
    }

    pub fn close_frame(&mut self, task_id: &str) {
        if self.frames.remove(task_id).is_some() {
            self.changed.frames = true;
        }
    }

    // The spawning call names the agent; the session's rollup may only name one the transcript does not have.
    pub fn frame_strip(&self, task_id: &str) -> SubagentStripLine {
        let items = subagent_items(&self.state.items, task_id);
        let task = subagent_task(&self.state.items, task_id);
        let fallback = self
            .session_info()
            .and_then(|info| info.subagents.as_deref()?.iter().find(|sub| sub.tool_use_id == task_id).map(subagent_label))
            .unwrap_or_else(|| "Sub-agent".to_owned());
        subagent_strip_line(task.as_deref(), &items, &fallback)
    }

    // No takeover from a takeover: a nested task inside a frame expands in place, as on the web.
    pub fn frame_press(&mut self, task_id: &str, press: &TermPress, row: usize) {
        let Some(frame) = self.frames.get_mut(task_id) else { return };
        let effects = frame.press(press, row, Navigation { subagents: false, ..self.navigation });
        self.changed.frames = true;
        self.push_view_effects(effects);
    }

    // A native renderer only knows a line was pressable; the core re-plans the row to recover what the press means.
    pub fn press_line(&mut self, row: usize, line: usize) {
        if let Some(press) = self.view.lines(row).get(line).and_then(|line| line.press.clone()) {
            self.press(&press, row);
        }
    }

    pub fn frame_press_line(&mut self, task_id: &str, row: usize, line: usize) {
        let press = self.frames.get(task_id).and_then(|frame| frame.lines(row).get(line)?.press.clone());
        if let Some(press) = press {
            self.frame_press(task_id, &press, row);
        }
    }

    pub fn frame_expand_everything(&mut self, task_id: &str) {
        if let Some(frame) = self.frames.get_mut(task_id) {
            frame.expand_everything();
            self.changed.frames = true;
        }
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
        self.push_view_effects(effects);
    }

    fn push_view_effects(&mut self, effects: Vec<view::Effect>) {
        for effect in effects {
            match effect {
                view::Effect::FetchResult { call_id } => self.request(Pending::Result(call_id)),
                view::Effect::FetchShellOutput { shell_id } => self.request(Pending::ShellOutput(shell_id)),
                view::Effect::KillShell { shell_id } => self.request(Pending::Kill(shell_id)),
                view::Effect::OpenSubagent { task_id } => self.effects.push(Effect::OpenSubagent { task_id }),
                view::Effect::OpenShell { shell_id } => self.effects.push(Effect::OpenShell { shell_id }),
            }
        }
    }

    fn request(&mut self, pending: Pending) {
        let mut scoped = true;
        let (method, path) = match &pending {
            Pending::Result(call_id) => {
                let Some(seq) = self.result_seq(call_id) else {
                    return self.result_fetched(call_id, None);
                };
                ("GET", format!("/events/{seq}/result?toolUseId={}&imageRefs=1", encode_component(call_id)))
            }
            Pending::ShellOutput(id) => ("GET", format!("/shells/{}/output?view=text", encode_component(id))),
            Pending::Verify(id) => ("GET", format!("/shells/{}", encode_component(id))),
            Pending::Kill(id) => ("POST", format!("/shells/{}/kill", encode_component(id))),
            Pending::Catalog(_) => {
                scoped = false;
                ("GET", "/profiles".to_owned())
            }
        };
        self.next_request += 1;
        self.requests.insert(self.next_request, pending);
        self.effects.push(Effect::Request { id: self.next_request, method, path, scoped });
    }

    // A 404 on a shell means the gateway no longer knows it; any other failure leaves the row as it was, and a
    // failed result fetch lets a later press try again. Status 0 is a request that got no answer at all.
    pub fn responded(&mut self, id: u64, status: u16, body: &str) {
        let Some(pending) = self.requests.remove(&id) else { return };
        let ok = (200..300).contains(&status);
        match pending {
            Pending::Result(call_id) => {
                let text = if ok { tool_result_text(body) } else { None };
                self.result_fetched(&call_id, text.as_deref());
            }
            Pending::ShellOutput(shell_id) if ok => self.shell_output_fetched(&shell_id, body),
            Pending::ShellOutput(shell_id) | Pending::Verify(shell_id) if status == 404 => self.shell_verified(&shell_id, None),
            Pending::Verify(shell_id) | Pending::Kill(shell_id) if ok => match shell_record(body) {
                Some(shell) => self.shell_verified(&shell_id, Some(shell)),
                None => {
                    self.verifying.remove(&shell_id);
                }
            },
            Pending::Verify(shell_id) => {
                self.verifying.remove(&shell_id);
            }
            Pending::ShellOutput(_) | Pending::Kill(_) => {}
            Pending::Catalog(profile) if ok => self.catalog = profile_models(body, &profile),
            Pending::Catalog(_) if status == 404 => {}
            Pending::Catalog(_) => self.catalog_requested = false,
        }
    }

    fn result_seq(&self, call_id: &str) -> Option<i64> {
        let states = std::iter::once(&self.state).chain(self.buffer.as_ref());
        states.flat_map(|state| state.items.iter()).find_map(|item| match item {
            Item::ToolCall(call) if &*call.id == call_id => call.result.as_ref().and_then(|result| result.source_seq),
            _ => None,
        })
    }

    // `None` is a failed fetch: the row returns to its head and a later press may try again.
    pub fn result_fetched(&mut self, call_id: &str, text: Option<&str>) {
        match text {
            Some(text) => self.hydrate(|state| hydrate_tool_result(state, call_id, text)),
            None => {
                self.view.fetch_failed(call_id);
                self.changed.transcript = true;
                for frame in self.frames.values_mut() {
                    frame.fetch_failed(call_id);
                }
                self.changed.frames |= !self.frames.is_empty();
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

    pub fn answer(&mut self, request_id: String, selections: &[Selection]) {
        let Some(request) = self.state.pending_approvals.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(request_id.as_str()))
        else {
            return;
        };
        let Some(Prompt { body: PromptBody::Question { questions, .. }, .. }) = prompt_for(request, 1) else {
            return;
        };
        let updated = answered_input(request.get("input").unwrap_or(&Value::Null), &questions, selections);
        self.approve(request_id, Some(updated));
    }

    pub fn dismiss_question(&mut self, request_id: String) {
        self.deny(request_id, Some("Question dismissed by user".into()), None);
    }

    pub fn interrupt(&mut self) {
        self.act(SessionConnection::interrupt);
    }

    pub fn clear_context(&mut self) {
        self.act(SessionConnection::clear_context);
    }

    // Sleep stays off until the session answers: the next event either moves the status or puts the engine asleep.
    pub fn sleep(&mut self) {
        self.sleep_sent_at = Some(self.state.last_seq);
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
        self.shell_act(shell_id, |shell| {
            shell.follow();
            shell.key(key)
        });
        self.pump();
    }

    // Scrolling is a view change only: no frame goes out, the platform re-reads the window after it.
    pub fn shell_scroll(&mut self, shell_id: &str, lines: i64) {
        if let Some(shell) = self.shells.get_mut(shell_id) {
            shell.scroll(lines);
        }
    }

    pub fn shell_text(&mut self, shell_id: &str, text: &str) {
        self.shell_act(shell_id, |shell| {
            shell.follow();
            shell.text(text)
        });
        self.pump();
    }

    pub fn shell_paste(&mut self, shell_id: &str, text: &str) {
        self.shell_act(shell_id, |shell| {
            shell.follow();
            shell.paste(text)
        });
        self.pump();
    }

    pub fn kill_shell(&mut self, shell_id: &str) {
        self.request(Pending::Kill(shell_id.to_owned()));
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
        let held = held.session.as_deref();
        if frame.session.archived == Some(true) && held.and_then(|session| session.archived) != Some(true) {
            return true;
        }
        let epoch = held.and_then(|session| session.epoch);
        if frame.session.epoch.is_some() && epoch.is_some() && frame.session.epoch != epoch {
            return true;
        }
        held.is_some_and(|session| session.created_at != frame.session.created_at)
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
        if frame.session.archived == Some(true)
            && let Some(successor) = &frame.session.superseded_by
        {
            self.superseded_by = Some(successor.clone());
        }
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
        if !self.catalog_requested
            && let Some(profile) = frame.session.profile.clone()
        {
            self.catalog_requested = true;
            self.request(Pending::Catalog(profile));
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
            Body::SessionSuperseded(successor) => {
                self.superseded_by = Some(successor.clone());
                self.changed.chrome = true;
            }
            _ => {}
        }
        let seq = event.seq;
        let Some(mut hold) = self.hold else {
            apply_event(&mut self.state, event);
            self.seq_index.observe(seq, &self.state.items);
            self.dirty = true;
            return;
        };
        if self.buffer.is_none() {
            self.buffer = Some(self.state.clone());
        }
        let buffer = self.buffer.as_mut().expect("buffer");
        apply_event(buffer, event);
        self.seq_index.observe(seq, &buffer.items);
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
            self.request(Pending::Verify(shell_id));
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
        let mut frames = std::mem::take(&mut self.frames);
        for (task_id, frame) in &mut frames {
            self.changed.frames |= self.fold_frame(task_id, frame);
        }
        self.frames = frames;
    }

    fn fold_frame(&self, task_id: &str, frame: &mut TranscriptView) -> bool {
        let items = subagent_items(&self.state.items, task_id);
        let task = subagent_task(&self.state.items, task_id);
        frame.update(Update {
            items: &items,
            metrics: self.metrics,
            pending_approvals: self.state.pending_approvals.len(),
            frame_task: task.as_deref(),
            hide_thinking: self.hide_thinking,
            now_ms: self.now_ms,
        })
    }

    fn settle(&mut self) {
        if std::mem::take(&mut self.dirty) {
            self.update_view();
        }
        let chrome = self.chrome();
        if chrome != self.published_chrome {
            self.published_chrome = chrome;
            self.changed.chrome = true;
        }
        let usage = UsageMark::of(&self.state);
        if usage != self.published_usage {
            self.published_usage = usage;
            self.changed.chrome = true;
        }
        let lists = self.lists_mark();
        if lists != self.published_lists {
            self.published_lists = lists;
            self.changed.chrome = true;
        }
        let pickers = (self.model_picker(), self.mode_picker());
        if pickers != self.published_pickers {
            self.published_pickers = pickers;
            self.changed.chrome = true;
        }
        let prompt = self.prompt();
        if prompt != self.published_prompt {
            self.published_prompt = prompt;
            self.changed.prompt = true;
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

// The models a profile's catalog lists, from `GET /profiles`; a 404 or an unknown shape is no catalog.
// What the meters read, so a context or rate-limit event that draws no row still tells the platform to re-read them.
#[derive(Debug, Clone, PartialEq, Default)]
struct UsageMark {
    context: Option<(i64, i64, u64)>,
    limits: (usize, Option<u64>),
    cost: (u64, Option<u64>),
    plan: Option<String>,
}

impl UsageMark {
    fn of(state: &TranscriptState) -> Self {
        UsageMark {
            context: state.context_usage.as_ref().map(|c| (c.total_tokens, c.max_tokens, c.percentage.to_bits())),
            limits: (state.rate_limits.len(), state.rate_limits_updated_at.map(f64::to_bits)),
            cost: (state.total_cost_usd.to_bits(), state.cost_usd.map(f64::to_bits)),
            plan: state.subscription_type.clone(),
        }
    }
}

fn profile_models(body: &str, profile: &str) -> Vec<ModelOption> {
    let Ok(answer) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    let profiles = answer.get("profiles").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let models =
        profiles.iter().find(|row| row.get("name").and_then(Value::as_str) == Some(profile)).and_then(|row| row.get("models")?.as_array());
    models.map(|rows| rows.iter().filter_map(|row| serde_json::from_value(row.clone()).ok()).collect()).unwrap_or_default()
}

fn running_shell(shell: Option<&Value>) -> Option<String> {
    let shell = shell?;
    (shell.get("status").and_then(Value::as_str) == Some("running")).then(|| shell.get("id")?.as_str().map(str::to_owned))?
}
