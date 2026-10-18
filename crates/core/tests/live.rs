use serde_json::{Value, json};
use std::path::Path;
use wd_native::controller::live::{Changed, ConnectionState, Effect, LiveSession};
use wd_native::controller::replay::STALL_SECONDS;
use wd_native::controller::shell::ShellPhase;
use wd_native::controller::transcript::{Navigation, TranscriptView, Update};
use wd_native::expansion::TermPress;
use wd_native::planner::Metrics;
use wd_native::transcript::Item;
use wd_native::vt::VtKey;

const METRICS: Metrics = Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 };

struct Host {
    live: LiveSession,
    effects: Vec<Effect>,
    sent: Vec<Value>,
    opens: Vec<i64>,
}

impl Host {
    fn new() -> Self {
        let mut host =
            Host { live: LiveSession::new(0, true, "n".into(), METRICS), effects: Vec::new(), sent: Vec::new(), opens: Vec::new() };
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

    fn close_and_reopen(&mut self) {
        self.live.closed(5.0);
        self.drain();
        self.live.tick(100.0);
        self.drain();
        self.open();
        self.attach(0, 0, 1.0, 100.0);
    }

    fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    fn changed(&mut self) -> Changed {
        self.take().into_iter().fold(Changed::default(), |acc, effect| match effect {
            Effect::Changed(c) => Changed {
                transcript: acc.transcript || c.transcript,
                chrome: acc.chrome || c.chrome,
                progress: acc.progress || c.progress,
                shells: acc.shells || c.shells,
                frames: acc.frames || c.frames,
                prompt: acc.prompt || c.prompt,
            },
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
    let verifies = requests(host.take());
    assert_eq!(verifies.len(), 1);
    assert_eq!((verifies[0].1, verifies[0].2.as_str()), ("GET", "/shells/sh_1"));
    host.live.responded(verifies[0].0, 404, "");
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
    let fetch = requests(host.take()).pop().expect("a result fetch");
    assert_eq!(fetch.1, "GET");
    assert!(fetch.2.starts_with("/events/") && fetch.2.ends_with("/result?toolUseId=toolu_big&imageRefs=1"), "{}", fetch.2);
    host.live.responded(
        fetch.0,
        200,
        r#"{"seq": 3, "toolUseId": "toolu_big", "content": [{"type": "text", "text": "the whole log"}], "isError": false}"#,
    );
    host.drain();
    let text = host.live.state().items.iter().find_map(|item| match item {
        Item::ToolCall(call) if &*call.id == "toolu_big" => call.result.as_ref().map(|r| r.text.to_string()),
        _ => None,
    });
    assert_eq!(text.as_deref(), Some("the whole log"));
    assert!(!host.live.view().expansion().is_fetching("toolu_big"));
}

#[test]
fn commands_go_out_through_the_connection_and_stray_shell_frames_are_dropped() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.live.send("hello".into(), Vec::new());
    host.live.interrupt();
    host.drain();
    assert_eq!(host.sent, [json!({"type": "user_message", "text": "hello", "clientId": "n.1"}), json!({"type": "interrupt"})]);
    host.take();
    host.frame(json!({"type": "shell_output", "shellId": "sh_1", "data": "hi"}), 1.0);
    assert!(!host.changed().shells);
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

fn shell_record(status: &str, exit_code: Option<i32>) -> Value {
    let mut shell = json!({"id": "sh_1", "sessionId": "s1", "ordinal": 3, "command": "npm run dev\n--port 1", "label": "", "cwd": "/repo",
        "owner": "user", "status": status, "startedAt": 1, "bytes": 0, "cols": 80, "rows": 24});
    if let Some(code) = exit_code {
        shell["exitCode"] = json!(code);
    }
    shell
}

fn shell_frames(host: &mut Host) -> Vec<Value> {
    std::mem::take(&mut host.sent).into_iter().filter(|frame| frame["type"].as_str().is_some_and(|t| t.starts_with("shell_"))).collect()
}

#[test]
fn an_open_shell_feeds_its_own_screen_and_answers_the_pty() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.live.open_shell("sh_1", None, 10, 2);
    host.drain();
    assert_eq!(shell_frames(&mut host), [json!({"type": "shell_attach", "shellId": "sh_1", "cols": 20, "rows": 4})]);
    let shell = host.live.shell("sh_1").unwrap();
    assert_eq!((shell.title(), shell.status_text()), ("Shell".to_owned(), "connecting…".to_owned()));
    host.live.shell_text("sh_1", "early");
    host.drain();
    assert!(shell_frames(&mut host).is_empty());

    host.take();
    host.frame(
        json!({"type": "shell_attached", "shellId": "sh_1", "shell": shell_record("running", None), "cols": 80, "rows": 24,
        "scrollback": "hello\u{1b}[6n"}),
        1.0,
    );
    assert!(host.changed().shells);
    let shell = host.live.shell("sh_1").unwrap();
    assert_eq!(shell.phase(), &ShellPhase::Live);
    assert_eq!(shell.size(), (80, 24));
    assert_eq!((shell.screen().cols, shell.screen().rows), (80, 24));
    assert_eq!(shell.title(), "#3 npm run dev");
    assert!(shell.can_type());
    assert_eq!(shell_frames(&mut host), [json!({"type": "shell_input", "shellId": "sh_1", "data": "\u{1b}[1;6R"})]);

    host.live.shell_key("sh_1", VtKey::Enter);
    host.live.shell_paste("sh_1", "a\nb");
    host.live.shell_resize("sh_1", 80, 24);
    host.live.shell_resize("sh_1", 100, 30);
    host.drain();
    assert_eq!(
        shell_frames(&mut host),
        [
            json!({"type": "shell_input", "shellId": "sh_1", "data": "\r"}),
            json!({"type": "shell_input", "shellId": "sh_1", "data": "a\rb"}),
            json!({"type": "shell_resize", "shellId": "sh_1", "cols": 100, "rows": 30}),
        ]
    );

    let before = host.live.shell("sh_1").unwrap().revision();
    host.frame(json!({"type": "shell_output", "shellId": "sh_1", "data": "more"}), 1.0);
    assert!(host.live.shell("sh_1").unwrap().revision() > before);
    assert!(host.changed().shells);
}

#[test]
fn a_detach_ends_the_stream_and_the_record_says_why() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.live.open_shell("sh_1", None, 80, 24);
    host.frame(
        json!({"type": "shell_attached", "shellId": "sh_1", "shell": shell_record("running", None), "cols": 80, "rows": 24,
        "scrollback": ""}),
        1.0,
    );
    host.take();
    host.frame(json!({"type": "shell_detached", "shellId": "sh_1", "reason": "backpressure"}), 1.0);
    let verify = requests(host.take()).pop().expect("a verify");
    assert_eq!(verify.2, "/shells/sh_1");
    let shell = host.live.shell("sh_1").unwrap();
    assert_eq!((shell.status_text(), shell.can_type()), ("backpressure".to_owned(), false));

    host.live.responded(verify.0, 200, &json!({"shell": shell_record("exited", Some(1))}).to_string());
    host.drain();
    assert!(host.changed().shells);
    let shell = host.live.shell("sh_1").unwrap();
    assert_eq!((shell.status_text(), shell.is_running()), ("exit 1".to_owned(), false));

    shell_frames(&mut host);
    host.close_and_reopen();
    assert!(shell_frames(&mut host).is_empty());
}

#[test]
fn a_reconnect_reattaches_a_watching_shell_at_its_current_size_and_a_closed_one_never() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.live.open_shell("sh_1", None, 80, 24);
    host.live.shell_resize("sh_1", 90, 20);
    host.drain();
    shell_frames(&mut host);
    host.close_and_reopen();
    assert_eq!(shell_frames(&mut host), [json!({"type": "shell_attach", "shellId": "sh_1", "cols": 90, "rows": 20})]);

    host.live.close_shell("sh_1");
    host.drain();
    assert_eq!(shell_frames(&mut host), [json!({"type": "shell_detach", "shellId": "sh_1"})]);
    assert!(host.live.shell("sh_1").is_none());
    host.close_and_reopen();
    assert!(shell_frames(&mut host).is_empty());
}

#[test]
fn kill_asks_the_platform_and_leaves_the_stream_alone() {
    let mut host = Host::new();
    host.open();
    host.live.open_shell("sh_1", None, 80, 24);
    host.drain();
    host.take();
    host.live.kill_shell("sh_1");
    let kill = requests(host.live.take_effects()).pop().expect("a kill");
    assert_eq!((kill.1, kill.2.as_str()), ("POST", "/shells/sh_1/kill"));
    assert!(host.live.shell("sh_1").unwrap().is_attached());
}

fn frame_rows(items: &[Item], task_id: &str) -> Vec<String> {
    let frame_items = wd_native::rows::subagent_items(items, task_id);
    let task = wd_native::rows::subagent_task(items, task_id);
    let mut view = TranscriptView::new(METRICS, Some(task_id.into()));
    view.update(Update {
        items: &frame_items,
        metrics: METRICS,
        pending_approvals: 0,
        frame_task: task.as_deref(),
        hide_thinking: false,
        now_ms: 0.0,
    });
    view.rows().rows.iter().map(|row| row.key().into_owned()).collect()
}

fn keys(view: &TranscriptView) -> Vec<String> {
    view.rows().rows.iter().map(|row| row.key().into_owned()).collect()
}

#[test]
fn a_frame_folds_the_subagents_own_items_and_follows_the_stream() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("subagent", 1.0);
    host.take();
    host.live.open_frame("toolu_task");
    host.drain();
    assert!(host.changed().frames);
    let frame = host.live.frame("toolu_task").unwrap();
    assert_eq!(keys(frame), frame_rows(&host.live.state().items, "toolu_task"));
    assert!(keys(frame).iter().all(|key| !key.starts_with("task:")));

    let before = keys(host.live.frame("toolu_task").unwrap()).len();
    let child = json!({"type": "assistant_message", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]},
        "parentToolUseId": "toolu_task", "uuid": "a-99"});
    host.frame(event_frame(14, child), 2.0);
    assert!(host.changed().frames);
    assert_eq!(keys(host.live.frame("toolu_task").unwrap()).len(), before + 1);

    host.live.close_frame("toolu_task");
    host.drain();
    assert!(host.changed().frames);
    assert!(host.live.frame("toolu_task").is_none());
}

#[test]
fn a_press_inside_a_frame_expands_there_and_navigates_through_the_session() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("subagent", 1.0);
    host.live.open_frame("toolu_task");
    host.take();
    let frame = host.live.frame("toolu_task").unwrap();
    let row = frame.rows().rows.iter().position(|row| row.key().contains("toolu_ls")).expect("ls row");
    let key = frame.row(row).map(wd_native::expansion::row_expansion_keys).unwrap_or_default();
    let toggle = TermPress::Toggle(key.into_iter().next().expect("expandable"));
    host.live.frame_press("toolu_task", &toggle, row);
    host.drain();
    assert!(host.changed().frames);
    assert!(!host.live.frame("toolu_task").unwrap().expansion().is_empty());
    assert!(host.live.view().expansion().is_empty());

    host.live.set_navigation(Navigation { subagents: true, shells: true });
    host.live.frame_press("toolu_task", &TermPress::KillShell("sh_9".into()), 0);
    assert_eq!(requests(host.live.take_effects()).pop().map(|r| r.2), Some("/shells/sh_9/kill".to_owned()));
}

#[test]
fn a_frame_strip_reads_the_spawning_call_and_a_missing_task_says_so() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("subagent", 1.0);
    let strip = host.live.frame_strip("toolu_task");
    assert!(strip.status.is_some());
    assert_ne!(strip.name, "Sub-agent");
    let missing = host.live.frame_strip("toolu_nowhere");
    assert_eq!((missing.name.as_str(), missing.status), ("Sub-agent", None));
}

#[test]
fn a_tool_call_resolves_to_the_row_that_holds_it() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("subagent", 1.0);
    let row = host.live.row_for_tool_call("toolu_task").expect("the task row");
    assert!(host.live.view().rows().rows[row].key().contains("toolu_task"));
    assert_eq!(host.live.row_for_tool_call("toolu_nowhere"), None);
}

#[test]
fn a_nested_task_inside_a_frame_expands_instead_of_opening_a_takeover() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("subagent", 1.0);
    host.live.set_navigation(Navigation { subagents: true, shells: true });
    host.live.open_frame("toolu_task");
    host.take();
    host.live.frame_press("toolu_task", &TermPress::OpenSubagent("toolu_inner".into()), 0);
    let effects = host.live.take_effects();
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::OpenSubagent { .. })));
    host.live.press(&TermPress::OpenSubagent("toolu_task".into()), 0);
    assert!(host.live.take_effects().iter().any(|effect| matches!(effect, Effect::OpenSubagent { .. })));
}

fn requests(effects: Vec<Effect>) -> Vec<(u64, &'static str, String)> {
    effects
        .into_iter()
        .filter_map(|effect| match effect {
            Effect::Request { id, method, path, scoped: true } => Some((id, method, path)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_failed_result_fetch_lets_a_later_press_try_again() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("tool-result-truncated-and-images", 1.0);
    host.take();
    let item = host.live.state().items.iter().position(|item| item.id() == "toolu_big").unwrap();
    let row = host.live.view().row_index_for_item(item);
    host.live.press(&TermPress::ExpandFull("toolu_big".into()), row);
    host.drain();
    let fetch = requests(host.take()).pop().expect("a result fetch");
    host.live.press(&TermPress::ExpandFull("toolu_big".into()), row);
    assert!(requests(host.live.take_effects()).is_empty(), "one fetch at a time");
    host.live.responded(fetch.0, 0, "");
    host.drain();
    assert!(!host.live.view().expansion().is_fetching("toolu_big"));
    host.live.responded(fetch.0, 200, "{}");
    host.live.press(&TermPress::ExpandFull("toolu_big".into()), row);
    host.drain();
    assert_eq!(requests(host.take()).len(), 1);
}

#[test]
fn a_verify_that_got_no_answer_may_be_asked_again() {
    let mut host = Host::new();
    host.open();
    host.live.open_shell("sh_1", None, 80, 24);
    host.drain();
    host.frame(
        json!({"type": "shell_attached", "shellId": "sh_1", "shell": shell_record("running", None), "cols": 80, "rows": 24,
        "scrollback": ""}),
        1.0,
    );
    host.take();
    host.frame(json!({"type": "shell_detached", "shellId": "sh_1", "reason": "backpressure"}), 1.0);
    let verify = requests(host.take()).pop().expect("a verify");
    host.live.responded(verify.0, 502, "");
    host.frame(json!({"type": "shell_detached", "shellId": "sh_1", "reason": "backpressure"}), 1.0);
    assert_eq!(requests(host.take()).len(), 1);
}

#[test]
fn a_status_event_reaches_the_chrome_and_an_unchanged_one_does_not() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    assert!(host.live.chrome().busy);
    host.take();
    host.frame(event_frame(1, json!({"type": "status_changed", "status": "idle"})), 1.0);
    assert!(host.changed().chrome);
    assert!(!host.live.chrome().busy);
    assert_eq!(host.live.chrome().status_label, "Idle");
    host.frame(event_frame(2, json!({"type": "status_changed", "status": "idle"})), 2.0);
    assert!(!host.changed().chrome);
}

#[test]
fn a_session_without_reported_models_offers_its_profile_catalog_and_switches_over_the_socket() {
    let mut host = Host::new();
    host.open();
    host.frame(
        json!({"type": "attached", "protocolVersion": 1, "replayingFrom": 0, "acks": true,
            "session": {"id": "s1", "status": "idle", "cwd": "/repo", "createdAt": 1.0, "lastSeq": 0, "pendingPermissionCount": 0, "profile": "codex",
                "model": "gpt-5.6", "effort": "high", "permissionMode": "default", "canBypassPermissions": false,
                "capabilities": {"permissionModes": ["default", "bypassPermissions", "acceptEdits"], "reasoningEfforts": ["low", "high"]}}}),
        0.0,
    );
    let catalog = host.take().into_iter().find_map(|effect| match effect {
        Effect::Request { id, method: "GET", path, scoped: false } if path == "/profiles" => Some(id),
        _ => None,
    });
    let id = catalog.expect("the catalog is fetched once the profile is known");
    assert!(host.live.model_picker().main.is_empty());
    let body = json!({"profiles": [{"name": "other", "models": []}, {"name": "codex", "models": [
        {"value": "gpt-5.6", "displayName": "GPT-5.6", "reasoningEfforts": ["low", "medium", "high"]},
        {"value": "gpt-5.5", "displayName": "GPT-5.5"}]}]});
    host.live.responded(id, 200, &body.to_string());
    host.drain();
    assert!(host.changed().chrome);
    let picker = host.live.model_picker();
    let titles: Vec<&str> = picker.main.iter().map(|row| row.title.as_str()).collect();
    assert_eq!(titles, ["GPT-5.6"]);
    assert!(picker.main[0].selected);
    assert_eq!(picker.efforts.len(), 4);
    assert_eq!(host.live.chrome().model_label.as_deref(), Some("GPT-5.6 \u{00B7} high"));
    let modes = host.live.mode_picker();
    assert!(modes.rows.last().unwrap().disabled && modes.rows[0].is_default && modes.rows[0].selected);

    host.live.set_model(Some("gpt-5.5".into()));
    host.live.set_effort(None);
    host.drain();
    let sent: Vec<&str> = host.sent.iter().filter_map(|frame| frame["type"].as_str()).collect();
    assert!(sent.ends_with(&["set_model", "set_effort"]), "{sent:?}");

    host.close_and_reopen();
    assert!(host.take().iter().all(|effect| !matches!(effect, Effect::Request { scoped: false, .. })));
}

#[test]
fn a_failed_catalog_fetch_is_retried_on_the_next_attach_but_a_missing_route_is_not() {
    let attached = json!({"type": "attached", "protocolVersion": 1, "replayingFrom": 0, "acks": true,
        "session": {"id": "s1", "status": "idle", "cwd": "/repo", "createdAt": 1.0, "lastSeq": 0, "pendingPermissionCount": 0, "profile": "codex"}});
    let catalog = |effects: Vec<Effect>| {
        effects.into_iter().find_map(|effect| match effect {
            Effect::Request { id, method: "GET", path, scoped: false } if path == "/profiles" => Some(id),
            _ => None,
        })
    };
    for (status, retried) in [(0, true), (503, true), (404, false)] {
        let mut host = Host::new();
        host.open();
        host.frame(attached.clone(), 0.0);
        let id = catalog(host.take()).expect("the first attach fetches the catalog");
        host.live.responded(id, status, "");
        host.drain();
        host.take();
        host.live.closed(5.0);
        host.drain();
        host.live.tick(100.0);
        host.drain();
        host.open();
        host.frame(attached.clone(), 101.0);
        let again = catalog(host.take());
        assert_eq!(again.is_some(), retried, "status {status}");
        if let Some(id) = again {
            let body = json!({"profiles": [{"name": "codex", "models": [{"value": "gpt-5.6", "displayName": "GPT-5.6"}]}]});
            host.live.responded(id, 200, &body.to_string());
            host.drain();
            assert_eq!(host.live.model_picker().main.len(), 1, "status {status}");
        }
    }
}

#[test]
fn sleep_stays_off_from_the_send_until_the_session_answers_and_lists_flag_the_chrome() {
    let mut host = Host::new();
    host.open();
    host.frame(
        json!({"type": "attached", "protocolVersion": 1, "replayingFrom": 0, "acks": true,
            "session": {"id": "s1", "status": "idle", "cwd": "/repo", "createdAt": 1.0, "lastSeq": 0, "pendingPermissionCount": 0,
                "capabilities": {"engineSleep": true, "attachments": ["image"]}}}),
        0.0,
    );
    host.frame(event_frame(1, json!({"type": "status_changed", "status": "idle"})), 1.0);
    let chrome = host.live.chrome();
    assert!(chrome.can_sleep);
    assert_eq!((chrome.cwd.as_deref(), chrome.attachment_kinds), (Some("/repo"), vec!["image".to_owned()]));
    host.take();
    host.live.sleep();
    host.drain();
    assert!(host.changed().chrome);
    assert!(!host.live.chrome().can_sleep);
    host.frame(event_frame(2, json!({"type": "engine_sleep", "asleep": true})), 2.0);
    assert!(!host.live.chrome().can_sleep);
    host.frame(event_frame(3, json!({"type": "engine_sleep", "asleep": false})), 3.0);
    assert!(host.live.chrome().can_sleep);

    host.take();
    host.frame(event_frame(4, json!({"type": "skills", "skills": [{"name": "pdf", "enabled": true}]})), 4.0);
    assert!(host.changed().chrome);
    assert_eq!(host.live.skills()[0].name, "pdf");
    host.frame(
        event_frame(5, json!({"type": "capabilities", "models": [], "commands": [{"name": "review", "argumentHint": "<pr>"}]})),
        5.0,
    );
    assert!(host.changed().chrome);
    assert_eq!(host.live.commands()[0].argument_hint.as_deref(), Some("<pr>"));
}

fn attach_archived(host: &mut Host, replaying_from: i64, last_seq: i64, epoch: i64, now: f64) {
    host.frame(
        json!({"type": "attached", "protocolVersion": 1, "replayingFrom": replaying_from, "acks": true,
            "session": {"id": "s1", "status": "closed", "cwd": "/repo", "createdAt": 1.0, "lastSeq": last_seq, "epoch": epoch,
                "pendingPermissionCount": 0, "archived": true, "supersededBy": "s2"}}),
        now,
    );
}

#[test]
fn a_live_session_superseded_event_reaches_the_chrome() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.take();
    assert_eq!(host.live.chrome().superseded_by, None);
    host.frame(event_frame(1, json!({"type": "session_superseded", "successor": "s2"})), 1.0);
    assert!(host.changed().chrome);
    assert_eq!(host.live.superseded_by(), Some("s2"));
    assert_eq!(host.live.chrome().superseded_by.as_deref(), Some("s2"));
    assert!(!host.live.chrome().archived);
    assert!(host.live.state().items.is_empty());
}

#[test]
fn an_archive_attach_names_its_successor_and_draws_read_only() {
    let mut host = Host::new();
    host.open();
    attach_archived(&mut host, 0, 0, 1, 0.0);
    let chrome = host.live.chrome();
    assert!(chrome.archived);
    assert!(!chrome.enabled);
    assert_eq!(chrome.superseded_by.as_deref(), Some("s2"));
}

#[test]
fn a_session_first_seen_archived_is_another_log() {
    let mut host = Host::new();
    host.open();
    host.attach(0, 0, 1.0, 0.0);
    host.events("basic-turn", 1.0);
    host.live.closed(2.0);
    host.live.tick(2.5);
    host.drain();
    host.open();
    attach_archived(&mut host, 15, 40, 1, 3.0);
    assert_eq!(host.opens.last(), Some(&0));
    assert!(host.live.state().items.is_empty());
}

#[test]
fn an_archive_attach_with_a_new_epoch_resets_but_the_same_epoch_resumes() {
    let mut host = Host::new();
    host.open();
    attach_archived(&mut host, 0, 15, 1, 0.0);
    host.events("basic-turn", 1.0);
    host.live.closed(2.0);
    host.live.tick(2.5);
    host.drain();
    host.open();
    attach_archived(&mut host, 15, 15, 1, 3.0);
    assert_eq!(host.opens.last(), Some(&15));
    assert!(!host.live.state().items.is_empty());
    host.live.closed(4.0);
    host.live.tick(4.5);
    host.drain();
    host.open();
    attach_archived(&mut host, 15, 15, 2, 5.0);
    assert_eq!(host.opens.last(), Some(&0));
    assert!(host.live.state().items.is_empty());
}
