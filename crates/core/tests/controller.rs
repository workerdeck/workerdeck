use serde_json::json;
use std::sync::Arc;
use wd_native::book::HeightBook;
use wd_native::controller::replay::{CEILING_SECONDS, ReplayHold, STALL_SECONDS, initial_replay_target};
use wd_native::controller::scroll::TranscriptScrollGeometry;
use wd_native::controller::seq_index::{DeepLinkPlacement, TranscriptSeqIndex, deep_link_placement, deep_link_seq_survives};
use wd_native::controller::sticky::{Pin, resolve};
use wd_native::planner::Metrics;
use wd_native::rows::TerminalRows;
use wd_native::transcript::{Item, NoticeLevel, ToolCall, ToolCallStatus};

fn notices(ids: &[String]) -> Vec<Item> {
    ids.iter().map(|id| Item::Notice { id: id.as_str().into(), level: NoticeLevel::Info, text: id.as_str().into() }).collect()
}

fn named(ids: &[&str]) -> Vec<Item> {
    notices(&ids.iter().map(|id| id.to_string()).collect::<Vec<_>>())
}

fn scripted(script: &[(i64, usize)]) -> TranscriptSeqIndex {
    let mut index = TranscriptSeqIndex::new();
    let mut ids: Vec<String> = Vec::new();
    for &(seq, appended) in script {
        let before = ids.clone();
        for _ in 0..appended {
            ids.push(format!("r{}", ids.len()));
        }
        index.note(seq, &notices(&before), &notices(&ids));
    }
    index
}

#[test]
fn seq_index_empty_answers_nothing() {
    assert_eq!(TranscriptSeqIndex::new().item_for_seq(7), None);
    assert!(TranscriptSeqIndex::new().is_empty());
}

#[test]
fn seq_index_finds_appends_and_nearest_after() {
    let index = scripted(&[(2, 1), (5, 2), (9, 1)]);
    assert_eq!(index.item_for_seq(2), Some(0));
    assert_eq!(index.item_for_seq(5), Some(1));
    assert_eq!(index.item_for_seq(9), Some(3));
    let index = scripted(&[(2, 1), (6, 0), (9, 1)]);
    assert_eq!(index.item_for_seq(6), Some(1));
    assert_eq!(index.len(), 2);
    assert_eq!(scripted(&[(40, 1), (44, 1)]).item_for_seq(3), Some(0));
    assert_eq!(scripted(&[(2, 1), (5, 1)]).item_for_seq(6), None);
}

#[test]
fn seq_index_resets_and_supersessions() {
    let mut built = TranscriptSeqIndex::new();
    built.note(2, &[], &named(&["a"]));
    built.note(5, &named(&["a"]), &named(&["a", "b", "c"]));
    built.note(8, &named(&["a", "b", "c"]), &[]);
    assert!(built.is_empty());
    assert_eq!(built.item_for_seq(2), None);
    built.note(11, &[], &named(&["d"]));
    assert_eq!(built.item_for_seq(11), Some(0));

    let mut built = TranscriptSeqIndex::new();
    built.note(2, &[], &named(&["a", "b", "c", "d"]));
    built.note(8, &named(&["a", "b", "c", "d"]), &named(&["summary"]));
    assert_eq!(built.len(), 1);
    assert_eq!(built.item_for_seq(8), Some(0));

    let mut built = TranscriptSeqIndex::new();
    built.note(2, &[], &named(&["prompt"]));
    built.note(4, &named(&["prompt"]), &named(&["prompt", "stream-thinking"]));
    built.note(7, &named(&["prompt", "stream-thinking"]), &named(&["prompt", "msg-0"]));
    assert_eq!(built.item_for_seq(2), Some(0));
    assert_eq!(built.item_for_seq(7), Some(1));

    let mut built = TranscriptSeqIndex::new();
    built.note(2, &[], &named(&["prompt"]));
    built.note(4, &named(&["prompt"]), &named(&["prompt", "stream-text"]));
    built.note(7, &named(&["prompt", "stream-text"]), &named(&["prompt", "msg-0", "msg-1"]));
    assert_eq!(built.item_for_seq(7), Some(1));
    assert_eq!(built.item_for_seq(2), Some(0));

    let mut built = TranscriptSeqIndex::new();
    built.note(5, &[], &named(&["a"]));
    built.note(5, &named(&["a"]), &named(&["a", "b"]));
    assert_eq!(built.len(), 1);
    assert_eq!(built.item_for_seq(5), Some(0));
}

#[test]
fn seq_index_long_history() {
    let mut built = TranscriptSeqIndex::new();
    let mut ids: Vec<String> = Vec::new();
    for step in 0..500i64 {
        let before = ids.clone();
        if step % 2 == 0 {
            ids.push(format!("r{}", ids.len()));
        }
        built.note(step * 2 + 1, &notices(&before), &notices(&ids));
    }
    assert_eq!(built.item_for_seq(1), Some(0));
    assert_eq!(built.item_for_seq(5), Some(1));
    assert_eq!(built.item_for_seq(4), Some(1));
    assert_eq!(built.item_for_seq(997), Some(249));
}

#[test]
fn deep_links() {
    assert!(deep_link_seq_survives(None, None));
    assert!(deep_link_seq_survives(Some(2), Some(2)));
    assert!(!deep_link_seq_survives(None, Some(1)));
    assert!(!deep_link_seq_survives(Some(1), Some(2)));
    assert_eq!(deep_link_placement(Some(27), 1503, 8472), DeepLinkPlacement::Item { index: 27, complete: false });
    assert_eq!(deep_link_placement(Some(27), 8472, 8472), DeepLinkPlacement::Item { index: 27, complete: true });
    assert_eq!(deep_link_placement(Some(27), 8490, 8472), DeepLinkPlacement::Item { index: 27, complete: true });
    assert_eq!(deep_link_placement(None, 1503, 8472), DeepLinkPlacement::Pending);
    assert_eq!(deep_link_placement(None, 8472, 8472), DeepLinkPlacement::Unplaceable);
}

#[test]
fn replay_hold() {
    assert_eq!(initial_replay_target(0, 812), Some(812));
    assert_eq!(initial_replay_target(400, 812), None);
    assert_eq!(initial_replay_target(0, 0), None);

    let mut hold = ReplayHold::new(812, 0, 0.0);
    hold.advance(811, 0.1);
    assert!(!hold.landed());
    hold.advance(812, 0.2);
    assert!(hold.landed());

    let mut hold = ReplayHold::new(5000, 0, 0.0);
    for t in 1..=6 {
        hold.advance(t * 500, t as f64);
        assert!(!hold.expired(t as f64));
    }
    assert!(!hold.landed());

    let mut hold = ReplayHold::new(5000, 0, 0.0);
    hold.advance(400, 1.0);
    assert!(!hold.expired(1.0 + STALL_SECONDS - 0.01));
    assert!(hold.expired(1.0 + STALL_SECONDS));

    let mut hold = ReplayHold::new(5000, 0, 0.0);
    hold.advance(400, 0.0);
    assert!(!hold.advance(400, 1.4));
    assert!(hold.expired(STALL_SECONDS));

    let mut hold = ReplayHold::new(1_000_000, 0, 0.0);
    let mut t = 0.0;
    while t < CEILING_SECONDS {
        t += 1.0;
        hold.advance(t as i64, t);
    }
    assert!(hold.expired(CEILING_SECONDS));
    assert_eq!(hold.deadline(), CEILING_SECONDS);
}

fn geometry(content: f64, frame: f64, inset_top: f64, inset_bottom: f64) -> TranscriptScrollGeometry {
    TranscriptScrollGeometry { content_height: content, frame_height: frame, inset_top, inset_bottom }
}

#[test]
fn scroll_geometry() {
    let tall = geometry(2329.0, 633.0, 100.0, 90.0);
    assert_eq!(tall.top(), -100.0);
    assert_eq!(tall.bottom(), 1786.0);
    let short = geometry(85.0, 633.0, 100.0, 0.0);
    assert_eq!(short.bottom(), short.top());
    let tall = geometry(2329.0, 633.0, 100.0, 0.0);
    assert_eq!(tall.clamped(-500.0), -100.0);
    assert_eq!(tall.clamped(300.0), 300.0);
    assert_eq!(tall.clamped(9999.0), tall.bottom());
    let tall = geometry(2329.0, 633.0, 0.0, 0.0);
    assert!(tall.pins_after_jump(tall.bottom(), 44.0, true));
    assert!(tall.pins_after_jump(tall.bottom() - 44.0, 44.0, true));
    assert!(!tall.pins_after_jump(tall.bottom() - 45.0, 44.0, true));
    assert!(!tall.pins_after_jump(0.0, 44.0, true));
    let filling = geometry(2329.0, 0.0, 0.0, 0.0);
    assert!(filling.pins_after_jump(2295.0, 44.0, true));
    assert!(!filling.pins_after_jump(2295.0, 44.0, false));
    let short = geometry(85.0, 633.0, 0.0, 0.0);
    assert!(short.pins_after_jump(short.top(), 44.0, true));
    assert!(!short.pins_after_jump(short.top(), 44.0, false));
}

const METRICS: Metrics = Metrics { cell: 8.0, line: 18.0, width: 640.0, font_size: 13.0 };

fn user(id: &str, text: &str, parent: Option<&str>) -> Item {
    Item::User { id: id.into(), text: text.into(), parent_tool_use_id: parent.map(Into::into), attachments: None, origin: None }
}

fn answer(id: &str) -> Item {
    Item::AssistantText { id: id.into(), text: "an answer".into(), streaming: false, parent_tool_use_id: None }
}

fn transcript(turns: usize) -> TerminalRows {
    let items: Vec<Item> =
        (0..turns).flat_map(|turn| [user(&format!("u{turn}"), &format!("prompt {turn}"), None), answer(&format!("a{turn}"))]).collect();
    TerminalRows::build(&items)
}

fn book(rows: &TerminalRows) -> HeightBook {
    HeightBook::new(rows, &METRICS, None)
}

#[test]
fn sticky_prompt_rows_skip_briefs_and_peers() {
    let task = ToolCall {
        id: "t1".into(),
        name: "Task".into(),
        title: None,
        input: Arc::new(json!({})),
        parent_tool_use_id: None,
        status: ToolCallStatus::Running,
        result: None,
        ts: None,
        live_tail: None,
        patch: None,
        execution_id: None,
        backend: None,
        logs: None,
    };
    let rows = TerminalRows::build(&[
        user("u0", "do the thing", None),
        Item::ToolCall(Arc::new(task)),
        user("brief", "explore", Some("t1")),
        answer("a0"),
    ]);
    assert_eq!(rows.prompt_rows(), vec![rows.row_index_for_item(0)]);
    let peer = Item::User {
        id: "p1".into(),
        text: "ping from Alpha".into(),
        parent_tool_use_id: None,
        attachments: None,
        origin: Some(Arc::new(json!({"sessionId": "sess-a", "name": "Alpha"}))),
    };
    let rows = TerminalRows::build(&[user("u0", "do the thing", None), answer("a0"), peer, answer("a1")]);
    assert_eq!(rows.prompt_rows(), vec![rows.row_index_for_item(0)]);
}

#[test]
fn sticky_prompt_pins_and_hands_off() {
    let line = METRICS.line;
    let rows = transcript(3);
    let heights = book(&rows);
    let prompts = rows.prompt_rows();
    assert_eq!(resolve(&prompts, &rows, &heights, heights.offset(prompts[0]), line, None), None);

    let rows4 = transcript(4);
    let heights4 = book(&rows4);
    let prompts4 = rows4.prompt_rows();
    for &row in &prompts4 {
        let top = heights4.offset(row) + heights4.height(row) + 1.0;
        assert_eq!(resolve(&prompts4, &rows4, &heights4, top, line, None), Some(Pin { row, offset: 0.0 }));
    }

    let next = prompts[1];
    let edge = heights.offset(next) + if rows.gap_before(next) { line } else { 0.0 };
    assert_eq!(resolve(&prompts, &rows, &heights, edge - line, line, None), Some(Pin { row: prompts[0], offset: 0.0 }));
    assert_eq!(resolve(&prompts, &rows, &heights, edge - line / 2.0, line, None), Some(Pin { row: prompts[0], offset: -line / 2.0 }));
    assert_eq!(resolve(&prompts, &rows, &heights, edge, line, None), None);
    assert_eq!(resolve(&prompts, &rows, &heights, heights.offset(next), line, None).map(|pin| pin.row), Some(prompts[0]));

    let strip = line + 10.0;
    assert_eq!(resolve(&prompts, &rows, &heights, edge - line, line, Some(strip)).map(|pin| pin.offset), Some(line - strip));
    assert_eq!(resolve(&prompts, &rows, &heights, edge - strip, line, Some(strip)).map(|pin| pin.offset), Some(0.0));

    let mut step = 0.0;
    while step <= heights.total_height() {
        if let Some(pin) = resolve(&prompts, &rows, &heights, step, line, None) {
            assert!(pin.offset <= 0.0 && pin.offset >= -line);
        }
        step += 3.0;
    }
}

#[test]
fn sticky_prompt_degenerate_and_long() {
    let empty = TerminalRows::build(&[]);
    assert_eq!(resolve(&[], &empty, &book(&empty), 0.0, METRICS.line, None), None);
    let answers = TerminalRows::build(&[answer("a0"), answer("a1")]);
    assert!(answers.prompt_rows().is_empty());
    assert_eq!(resolve(&answers.prompt_rows(), &answers, &book(&answers), 999.0, METRICS.line, None), None);
    let rows = transcript(4000);
    let heights = book(&rows);
    let prompts = rows.prompt_rows();
    assert_eq!(prompts.len(), 4000);
    let pin = resolve(&prompts, &rows, &heights, heights.total_height(), METRICS.line, None);
    assert_eq!(pin.map(|pin| pin.row), prompts.last().copied());
}

#[test]
fn observe_answers_like_note_over_every_conformance_case() {
    use wd_native::protocol::{Frame, decode_frame};
    use wd_native::transcript::{TranscriptState, apply_event};
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance");
    let mut cases = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if !path.to_string_lossy().ends_with(".events.jsonl") {
            continue;
        }
        let body = std::fs::read(&path).unwrap();
        let (mut state, mut noted, mut observed, mut last) =
            (TranscriptState::default(), TranscriptSeqIndex::new(), TranscriptSeqIndex::new(), 0);
        for line in body.split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
            let Some(Frame::Event(event)) = decode_frame(line) else { continue };
            let seq = event.seq;
            last = last.max(seq);
            let before = state.items.clone();
            apply_event(&mut state, event);
            noted.note(seq, &before, &state.items);
            observed.observe(seq, &state.items);
        }
        for seq in 0..=last + 1 {
            assert_eq!(observed.item_for_seq(seq), noted.item_for_seq(seq), "{} seq {seq}", path.display());
        }
        cases += 1;
    }
    assert!(cases > 10);
}
