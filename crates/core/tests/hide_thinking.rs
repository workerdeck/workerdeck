use serde_json::json;
use wd_native::Engine;
use wd_native::rows::{Block, BuildOptions, Row, TerminalRows};

fn event(seq: u64, body: serde_json::Value) -> String {
    let mut body = body;
    body["seq"] = json!(seq);
    body["ts"] = json!(1_760_000_000_000u64 + seq);
    json!({ "type": "event", "event": body }).to_string()
}

fn message(uuid: &str, block: serde_json::Value) -> serde_json::Value {
    json!({ "type": "assistant_message", "uuid": uuid, "parentToolUseId": null, "message": { "role": "assistant", "content": [block] } })
}

fn shape(rows: &TerminalRows) -> Vec<String> {
    rows.rows
        .iter()
        .map(|row| match row {
            Row::Block(Block::Run(run)) => format!("run({})", run.run.len()),
            Row::Block(Block::Item(item)) => item.item.kind().raw().to_owned(),
            Row::Block(Block::Task(_)) => "task".to_owned(),
            _ => "other".to_owned(),
        })
        .collect()
}

#[test]
fn hidden_thinking_between_calls_does_not_split_the_run() {
    let mut lines =
        vec![event(1, json!({ "type": "user_message", "message": { "role": "user", "content": "go" }, "parentToolUseId": null }))];
    for turn in 0..3u64 {
        let seq = 2 + turn * 2;
        lines.push(event(seq, message(&format!("t{turn}"), json!({ "type": "thinking", "thinking": "hm", "signature": "s" }))));
        lines.push(event(
            seq + 1,
            message(&format!("c{turn}"), json!({ "type": "tool_use", "id": format!("call-{turn}"), "name": "Bash", "input": {} })),
        ));
    }
    let mut engine = Engine::default();
    engine.ingest_batch(lines.join("\n").as_bytes());
    let items = engine.state.items.clone();
    let shown = BuildOptions { recap_at: None, recap_label: "recap", no_fold: false, frame_task: None, hide_thinking: false };
    let hidden = BuildOptions { hide_thinking: true, ..shown };
    assert_eq!(
        shape(&TerminalRows::build_with(&items, &shown)),
        ["user", "thinking", "run(1)", "thinking", "run(1)", "thinking", "run(1)"]
    );
    let rows = TerminalRows::build_with(&items, &hidden);
    assert_eq!(shape(&rows), ["user", "run(3)"]);
    let Row::Block(Block::Run(run)) = &rows.rows[1] else { panic!("run") };
    assert_eq!(run.indices, [2, 4, 6]);
}
