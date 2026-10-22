use serde_json::{Value, json};
use std::path::Path;
use wd_native::controller::session::{Effect, SessionConnection, Signal, TOOL_CALL_REFUSAL, backoff_seconds, chunk};
use wd_native::protocol::{ClientFrame, Frame, PROTOCOL_VERSION, SHELL_INPUT_MAX, decode_frame};
use wd_native::rest::PermissionMode;

struct Wire {
    conn: SessionConnection,
    opens: Vec<i64>,
    sent: Vec<String>,
    pending: Vec<(u64, String)>,
    socket_closed: bool,
    wake: Option<f64>,
    signals: Vec<Signal>,
    auto_ack: bool,
}

impl Wire {
    fn new(after_seq: i64, reconnect: bool) -> Self {
        let mut wire = Wire {
            conn: SessionConnection::new(after_seq, reconnect, "nonce".into(), None),
            opens: Vec::new(),
            sent: Vec::new(),
            pending: Vec::new(),
            socket_closed: false,
            wake: None,
            signals: Vec::new(),
            auto_ack: true,
        };
        wire.pump();
        wire
    }

    fn opened(after_seq: i64, reconnect: bool) -> Self {
        let mut wire = Wire::new(after_seq, reconnect);
        wire.open();
        wire
    }

    // Open and attached to conversation 3: commands go out at once, stamped with it.
    fn connected(after_seq: i64, reconnect: bool) -> Self {
        let mut wire = Wire::opened(after_seq, reconnect);
        wire.push(&attached_frame(PROTOCOL_VERSION));
        wire
    }

    fn pump(&mut self) {
        loop {
            let effects = self.conn.take_effects();
            if effects.is_empty() {
                break;
            }
            for effect in effects {
                match effect {
                    Effect::Open { after_seq } => {
                        self.opens.push(after_seq);
                        self.socket_closed = false;
                    }
                    Effect::Send { id, text } if self.auto_ack => {
                        self.sent.push(text);
                        self.conn.send_done(id, true);
                    }
                    Effect::Send { id, text } => self.pending.push((id, text)),
                    Effect::Close => self.socket_closed = true,
                    Effect::WakeAt(at) => self.wake = Some(at),
                }
            }
        }
        self.signals.extend(self.conn.take_signals());
    }

    fn open(&mut self) {
        self.conn.opened();
        self.pump();
    }

    fn push(&mut self, text: &str) {
        self.conn.received(text);
        self.pump();
    }

    fn drop_socket(&mut self, now: f64) {
        self.conn.closed(now);
        self.pump();
    }

    fn tick(&mut self, now: f64) {
        self.conn.tick(now);
        self.pump();
    }

    fn ack(&mut self, ok: bool) {
        let (id, text) = self.pending.remove(0);
        if ok {
            self.sent.push(text);
        }
        self.conn.send_done(id, ok);
        self.pump();
    }

    fn act(&mut self, action: impl FnOnce(&mut SessionConnection)) {
        action(&mut self.conn);
        self.pump();
    }

    fn labels(&self) -> Vec<String> {
        self.signals.iter().map(label).collect()
    }

    fn has(&self, wanted: &str) -> bool {
        self.labels().iter().any(|l| l == wanted)
    }

    fn event_seqs(&self) -> Vec<i64> {
        self.signals
            .iter()
            .filter_map(|s| match s {
                Signal::Event(event) => Some(event.seq),
                _ => None,
            })
            .collect()
    }

    // Without the conversation token, which `generations` reads.
    fn sent_json(&self) -> Vec<Value> {
        self.sent
            .iter()
            .map(|text| {
                let mut frame: Value = serde_json::from_str(text).unwrap();
                frame.as_object_mut().unwrap().remove("generation");
                frame
            })
            .collect()
    }

    fn sent_raw(&self) -> Vec<Value> {
        self.sent.iter().map(|text| serde_json::from_str(text).unwrap()).collect()
    }
}

fn label(signal: &Signal) -> String {
    match signal {
        Signal::Attached(frame) => format!("attached {}", frame.session.id),
        Signal::Event(event) => format!("event {}", event.seq),
        Signal::ConnectionChange(up) => format!("connection {up}"),
        Signal::ReconnectAttempt(n) => format!("attempt {n}"),
        Signal::ProtocolError(message) => format!("protocol_error {message}"),
        Signal::ProtocolMismatch { server_version } => format!("mismatch {server_version}"),
        Signal::ShellAttached(frame) => format!("shell_attached {}", frame.shell_id),
        Signal::ShellOutput { shell_id, data } => format!("shell_output {shell_id} {data}"),
        Signal::ShellDetached { shell_id, reason } => format!("shell_detached {shell_id} {reason}"),
        Signal::Undelivered(prompt) => format!("undelivered {} {}", prompt.text, prompt.uncertain),
        Signal::Finished => "finished".into(),
    }
}

fn attached_frame(protocol_version: i64) -> String {
    format!(
        r#"{{"type":"attached","protocolVersion":{protocol_version},"replayingFrom":0,
   "session":{{"id":"s1","status":"running","cwd":"/repo","createdAt":1,"lastSeq":0,
   "conversation":3,"pendingPermissionCount":0}}}}"#
    )
}

fn event_frame(seq: i64) -> String {
    format!(r#"{{"type":"event","event":{{"type":"status_changed","status":"idle","seq":{seq},"ts":1}}}}"#)
}

fn encoded(frame: ClientFrame) -> Value {
    serde_json::from_str(&frame.encode()).unwrap()
}

#[test]
fn emits_attached_frame_on_connect() {
    let mut wire = Wire::opened(0, false);
    assert!(wire.has("connection true"));
    wire.push(&attached_frame(PROTOCOL_VERSION));
    let Signal::Attached(frame) = &wire.signals[1] else { panic!("expected attached, got {:?}", wire.labels()) };
    assert_eq!(frame.protocol_version, PROTOCOL_VERSION);
    assert_eq!(frame.session.id, "s1");
    assert!(!wire.has(&format!("mismatch {PROTOCOL_VERSION}")));
}

#[test]
fn warns_on_protocol_mismatch_without_disconnecting() {
    let mut wire = Wire::connected(0, false);
    wire.push(&attached_frame(PROTOCOL_VERSION + 1));
    assert!(wire.has(&format!("mismatch {}", PROTOCOL_VERSION + 1)));
    assert!(!wire.socket_closed);
    assert!(!wire.has("finished"));
}

#[test]
fn dedupes_replayed_events_by_seq() {
    let mut wire = Wire::connected(0, false);
    wire.push(&event_frame(1));
    wire.push(&event_frame(2));
    assert_eq!(wire.event_seqs(), [1, 2]);
    assert_eq!(wire.conn.last_seq(), 2);
    wire.push(&event_frame(1));
    wire.push(&event_frame(2));
    wire.push(&event_frame(3));
    assert_eq!(wire.event_seqs(), [1, 2, 3]);
    assert_eq!(wire.conn.last_seq(), 3);
}

#[test]
fn honors_after_seq_as_the_starting_watermark() {
    let mut wire = Wire::connected(5, false);
    assert_eq!(wire.opens, [5]);
    wire.push(&event_frame(4));
    wire.push(&event_frame(6));
    assert_eq!(wire.event_seqs(), [6]);
}

#[test]
fn flushes_queued_commands_in_order_on_open() {
    let mut wire = Wire::new(0, false);
    wire.act(|c| c.send("first".into(), Vec::new()));
    wire.act(|c| c.interrupt());
    wire.act(|c| c.set_permission_mode(PermissionMode::AcceptEdits));
    assert!(wire.sent.is_empty());
    wire.open();
    assert!(wire.sent.is_empty());
    wire.push(&attached_frame(PROTOCOL_VERSION));
    assert_eq!(
        wire.sent_json(),
        [
            json!({"type": "user_message", "text": "first", "clientId": "nonce.1"}),
            json!({"type": "interrupt"}),
            json!({"type": "set_permission_mode", "mode": "acceptEdits"}),
        ]
    );
}

#[test]
fn encodes_user_message_command_on_the_wire() {
    let mut wire = Wire::connected(0, false);
    wire.act(|c| c.send("hello".into(), Vec::new()));
    assert_eq!(wire.sent_json(), [json!({"type": "user_message", "text": "hello", "clientId": "nonce.1"})]);
}

#[test]
fn encodes_set_effort_on_the_wire() {
    let mut wire = Wire::connected(0, false);
    wire.act(|c| c.set_effort(Some("xhigh".into())));
    wire.act(|c| c.set_effort(None));
    assert_eq!(wire.sent_json(), [json!({"type": "set_effort", "effort": "xhigh"}), json!({"type": "set_effort"})]);
}

#[test]
fn answers_bridged_tool_calls_it_cannot_run() {
    let mut wire = Wire::connected(0, false);
    wire.push(r#"{"type":"tool_call_request","executionId":"exec_1","toolName":"Bash","input":{}}"#);
    let reply = &wire.sent_json()[0];
    assert_eq!(reply["type"], "tool_call_error");
    assert_eq!(reply["executionId"], "exec_1");
    assert_eq!(reply["reason"], "unsupported");
    assert!(!reply["error"].as_str().unwrap().is_empty());
}

#[test]
fn ignores_canceled_and_unknown_frames() {
    let mut wire = Wire::connected(0, false);
    wire.push(r#"{"type":"tool_call_canceled","executionId":"exec_1","reason":"timeout"}"#);
    wire.push(r#"{"type":"something_new","payload":{}}"#);
    wire.push("not json at all");
    wire.push(&event_frame(1));
    assert_eq!(wire.event_seqs(), [1]);
    assert!(wire.sent.is_empty());
    assert_eq!(wire.labels().iter().filter(|l| *l == "connection true").count(), 1);
}

#[test]
fn surfaces_protocol_errors() {
    let mut wire = Wire::connected(0, false);
    wire.push(r#"{"type":"protocol_error","message":"unknown command"}"#);
    assert!(wire.has("protocol_error unknown command"));
    assert!(!wire.has("finished"));
}

#[test]
fn detach_closes_the_socket_and_finishes_the_stream() {
    let mut wire = Wire::connected(0, false);
    wire.act(|c| c.detach());
    assert!(wire.has("finished"));
    assert!(wire.socket_closed);
    let labels = wire.labels();
    assert_eq!(labels[labels.len() - 2..], ["connection false", "finished"]);
    let count = wire.signals.len();
    wire.push(&event_frame(9));
    assert_eq!(wire.signals.len(), count);
    assert_eq!(wire.conn.last_seq(), 0);
}

#[test]
fn reconnects_and_resumes_from_last_seq() {
    let mut wire = Wire::connected(0, true);
    wire.push(&event_frame(4));
    assert_eq!(wire.conn.last_seq(), 4);
    wire.drop_socket(10.0);
    assert!(wire.has("connection false"));
    wire.act(|c| c.reconnect_now());
    assert_eq!(wire.opens, [0, 4]);
    wire.open();
    assert_eq!(wire.labels().last().unwrap(), "connection true");
}

#[test]
fn counts_failed_reconnect_attempts_so_the_ui_can_escalate() {
    let mut wire = Wire::new(0, true);
    wire.drop_socket(0.0);
    wire.tick(wire.wake.unwrap());
    wire.drop_socket(wire.wake.unwrap());
    assert!(wire.has("attempt 2"));
    assert!(!wire.has("connection true"));
    wire.act(|c| c.reconnect_now());
    assert!(wire.has("attempt 0"));
}

#[test]
fn close_session_sends_close_then_detaches() {
    let mut wire = Wire::connected(0, false);
    wire.act(|c| c.close_session());
    assert_eq!(wire.sent_json(), [json!({"type": "close"})]);
    assert!(wire.has("finished"));
    assert!(wire.socket_closed);
}

#[test]
fn backoff_doubles_from_half_a_second_and_caps_at_ten() {
    assert_eq!((0..7).map(backoff_seconds).collect::<Vec<_>>(), [0.5, 1.0, 2.0, 4.0, 8.0, 10.0, 10.0]);
    assert_eq!(backoff_seconds(u32::MAX), 10.0);
}

#[test]
fn wake_at_is_now_plus_the_backoff_and_an_early_tick_waits() {
    let mut wire = Wire::new(0, true);
    let mut now = 100.0;
    let mut wakes = Vec::new();
    for _ in 0..7 {
        wire.drop_socket(now);
        let at = wire.wake.unwrap();
        wakes.push(at - now);
        wire.wake = None;
        wire.tick(at - 0.01);
        assert_eq!(wire.wake, Some(at));
        assert_eq!(wire.opens.len(), wakes.len());
        wire.tick(at);
        assert_eq!(wire.opens.len(), wakes.len() + 1);
        now = at;
    }
    assert_eq!(wakes, [0.5, 1.0, 2.0, 4.0, 8.0, 10.0, 10.0]);
    assert!(wire.has("attempt 7"));
}

#[test]
fn a_successful_open_resets_the_backoff() {
    let mut wire = Wire::new(0, true);
    wire.drop_socket(0.0);
    wire.tick(0.5);
    wire.drop_socket(0.5);
    assert_eq!(wire.wake, Some(1.5));
    wire.tick(1.5);
    wire.open();
    wire.drop_socket(20.0);
    assert_eq!(wire.wake, Some(20.5));
    assert_eq!(wire.labels().last().unwrap(), "attempt 1");
}

#[test]
fn reconnect_now_skips_the_backoff_and_a_stale_tick_is_ignored() {
    let mut wire = Wire::new(0, true);
    wire.drop_socket(0.0);
    wire.act(|c| c.reconnect_now());
    assert_eq!(wire.opens, [0, 0]);
    wire.tick(0.5);
    assert_eq!(wire.opens, [0, 0]);
}

#[test]
fn one_send_is_in_flight_at_a_time() {
    let mut wire = Wire::connected(0, false);
    wire.auto_ack = false;
    wire.act(|c| c.interrupt());
    wire.act(|c| c.clear_context());
    assert_eq!(wire.pending.len(), 1);
    wire.ack(true);
    assert_eq!(wire.pending.len(), 1);
    wire.ack(true);
    assert!(wire.pending.is_empty());
    assert_eq!(wire.sent_json(), [json!({"type": "interrupt"}), json!({"type": "clear_context"})]);
}

#[test]
fn the_outbox_survives_a_reconnect_and_pops_only_on_success() {
    let mut wire = Wire::connected(0, true);
    wire.auto_ack = false;
    wire.act(|c| c.interrupt());
    wire.ack(false);
    assert_eq!(wire.conn.queued(), 1);
    wire.drop_socket(0.0);
    wire.act(|c| c.send("later".into(), Vec::new()));
    assert!(wire.pending.is_empty());
    wire.tick(0.5);
    wire.open();
    wire.ack(true);
    wire.ack(true);
    wire.push(&attached_frame(PROTOCOL_VERSION));
    assert_eq!(wire.sent_json(), [json!({"type": "interrupt"}), json!({"type": "user_message", "text": "later", "clientId": "nonce.1"})]);
    assert_eq!(wire.conn.queued(), 1);
    wire.push(r#"{"type":"ack","clientId":"nonce.1"}"#);
    assert_eq!(wire.conn.queued(), 0);
}

#[test]
fn a_late_ack_after_a_drop_still_pops() {
    let mut wire = Wire::connected(0, true);
    wire.auto_ack = false;
    wire.act(|c| c.interrupt());
    wire.drop_socket(0.0);
    wire.ack(true);
    assert_eq!(wire.conn.queued(), 0);
    wire.tick(0.5);
    wire.open();
    assert!(wire.pending.is_empty());
}

fn prompt_texts(wire: &Wire) -> Vec<String> {
    wire.sent_json().iter().filter(|f| f["type"] == "user_message").map(|f| f["text"].as_str().unwrap().to_owned()).collect()
}

fn generations(wire: &Wire) -> Vec<Option<i64>> {
    wire.sent.iter().map(|text| serde_json::from_str::<Value>(text).unwrap()["generation"].as_i64()).collect()
}

#[test]
fn an_unacked_prompt_is_resent_after_a_reconnect_before_newer_input() {
    let mut wire = Wire::connected(0, true);
    wire.act(|c| c.send("acked".into(), Vec::new()));
    wire.act(|c| c.send("lost".into(), Vec::new()));
    wire.push(r#"{"type":"ack","clientId":"nonce.1"}"#);
    assert_eq!(wire.conn.queued(), 1);
    wire.drop_socket(0.0);
    wire.act(|c| c.send("while down".into(), Vec::new()));
    wire.tick(0.5);
    wire.open();
    assert_eq!(prompt_texts(&wire), ["acked", "lost", "lost", "while down"]);
    assert_eq!(wire.sent_json()[2]["clientId"], "nonce.2");
    wire.push(r#"{"type":"ack","clientId":"nonce.2"}"#);
    wire.push(r#"{"type":"ack","clientId":"nonce.3"}"#);
    assert_eq!(wire.conn.queued(), 0);
}

#[test]
fn a_command_written_before_any_attach_waits_for_it_and_carries_its_conversation() {
    let mut wire = Wire::opened(0, true);
    wire.act(|c| c.send("early".into(), Vec::new()));
    wire.act(|c| c.interrupt());
    assert!(wire.sent.is_empty());
    wire.drop_socket(0.0);
    wire.tick(0.5);
    wire.open();
    assert!(wire.sent.is_empty());
    wire.push(&attached_frame(PROTOCOL_VERSION));
    assert_eq!(prompt_texts(&wire), ["early"]);
    assert_eq!(generations(&wire), [Some(3), Some(3)]);
    assert_eq!(wire.conn.conversation(), Some(3));
}

#[test]
fn a_command_keeps_the_conversation_it_was_written_for_across_a_cut() {
    let mut wire = Wire::connected(0, true);
    wire.act(|c| c.send("for three".into(), Vec::new()));
    wire.drop_socket(0.0);
    wire.act(|c| c.interrupt());
    wire.tick(0.5);
    wire.open();
    wire.push(&attached_frame(PROTOCOL_VERSION).replace(r#""conversation":3"#, r#""conversation":4"#));
    wire.act(|c| c.send("for four".into(), Vec::new()));
    assert_eq!(prompt_texts(&wire), ["for three", "for three", "for four"]);
    assert_eq!(generations(&wire), [Some(3), Some(3), Some(3), Some(4)]);
}

#[test]
fn a_refused_prompt_comes_back_to_the_sender() {
    let mut wire = Wire::connected(0, true);
    wire.act(|c| c.send("one".into(), vec!["att".into()]));
    wire.act(|c| c.send("two".into(), Vec::new()));
    wire.act(|c| c.send("three".into(), Vec::new()));
    wire.push(r#"{"type":"ack","clientId":"nonce.1","notDelivered":true}"#);
    wire.push(r#"{"type":"ack","clientId":"nonce.2","uncertain":true}"#);
    wire.push(r#"{"type":"ack","clientId":"nonce.3"}"#);
    let back: Vec<_> = wire
        .signals
        .iter()
        .filter_map(|signal| match signal {
            Signal::Undelivered(prompt) => Some((prompt.text.as_str(), prompt.attachment_ids.clone(), prompt.uncertain)),
            _ => None,
        })
        .collect();
    assert_eq!(back, [("one", vec!["att".to_owned()], false), ("two", Vec::new(), true)]);
    assert_eq!(wire.conn.queued(), 0);
}

#[test]
fn a_history_socket_stays_on_its_past_conversation() {
    let mut wire = Wire { conn: SessionConnection::new(0, false, "nonce".into(), Some(1)), ..Wire::new(0, false) };
    wire.pump();
    wire.open();
    wire.act(|c| c.interrupt());
    wire.push(&attached_frame(PROTOCOL_VERSION));
    assert_eq!(wire.conn.conversation(), Some(1));
    assert_eq!(generations(&wire), [Some(1)]);
}

#[test]
fn ever_connected_flips_on_the_first_open_only() {
    let mut wire = Wire::new(0, true);
    wire.drop_socket(0.0);
    assert!(!wire.conn.ever_connected());
    assert!(!wire.has("connection false"));
    wire.tick(0.5);
    wire.open();
    wire.drop_socket(1.0);
    assert!(wire.conn.ever_connected());
}

#[test]
fn an_unknown_event_type_decodes_as_unknown_and_keeps_its_seq() {
    let json = br#"{"type":"event","event":{"type":"session_renamed_someday","to":"b","seq":7,"ts":1}}"#;
    let Some(Frame::Event(event)) = decode_frame(json) else { panic!("expected an event") };
    assert_eq!(event.seq, 7);
    assert!(matches!(event.body, wd_native::protocol::Body::Unknown));
}

#[test]
fn decodes_an_ack_frame() {
    let Some(Frame::Ack(ack)) = decode_frame(br#"{"type":"ack","clientId":"n.1"}"#) else { panic!("expected an ack") };
    assert_eq!((ack.client_id.as_str(), ack.not_delivered, ack.uncertain), ("n.1", false, false));
    let Some(Frame::Ack(ack)) = decode_frame(br#"{"type":"ack","clientId":"n.2","notDelivered":true}"#) else { panic!("expected an ack") };
    assert!(ack.not_delivered && !ack.uncertain);
}

#[test]
fn close_session_while_disconnected_detaches_at_once() {
    let mut wire = Wire::new(0, true);
    wire.act(|c| c.close_session());
    assert!(wire.has("finished"));
    assert!(wire.socket_closed);
    wire.open();
    assert!(wire.sent.is_empty());
}

#[test]
fn without_reconnect_a_drop_finishes() {
    let mut wire = Wire::opened(0, false);
    wire.drop_socket(0.0);
    assert_eq!(wire.labels(), ["connection true", "connection false", "finished"]);
    assert_eq!(wire.wake, None);
    wire.act(|c| c.reconnect_now());
    assert_eq!(wire.opens, [0]);
}

#[test]
fn detach_is_idempotent() {
    let mut wire = Wire::connected(0, true);
    wire.act(|c| c.detach());
    let count = wire.signals.len();
    wire.act(|c| c.detach());
    wire.act(|c| c.reconnect_now());
    wire.drop_socket(0.0);
    assert_eq!(wire.signals.len(), count);
}

#[test]
fn write_shell_splits_a_long_paste_into_ordered_frames() {
    let mut wire = Wire::connected(0, false);
    let paste = "a".repeat(10_000);
    wire.act(|c| c.write_shell("sh_1", &paste));
    wire.act(|c| c.write_shell("sh_1", ""));
    let data: Vec<String> = wire.sent_json().iter().map(|f| f["data"].as_str().unwrap().to_owned()).collect();
    assert_eq!(data.iter().map(String::len).collect::<Vec<_>>(), [4096, 4096, 1808]);
    assert_eq!(data.concat(), paste);
}

#[test]
fn shell_frames_reach_the_app() {
    let mut wire = Wire::opened(0, false);
    wire.push(r#"{"type":"shell_output","shellId":"sh_1","data":"hi"}"#);
    wire.push(r#"{"type":"shell_detached","shellId":"sh_1","reason":"exited"}"#);
    assert_eq!(wire.labels()[1..], ["shell_output sh_1 hi", "shell_detached sh_1 exited"]);
}

#[test]
fn encodes_the_attach_command_with_its_size() {
    let frame = encoded(ClientFrame::ShellAttach { shell_id: "sh_1".into(), cols: 80, rows: 24 });
    assert_eq!(frame, json!({"type": "shell_attach", "shellId": "sh_1", "cols": 80, "rows": 24}));
}

#[test]
fn encodes_input_resize_and_detach() {
    let input = encoded(ClientFrame::ShellInput { shell_id: "sh_1".into(), data: "ls\r".into() });
    assert_eq!(input["type"], "shell_input");
    assert_eq!(input["data"], "ls\r");
    let resize = encoded(ClientFrame::ShellResize { shell_id: "sh_1".into(), cols: 100, rows: 30 });
    assert_eq!(resize["type"], "shell_resize");
    assert_eq!(resize["cols"], 100);
    let detach = encoded(ClientFrame::ShellDetach { shell_id: "sh_1".into() });
    assert_eq!(detach, json!({"type": "shell_detach", "shellId": "sh_1"}));
}

#[test]
fn decodes_the_shell_attached_frame() {
    let json = r#"{"type":"shell_attached","shellId":"sh_1","cols":80,"rows":24,
       "scrollback":"\u001b[32mok\u001b[0m\r\n",
       "shell":{"id":"sh_1","sessionId":"s1","ordinal":3,"command":"npm run dev",
         "label":"npm run dev","cwd":"/work","owner":"user","status":"running",
         "startedAt":1000,"bytes":12,"cols":120,"rows":40}}"#;
    let Some(Frame::ShellAttached(attached)) = decode_frame(json.as_bytes()) else { panic!("expected shell_attached") };
    assert_eq!(attached.shell_id, "sh_1");
    assert_eq!(attached.cols, 80);
    assert_eq!(attached.shell.ordinal, 3);
    assert_eq!(attached.scrollback, "\u{1b}[32mok\u{1b}[0m\r\n");
}

#[test]
fn decodes_output_and_detached() {
    let Some(Frame::ShellOutput { shell_id, data }) = decode_frame(br#"{"type":"shell_output","shellId":"sh_1","data":"hi"}"#) else {
        panic!("expected shell_output")
    };
    assert_eq!((shell_id.as_str(), data.as_str()), ("sh_1", "hi"));
    let Some(Frame::ShellDetached { shell_id, reason }) = decode_frame(br#"{"type":"shell_detached","shellId":"sh_1","reason":"exited"}"#)
    else {
        panic!("expected shell_detached")
    };
    assert_eq!((shell_id.as_str(), reason.as_str()), ("sh_1", "exited"));
}

#[test]
fn an_unmodelled_shell_frame_is_not_an_error() {
    assert!(matches!(decode_frame(br#"{"type":"shell_reflowed","shellId":"sh_1"}"#), Some(Frame::Unknown)));
}

#[test]
fn short_input_is_one_frame() {
    assert_eq!(chunk("ls -la\r", 4096), ["ls -la\r"]);
}

#[test]
fn a_long_paste_is_split_on_the_byte_budget() {
    let text = "a".repeat(10_000);
    let chunks = chunk(&text, 4096);
    assert_eq!(chunks.iter().map(|c| c.len()).collect::<Vec<_>>(), [4096, 4096, 1808]);
    assert_eq!(chunks.concat(), text);
}

#[test]
fn a_multibyte_character_is_never_split() {
    let text = "\u{3042}".repeat(5);
    let chunks = chunk(&text, 4);
    assert_eq!(chunks, ["\u{3042}"; 5]);
    assert_eq!(chunks.concat(), text);
}

#[test]
fn a_grapheme_cluster_is_never_split() {
    let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}";
    let text = format!("ab{family}cd");
    assert_eq!(chunk(&text, 4), ["ab", family, "cd"]);
}

#[test]
fn one_oversized_character_still_goes() {
    assert_eq!(chunk("\u{3042}", 2), ["\u{3042}"]);
}

#[test]
fn encodes_sleep_command() {
    assert_eq!(encoded(ClientFrame::Sleep), json!({"type": "sleep"}));
}

#[test]
fn encodes_set_effort_command() {
    assert_eq!(encoded(ClientFrame::SetEffort { effort: Some("low".into()) }), json!({"type": "set_effort", "effort": "low"}));
    assert_eq!(encoded(ClientFrame::SetEffort { effort: None }), json!({"type": "set_effort"}));
}

#[test]
fn encodes_permission_decision_command() {
    let mut wire = Wire::connected(0, false);
    wire.act(|c| c.deny("r1".into(), Some("no".into()), Some(true)));
    let frame = &wire.sent_json()[0];
    assert_eq!(frame["type"], "permission_decision");
    assert_eq!(frame["requestId"], "r1");
    assert_eq!(frame["behavior"], "deny");
    assert_eq!(frame["interrupt"], true);
    assert!(frame.get("updatedInput").is_none());
}

#[test]
fn encodes_clear_context_command() {
    assert_eq!(encoded(ClientFrame::ClearContext), json!({"type": "clear_context"}));
}

#[test]
fn encodes_shell_command() {
    assert_eq!(
        encoded(ClientFrame::ShellCommand { command: "git status".into() }),
        json!({"type": "shell_command", "command": "git status"})
    );
}

#[test]
fn encodes_background_task_with_and_without_an_id() {
    let named = encoded(ClientFrame::BackgroundTask { tool_use_id: Some("tu1".into()) });
    assert_eq!(named, json!({"type": "background_task", "toolUseId": "tu1"}));
    assert_eq!(encoded(ClientFrame::BackgroundTask { tool_use_id: None }), json!({"type": "background_task"}));
}

#[test]
fn decodes_attached_frame() {
    let json = r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,
       "session":{"id":"s1","status":"idle","cwd":"/x","createdAt":1722300000000,
                  "lastSeq":12,"pendingPermissionCount":0}}"#;
    let Some(Frame::Attached(attached)) = decode_frame(json.as_bytes()) else { panic!("expected attached") };
    assert_eq!(attached.protocol_version, PROTOCOL_VERSION);
    assert_eq!(attached.session.id, "s1");
    assert_eq!(attached.shell, None);
}

#[test]
fn decodes_the_shell_offer_on_the_attached_frame() {
    let json = r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"shell":true,
       "session":{"id":"s1","status":"idle","cwd":"/x","createdAt":1722300000000,
                  "lastSeq":0,"pendingPermissionCount":0}}"#;
    let Some(Frame::Attached(attached)) = decode_frame(json.as_bytes()) else { panic!("expected attached") };
    assert_eq!(attached.shell, Some(true));
}

fn text(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(Value::as_str).map(str::to_owned)
}

fn size(args: &[Value]) -> (u32, u32) {
    (args[1]["cols"].as_u64().unwrap() as u32, args[1]["rows"].as_u64().unwrap() as u32)
}

#[test]
fn client_frames_match_the_typescript_client() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/client-frames/commands.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(golden["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(golden["shellInputMax"], SHELL_INPUT_MAX);
    let calls = golden["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 34);
    for entry in calls {
        let call = entry["call"].as_str().unwrap();
        let args = entry["args"].as_array().unwrap().as_slice();
        let mut wire = Wire::connected(0, false);
        let id = || text(args, 0).unwrap();
        match call {
            "send" => {
                let ids = args.get(1).and_then(Value::as_array).map(|list| list.iter().map(|v| v.as_str().unwrap().to_owned()).collect());
                wire.act(|c| c.send(id(), ids.unwrap_or_default()));
            }
            "approve" => wire.act(|c| c.approve(id(), args.get(1).and_then(Value::as_object).cloned())),
            "deny" => wire.act(|c| c.deny(id(), text(args, 1), args.get(2).and_then(Value::as_bool))),
            "interrupt" => wire.act(|c| c.interrupt()),
            "clearContext" => wire.act(|c| c.clear_context()),
            "sleep" => wire.act(|c| c.sleep()),
            "backgroundTask" => wire.act(|c| c.background_task(text(args, 0))),
            "runShell" => wire.act(|c| c.run_shell(id())),
            "attachShell" => wire.act(|c| c.attach_shell(id(), size(args).0, size(args).1)),
            "writeShell" => wire.act(|c| c.write_shell(&id(), &text(args, 1).unwrap())),
            "resizeShell" => wire.act(|c| c.resize_shell(id(), size(args).0, size(args).1)),
            "detachShell" => wire.act(|c| c.detach_shell(id())),
            "setPermissionMode" => wire.act(|c| c.set_permission_mode(serde_json::from_value(args[0].clone()).unwrap())),
            "setModel" => wire.act(|c| c.set_model(text(args, 0))),
            "setEffort" => wire.act(|c| c.set_effort(text(args, 0))),
            "sendToolCallError" => {
                assert_eq!(text(args, 2).as_deref(), Some(TOOL_CALL_REFUSAL));
                let request = json!({"type": "tool_call_request", "executionId": id(), "toolName": "Bash", "input": {}});
                wire.push(&request.to_string());
            }
            "closeSession" => wire.act(|c| c.close_session()),
            other => panic!("no Rust command for {other}"),
        }
        assert_eq!(&Value::Array(wire.sent_raw()), &entry["frames"], "{call} {args:?}");
    }
}
