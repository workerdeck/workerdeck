use serde_json::{Value, json};
use std::path::Path;
use wd_native::Engine;
use wd_native::book::HeightBook;
use wd_native::rows::{BuildOptions, TerminalRows, subagent_items, subagent_task};
use wd_native::scrubber::{Recap, ScrubberInput, build_clusters};

fn floats(value: Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().expect("number")),
        Value::Array(list) => Value::Array(list.into_iter().map(floats).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, floats(v))).collect()),
        other => other,
    }
}

fn variant(items: &[wd_native::transcript::Item], golden: &Value) -> Value {
    let frame = golden["frameParentId"].as_str();
    let recap_at = golden["recapAt"].as_u64().map(|at| at as usize);
    let task = frame.and_then(|id| subagent_task(items, id));
    let framed = frame.map(|id| subagent_items(items, id));
    let items = framed.as_deref().unwrap_or(items);
    let options = BuildOptions { recap_at, recap_label: "recap", no_fold: false, frame_task: task.as_deref(), hide_thinking: false };
    let rows = TerminalRows::build_with(items, &options);
    let heights: Vec<f64> = golden["heights"].as_array().expect("heights").iter().map(|h| h.as_f64().expect("height")).collect();
    assert_eq!(rows.len(), heights.len(), "row count");
    let mut offsets = vec![0.0];
    for height in &heights {
        offsets.push(offsets.last().unwrap() + height);
    }
    let book = HeightBook { heights, offsets };
    let bookmarks: Vec<String> =
        golden["bookmarks"].as_array().expect("bookmarks").iter().map(|id| id.as_str().expect("id").to_owned()).collect();
    let input = ScrubberInput {
        items,
        rows: &rows,
        book: &book,
        pending_approvals: golden["pending"].as_u64().expect("pending") as usize,
        bookmarks: &bookmarks,
        recap: rows.recap_row().map(|row_index| Recap { row_index, label: "recap".into() }),
        frame_parent_id: frame,
        viewport_h: golden["viewportH"].as_f64().expect("viewport"),
    };
    let clusters = build_clusters(&input, golden["railH"].as_f64().expect("rail"));
    let mut out = golden.clone();
    out["clusters"] = clusters
        .iter()
        .map(|cluster| {
            json!({
                "lane": cluster.lane.raw(),
                "kind": cluster.kind.raw(),
                "y": cluster.y,
                "h": cluster.h,
                "marks": cluster.marks.iter().map(|member| json!({
                    "kind": member.mark.kind.raw(),
                    "itemIndex": member.mark.item_index,
                    "rowIndex": member.mark.row_index,
                    "turnIndex": member.mark.turn_index,
                    "y": member.y,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    floats(out)
}

#[test]
fn rails_match_the_web_goldens() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("goldens")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".scrubber.json").map(str::to_owned))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no scrubber goldens: run `pnpm fixtures:golden`");
    let mut failures = Vec::new();
    let mut checked = 0;
    for name in names {
        let mut engine = Engine::default();
        engine.ingest_batch(&std::fs::read(dir.join(format!("{name}.events.jsonl"))).expect("events"));
        let goldens: Value =
            serde_json::from_slice(&std::fs::read(dir.join(format!("{name}.scrubber.json"))).expect("golden")).expect("json");
        for golden in goldens.as_array().expect("variants") {
            checked += 1;
            let want = floats(golden.clone());
            let got = variant(&engine.state.items, golden);
            if want != got {
                failures.push(format!(
                    "{name} {}:\n  want {}\n  got  {}",
                    golden["name"],
                    serde_json::to_string(&want["clusters"]).unwrap(),
                    serde_json::to_string(&got["clusters"]).unwrap()
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {checked} rails differ:\n{}", failures.len(), failures.join("\n"));
}
