use crate::protocol::{
    AttachedFrame, ClientFrame, Event, Frame, PROTOCOL_VERSION, PermissionBehavior, SHELL_INPUT_MAX, ShellAttachedFrame, decode_frame,
};
use crate::rest::PermissionMode;
use serde_json::{Map, Value};
use std::collections::VecDeque;
use unicode_segmentation::UnicodeSegmentation;

pub const TOOL_CALL_REFUSAL: &str =
    "This client cannot execute bridged tool calls: it has no sandbox. Run the tool server-side, or attach a browser client to host it.";
pub const MAX_BACKOFF_SECONDS: f64 = 10.0;

pub fn backoff_seconds(retries: u32) -> f64 {
    (0.5 * 2f64.powi(retries.min(32) as i32)).min(MAX_BACKOFF_SECONDS)
}

pub fn chunk(data: &str, max: usize) -> Vec<&str> {
    if data.len() <= max {
        return vec![data];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    for (index, grapheme) in data.grapheme_indices(true) {
        if index + grapheme.len() - start > max && index > start {
            chunks.push(&data[start..index]);
            start = index;
        }
    }
    if start < data.len() {
        chunks.push(&data[start..]);
    }
    chunks
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open { after_seq: i64 },
    Send { id: u64, text: String },
    Close,
    WakeAt(f64),
}

pub enum Signal {
    Attached(Box<AttachedFrame>),
    Event(Event),
    ConnectionChange(bool),
    ReconnectAttempt(u32),
    ProtocolError(String),
    ProtocolMismatch { server_version: i64 },
    ShellAttached(Box<ShellAttachedFrame>),
    ShellOutput { shell_id: String, data: String },
    ShellDetached { shell_id: String, reason: String },
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Connecting,
    Connected,
    Waiting { until: f64 },
    Finished,
}

struct Queued {
    text: String,
    client_id: Option<String>,
}

pub struct SessionConnection {
    last_seq: i64,
    reconnect: bool,
    phase: Phase,
    retries: u32,
    outbox: VecDeque<Queued>,
    unacked: VecDeque<Queued>,
    acks: bool,
    attached: bool,
    nonce: String,
    prompts: u64,
    in_flight: Option<u64>,
    next_send: u64,
    close_after_flush: bool,
    effects: Vec<Effect>,
    signals: Vec<Signal>,
}

impl SessionConnection {
    // `nonce` is the host's randomness: unique per connection object, it prefixes every prompt's clientId.
    pub fn new(after_seq: i64, reconnect: bool, nonce: String) -> Self {
        SessionConnection {
            last_seq: after_seq,
            reconnect,
            phase: Phase::Connecting,
            retries: 0,
            outbox: VecDeque::new(),
            unacked: VecDeque::new(),
            acks: false,
            attached: false,
            nonce,
            prompts: 0,
            in_flight: None,
            next_send: 0,
            close_after_flush: false,
            effects: vec![Effect::Open { after_seq }],
            signals: Vec::new(),
        }
    }

    pub fn last_seq(&self) -> i64 {
        self.last_seq
    }

    pub fn is_connected(&self) -> bool {
        self.phase == Phase::Connected
    }

    pub fn is_finished(&self) -> bool {
        self.phase == Phase::Finished
    }

    pub fn wake_at(&self) -> Option<f64> {
        match self.phase {
            Phase::Waiting { until } => Some(until),
            _ => None,
        }
    }

    pub fn queued(&self) -> usize {
        self.outbox.len() + self.unacked.len()
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    pub fn take_signals(&mut self) -> Vec<Signal> {
        std::mem::take(&mut self.signals)
    }

    pub fn opened(&mut self) {
        if self.phase != Phase::Connecting {
            return;
        }
        self.phase = Phase::Connected;
        self.retries = 0;
        self.in_flight = None;
        self.attached = false;
        if self.acks {
            while let Some(prompt) = self.unacked.pop_back() {
                self.outbox.push_front(prompt);
            }
        } else {
            self.unacked.clear();
        }
        self.signals.push(Signal::ConnectionChange(true));
        self.flush();
    }

    pub fn closed(&mut self, now: f64) {
        match self.phase {
            Phase::Connected => self.signals.push(Signal::ConnectionChange(false)),
            Phase::Connecting => {}
            Phase::Waiting { .. } | Phase::Finished => return,
        }
        if !self.reconnect {
            self.finish();
            return;
        }
        let until = now + backoff_seconds(self.retries);
        self.retries += 1;
        self.signals.push(Signal::ReconnectAttempt(self.retries));
        self.phase = Phase::Waiting { until };
        self.effects.push(Effect::WakeAt(until));
    }

    pub fn tick(&mut self, now: f64) {
        if let Phase::Waiting { until } = self.phase {
            if now >= until {
                self.connect();
            } else {
                self.effects.push(Effect::WakeAt(until));
            }
        }
    }

    pub fn send_done(&mut self, id: u64, ok: bool) {
        if self.in_flight != Some(id) {
            return;
        }
        self.in_flight = None;
        if !ok {
            return;
        }
        if let Some(sent) = self.outbox.pop_front()
            && sent.client_id.is_some()
            && (self.acks || !self.attached)
        {
            self.unacked.push_back(sent);
        }
        self.flush();
        self.close_when_drained();
    }

    fn close_when_drained(&mut self) {
        if self.close_after_flush && self.outbox.is_empty() && self.in_flight.is_none() && self.unacked.is_empty() {
            self.close_after_flush = false;
            self.detach();
        }
    }

    pub fn received(&mut self, text: &str) {
        if self.phase != Phase::Connected {
            return;
        }
        let Some(frame) = decode_frame(text.as_bytes()) else { return };
        match frame {
            Frame::Event(event) => {
                if event.seq > self.last_seq {
                    self.last_seq = event.seq;
                    self.signals.push(Signal::Event(event));
                }
            }
            Frame::Attached(attached) => {
                self.acks = attached.acks == Some(true);
                self.attached = true;
                if !self.acks {
                    self.unacked.clear();
                }
                let server_version = attached.protocol_version;
                self.signals.push(Signal::Attached(attached));
                if server_version != PROTOCOL_VERSION {
                    self.signals.push(Signal::ProtocolMismatch { server_version });
                }
                self.close_when_drained();
            }
            Frame::Ack { client_id } => {
                self.unacked.retain(|prompt| prompt.client_id.as_deref() != Some(client_id.as_str()));
                self.close_when_drained();
            }
            Frame::ToolCallRequest(request) => self.enqueue(ClientFrame::ToolCallError {
                execution_id: request.execution_id,
                reason: "unsupported".into(),
                error: TOOL_CALL_REFUSAL.into(),
                logs: None,
            }),
            Frame::ProtocolError(message) => self.signals.push(Signal::ProtocolError(message)),
            Frame::ShellAttached(attached) => self.signals.push(Signal::ShellAttached(attached)),
            Frame::ShellOutput { shell_id, data } => self.signals.push(Signal::ShellOutput { shell_id, data }),
            Frame::ShellDetached { shell_id, reason } => self.signals.push(Signal::ShellDetached { shell_id, reason }),
            Frame::ToolCallCanceled { .. } | Frame::Unknown => {}
        }
    }

    pub fn send(&mut self, text: String, attachment_ids: Vec<String>) {
        let attachment_ids = (!attachment_ids.is_empty()).then_some(attachment_ids);
        self.prompts += 1;
        let client_id = format!("{}.{}", self.nonce, self.prompts);
        self.push(ClientFrame::UserMessage { text, attachment_ids, client_id: Some(client_id.clone()) }, Some(client_id));
    }

    pub fn approve(&mut self, request_id: String, updated_input: Option<Map<String, Value>>) {
        self.enqueue(ClientFrame::PermissionDecision {
            request_id,
            behavior: PermissionBehavior::Allow,
            updated_input,
            message: None,
            interrupt: None,
        });
    }

    pub fn deny(&mut self, request_id: String, message: Option<String>, interrupt: Option<bool>) {
        self.enqueue(ClientFrame::PermissionDecision {
            request_id,
            behavior: PermissionBehavior::Deny,
            updated_input: None,
            message,
            interrupt,
        });
    }

    pub fn interrupt(&mut self) {
        self.enqueue(ClientFrame::Interrupt);
    }

    pub fn clear_context(&mut self) {
        self.enqueue(ClientFrame::ClearContext);
    }

    pub fn sleep(&mut self) {
        self.enqueue(ClientFrame::Sleep);
    }

    pub fn background_task(&mut self, tool_use_id: Option<String>) {
        self.enqueue(ClientFrame::BackgroundTask { tool_use_id });
    }

    pub fn run_shell(&mut self, command: String) {
        self.enqueue(ClientFrame::ShellCommand { command });
    }

    pub fn attach_shell(&mut self, shell_id: String, cols: u32, rows: u32) {
        self.enqueue(ClientFrame::ShellAttach { shell_id, cols, rows });
    }

    pub fn write_shell(&mut self, shell_id: &str, data: &str) {
        if data.is_empty() {
            return;
        }
        for piece in chunk(data, SHELL_INPUT_MAX) {
            self.enqueue(ClientFrame::ShellInput { shell_id: shell_id.into(), data: piece.into() });
        }
    }

    pub fn resize_shell(&mut self, shell_id: String, cols: u32, rows: u32) {
        self.enqueue(ClientFrame::ShellResize { shell_id, cols, rows });
    }

    pub fn detach_shell(&mut self, shell_id: String) {
        self.enqueue(ClientFrame::ShellDetach { shell_id });
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.enqueue(ClientFrame::SetPermissionMode { mode });
    }

    pub fn set_model(&mut self, model: Option<String>) {
        self.enqueue(ClientFrame::SetModel { model });
    }

    pub fn set_effort(&mut self, effort: Option<String>) {
        self.enqueue(ClientFrame::SetEffort { effort });
    }

    pub fn close_session(&mut self) {
        self.enqueue(ClientFrame::Close);
        if self.phase == Phase::Connected {
            self.close_after_flush = true;
        } else {
            self.detach();
        }
    }

    pub fn detach(&mut self) {
        match self.phase {
            Phase::Finished => return,
            Phase::Connected => {
                self.effects.push(Effect::Close);
                self.signals.push(Signal::ConnectionChange(false));
            }
            Phase::Connecting => self.effects.push(Effect::Close),
            Phase::Waiting { .. } => {}
        }
        self.outbox.clear();
        self.unacked.clear();
        self.in_flight = None;
        self.close_after_flush = false;
        self.finish();
    }

    pub fn reconnect_now(&mut self) {
        if matches!(self.phase, Phase::Finished | Phase::Connected) {
            return;
        }
        self.retries = 0;
        self.signals.push(Signal::ReconnectAttempt(0));
        if let Phase::Waiting { .. } = self.phase {
            self.connect();
        }
    }

    fn connect(&mut self) {
        self.phase = Phase::Connecting;
        self.effects.push(Effect::Open { after_seq: self.last_seq });
    }

    fn finish(&mut self) {
        self.phase = Phase::Finished;
        self.signals.push(Signal::Finished);
    }

    fn enqueue(&mut self, frame: ClientFrame) {
        self.push(frame, None);
    }

    fn push(&mut self, frame: ClientFrame, client_id: Option<String>) {
        if self.phase == Phase::Finished {
            return;
        }
        self.outbox.push_back(Queued { text: frame.encode(), client_id });
        self.flush();
    }

    fn flush(&mut self) {
        if self.phase != Phase::Connected || self.in_flight.is_some() {
            return;
        }
        let Some(queued) = self.outbox.front() else { return };
        let id = self.next_send;
        self.next_send += 1;
        self.in_flight = Some(id);
        self.effects.push(Effect::Send { id, text: queued.text.clone() });
    }
}
