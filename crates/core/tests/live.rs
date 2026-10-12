use serde_json::{Value, json};
use std::path::Path;
use wd_native::controller::live::{Changed, ConnectionState, Effect, LiveSession};
use wd_native::controller::replay::STALL_SECONDS;
use wd_native::expansion::TermPress;
use wd_native::planner::Metrics;
use wd_native::transcript::Item;

const METRICS: Metrics = Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 };

struct Host {
    live: LiveSession,
    effects: Vec<Effect>,
    sent: Vec<Value>,
    opens: Vec<i64>,
}

impl Host {
    fn new() -> Self {
        let mut host = Host { live: LiveSession::new(0, true, "n".into(), METRICS), effects: Vec::new(), sent: Vec::new(), opens: Vec::new() };
        host.drain();
        host
    }

    fn drain(&mut self) {
        loop {
            let effects = self.live.take_effects();
            if effects.is_empty() {
                return;
            }
            for effect in effects {
                match &effect {
                    Effect::Open { after_seq } => self.opens.push(*after_seq),
                    Effect::Send { id, text } => {
                        self.sent.push(serde_json::from_str(text).unwrap());
                        let id = *id;
                        self.live.send_done(id, true);
                    }
                    _ => {}
                }
                self.effects.push(effect);
            }
        }
    }

    fn open(&mut self) {
        self.live.opened();
        self.drain();
    }

    fn frame(&mut self, frame: Value, now: f64) {
        self.live.received(&frame.to_string(), now);
        self.drain();
    }

    fn attach(&mut self, replaying_from: i64, last_seq: i64, created_at: f64, now: f64) {
        self.frame(
            json!({"type": "attached", "protocolVersion": 1, "replayingFrom": replaying_from, "acks": true,
                "session": {"id": "s1", "status": "running", "cwd": "/repo", "createdAt": created_at, "lastSeq": last_seq, "pendingPermissionCount": 0}}),
            now,
        );
    }

    fn events(&mut self, case: &str, now: f64) -> usize {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/conformance/{case}.events.jsonl"));
        let body = std::fs::read_to_string(path).unwrap();
        let mut count = 0;
        for line in body.lines().filter(|line| !line.is_empty()) {
            self.live.received(line, now);
            count += 1;
        }
        self.drain();
        count
    }

    fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    fn changed(&mut self) -> Changed {
        self.take().into_iter().fold(Changed::default(), |acc, effect| match effect {
            Effect::Changed(c) => Changed { transcript: acc.transcript || c.transcript, chrome: acc.chrome || c.chrome, progress: acc.progress || c.progress },
            _ => acc,
        })
    }
}

fn event_frame(seq: i64, body: Value) -> Value {
    let mut event = body;
    event["seq"] = json!(seq);
    event["ts"] = json!(1);
    json!({"type": "event", "event": event})
}

#[test]
fn a_fresh_attach_holds_the_whole_replay_and_publishes_it_at_the_stated_seq() {
    let mut host = Host::new();
    host.open();
    assert_eq!(host.live.connection(), ConnectionState::Live);
    host.attach(0, 15, 1.0, 0.0);
    assert!(host.live.replaying());
    assert_eq!(host.live.replay_progress(), Some((0, 15)));
    assert_eq!(host.live.state().status.map(|s| s.raw()), Some("running"));
    host.take();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance/basic-turn.events.jsonl");
    let lines: Vec<String> = std::fs::read_to_string(path).unwrap().lines().map(str::to_owned).collect();
    assert_eq!(lines.len(), 15);
    for line in &lines[..14] {
        host.live.received(line, 0.05);
    }
    host.drain();
    assert!(host.live.replaying());
    assert!(host.live.state().items.is_empty());
    assert!(!host.changed().transcript);
    host.live.received(&lines[14], 0.2);
    host.drain();
    assert!(!host.live.replaying());
    assert_eq!(host.live.replay_progress(), None);
    assert_eq!(host.live.state().last_seq, 15);
    assert!(host.changed().transcript);
    assert!(!host.live.view().rows().rows.is_empty());
    assert!(host.live.item_for_seq(1).is_some());
}

#[test]
fn progress_moves_at_most_ten_times_a_second() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 100, 1.0, 0.0);
    host.take();
    for seq in 1..=10 {
        host.frame(event_frame(seq, json!({"type": "status_changed", "status": "running"})), 0.009 * seq as f64);
    }
    assert_eq!(host.live.replay_progress(), Some((0, 100)));
    host.frame(event_frame(11, json!({"type": "status_changed", "status": "running"})), 0.15);
    assert_eq!(host.live.replay_progress(), Some((11, 100)));
}

#[test]
fn a_stalled_replay_is_released_on_the_wake_the_host_was_asked_for() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 50, 1.0, 10.0);
    host.frame(event_frame(1, json!({"type": "status_changed", "status": "idle"})), 10.5);
    let wakes: Vec<f64> = host.take().into_iter().filter_map(|e| if let Effect::WakeAt(at) = e { Some(at) } else { None }).collect();
    assert_eq!(wakes.last(), Some(&(10.5 + STALL_SECONDS)));
    host.live.tick(10.5 + STALL_SECONDS - 0.01);
    host.drain();
    assert!(host.live.replaying());
    host.live.tick(10.5 + STALL_SECONDS);
    host.drain();
    assert!(!host.live.replaying());
    assert_eq!(host.live.state().last_seq, 1);
}

#[test]
fn live_events_after_the_hold_reach_the_state_and_the_view_at_once() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    assert!(!host.live.replaying());
    host.take();
    host.events("basic-turn", 1.0);
    assert_eq!(host.live.state().last_seq, 15);
    assert!(host.changed().transcript);
    assert!(!host.live.view().rows().rows.is_empty());
}

#[test]
fn an_attach_from_another_log_drops_the_transcript_and_replays_from_zero() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("basic-turn", 1.0);
    host.live.closed(2.0);
    host.drain();
    host.live.tick(2.5);
    host.drain();
    assert_eq!(host.opens, [0, 15]);
    host.open();
    host.take();
    host.attach(15, 3, 1.0, 3.0);
    assert!(host.take().contains(&Effect::Close));
    assert_eq!(host.opens, [0, 15, 0]);
    assert!(host.live.state().items.is_empty());
    assert_eq!(host.live.state().last_seq, 0);
}

#[test]
fn a_new_created_at_is_another_log_too() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("basic-turn", 1.0);
    host.live.closed(2.0);
    host.live.tick(2.5);
    host.drain();
    host.open();
    host.attach(15, 40, 2.0, 3.0);
    assert_eq!(host.opens.last(), Some(&0));
}

#[test]
fn a_replayed_running_shell_is_verified_once_and_a_404_marks_it_missing() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.take();
    let shell = json!({"id": "sh_1", "sessionId": "s1", "ordinal": 1, "command": "npm run dev", "label": "npm run dev", "cwd": "/repo",
        "owner": "user", "status": "running", "startedAt": 1, "bytes": 0, "cols": 80, "rows": 24});
    let row = json!({"type": "user_message", "parentToolUseId": null, "synthetic": true, "replay": true, "shell": shell,
        "message": {"role": "user", "content": "<local-command-stdout>$ npm run dev\nlistening</local-command-stdout>"}});
    host.frame(event_frame(1, row.clone()), 1.0);
    host.frame(event_frame(2, row), 1.0);
    let verifies: Vec<Effect> = host.take().into_iter().filter(|e| matches!(e, Effect::VerifyShell { .. })).collect();
    assert_eq!(verifies, [Effect::VerifyShell { shell_id: "sh_1".into() }]);
    host.live.shell_verified("sh_1", None);
    host.drain();
    let missing = host.live.state().items.iter().any(|item| matches!(item, Item::Shell(shell) if shell.missing));
    assert!(missing);
    assert!(host.changed().transcript);
}

#[test]
fn a_gateway_never_reached_is_unreachable_and_a_lost_one_offline() {
    let mut host = Host::new();
    assert_eq!(host.live.connection(), ConnectionState::Connecting);
    let mut now = 0.0;
    for _ in 0..3 {
        host.live.closed(now);
        now += 20.0;
        host.live.tick(now);
        host.drain();
    }
    assert_eq!(host.live.connection(), ConnectionState::Unreachable);
    host.open();
    assert_eq!(host.live.connection(), ConnectionState::Live);
    for _ in 0..3 {
        host.live.closed(now);
        now += 20.0;
        host.live.tick(now);
        host.drain();
    }
    assert_eq!(host.live.connection(), ConnectionState::Offline);
}

#[test]
fn expanding_a_truncated_result_fetches_it_and_the_text_lands() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("tool-result-truncated-and-images", 1.0);
    host.take();
    let item = host.live.state().items.iter().position(|item| item.id() == "toolu_big").unwrap();
    let row = host.live.view().row_index_for_item(item);
    host.live.press(&TermPress::ExpandFull("toolu_big".into()), row);
    host.drain();
    assert!(host.take().contains(&Effect::FetchResult { call_id: "toolu_big".into() }));
    host.live.result_fetched("toolu_big", Some("the whole log"));
    host.drain();
    let text = host.live.state().items.iter().find_map(|item| match item {
        Item::ToolCall(call) if &*call.id == "toolu_big" => call.result.as_ref().map(|r| r.text.to_string()),
        _ => None,
    });
    assert_eq!(text.as_deref(), Some("the whole log"));
    assert!(!host.live.view().expansion().is_fetching("toolu_big"));
}

#[test]
fn commands_go_out_through_the_connection_and_shell_frames_pass_through() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.live.send("hello".into(), Vec::new());
    host.live.interrupt();
    host.drain();
    assert_eq!(host.sent, [json!({"type": "user_message", "text": "hello", "clientId": "n.1"}), json!({"type": "interrupt"})]);
    host.frame(json!({"type": "shell_output", "shellId": "sh_1", "data": "hi"}), 1.0);
    assert!(host.take().contains(&Effect::ShellOutput { shell_id: "sh_1".into(), data: "hi".into() }));
    assert_eq!(host.live.queued(), 1);
    host.frame(json!({"type": "ack", "clientId": "n.1"}), 1.0);
    assert_eq!(host.live.queued(), 0);
}

#[test]
fn a_protocol_error_and_a_mismatch_reach_the_chrome() {
    let mut host = Host::new();
    host.open();
    host.frame(json!({"type": "protocol_error", "message": "nope"}), 0.0);
    assert!(host.changed().chrome);
    assert_eq!(host.live.take_protocol_error().as_deref(), Some("nope"));
    host.frame(
        json!({"type": "attached", "protocolVersion": 99, "replayingFrom": 0,
            "session": {"id": "s1", "status": "idle", "cwd": "/repo", "createdAt": 1, "lastSeq": 0, "pendingPermissionCount": 0}}),
        0.0,
    );
    assert_eq!(host.live.protocol_mismatch(), Some(99));
}
