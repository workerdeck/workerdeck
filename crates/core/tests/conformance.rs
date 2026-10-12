use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use wd_native::Engine;
use wd_native::planner::plan;
use wd_native::projection::project;
use wd_native::vt::{CellText, Color, VtScreen};

const PROJECTION_PENDING: &[&str] = &[
    "attachments",
    "catalog-and-produced-files",
    "checklist",
    "compaction",
    "conversation-reset",
    "execution-states",
    "file-delivered",
    "ignored-events",
    "local-command-synthetic-and-caveat",
    "peer-message",
    "permission-round-trip",
    "reset-stacks-and-keeps-approvals",
    "session-state",
    "shell-row",
    "slash-command-text",
    "thinking-addressed",
    "tool-output-live-tail",
    "tool-result-patch",
    "tool-result-truncated-and-images",
    "turn-error",
];

const LINES_PENDING: &[&str] = &[
    "attachments",
    "compaction",
    "conversation-reset",
    "execution-states",
    "file-delivered",
    "ignored-events",
    "local-command-synthetic-and-caveat",
    "peer-message",
    "reset-stacks-and-keeps-approvals",
    "shell-row",
    "tool-output-live-tail",
    "tool-result-patch",
    "turn-error",
];

const SCREEN_PENDING: &[&str] = &[];

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(dir().join(name)).unwrap_or_else(|_| panic!("{name}: run `pnpm fixtures:golden`"))
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("json")
}

fn diff(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => {}
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => diff(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key}: missing, want {value}")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                out.push(format!("{path}.{key}: unexpected {}", b[key]));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} entries, want {}", b.len(), a.len()));
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{index}]"), x, y, out);
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{path}: got {got}, want {want}")),
    }
}

fn check(suffix: &str, pending: &[&str], want: impl Fn(&str) -> Value, got: impl Fn(&str) -> Value) {
    let mut cases: Vec<String> = std::fs::read_dir(dir())
        .expect("goldens: run `pnpm fixtures:golden`")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(suffix).map(str::to_owned))
        .collect();
    cases.sort();
    assert!(!cases.is_empty(), "no {suffix} goldens");
    let mut failures = Vec::new();
    for case in &cases {
        let mut diffs = Vec::new();
        diff("", &want(case), &got(case), &mut diffs);
        let is_pending = pending.contains(&case.as_str());
        if is_pending && diffs.is_empty() {
            failures.push(format!("{case}: passes now, remove it from the pending list"));
        } else if !is_pending && !diffs.is_empty() {
            diffs.truncate(40);
            failures.push(format!("{case}:\n  {}", diffs.join("\n  ")));
        }
    }
    for case in pending.iter().filter(|case| !cases.iter().any(|c| c == *case)) {
        failures.push(format!("{case}: pending but has no golden"));
    }
    assert!(failures.is_empty(), "{} of {} {suffix} cases drift:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

fn replay(case: &str) -> Engine {
    let mut engine = Engine::default();
    engine.ingest_batch(&read(&format!("{case}.events.jsonl")));
    engine
}

#[test]
fn reducer_matches_typescript_goldens() {
    check(
        ".projection.json",
        PROJECTION_PENDING,
        |case| json(&read(&format!("{case}.projection.json"))),
        |case| project(&replay(case).state),
    );
}

#[test]
fn planner_matches_kit_goldens() {
    let want = |case: &str| {
        let bytes = read(&format!("{case}.lines.jsonl"));
        Value::Array(bytes.split(|&b| b == b'\n').filter(|line| !line.is_empty()).map(json).collect())
    };
    check(".lines.jsonl", LINES_PENDING, want, |case| {
        let mut engine = replay(case);
        engine.layout();
        let lines = engine.rows.rows.iter().flat_map(|row| plan(row, &engine.metrics));
        Value::Array(
            lines
                .map(|line| {
                    let runs: Vec<Value> =
                        line.attributed.unwrap_or_default().iter().map(|&(start, len, intent)| json!([start, len, intent])).collect();
                    let mut value = json!({
                        "tone": line.tone.raw(),
                        "gutterTone": line.gutter_tone.raw(),
                        "gutter": line.gutter,
                        "text": line.text,
                        "runs": runs,
                        "columns": line.columns,
                        "indent": line.indent,
                        "band": line.band.raw(),
                        "bold": line.bold,
                        "italic": line.italic,
                        "nested": line.nested,
                        "pulsing": line.pulsing,
                        "inOpen": line.in_open,
                    });
                    if let Some(since) = line.elapsed_since {
                        value["elapsedSince"] = json!(since);
                    }
                    value
                })
                .collect(),
        )
    });
}

fn color(color: Color) -> u32 {
    match color {
        Color::Default => 0,
        Color::Indexed(index) => 0x0100_0000 | index as u32,
        Color::Rgb(r, g, b) => 0x0200_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
    }
}

#[test]
fn vt_matches_kit_goldens() {
    check(
        ".screen.json",
        SCREEN_PENDING,
        |case| json(&read(&format!("{case}.screen.json"))),
        |case| {
            let input = json(&read(&format!("{case}.vt.json")));
            let mut vt = VtScreen::new(input["cols"].as_u64().unwrap() as usize, input["rows"].as_u64().unwrap() as usize, 1000);
            vt.feed(input["input"].as_str().unwrap());
            let lines: Vec<Value> = (0..vt.total_rows())
                .map(|index| {
                    let mut runs: Vec<(wd_native::vt::Style, String)> = Vec::new();
                    for cell in vt.line(index).iter().filter(|cell| !cell.continuation) {
                        let text = match &cell.text {
                            CellText::None => " ".to_owned(),
                            CellText::Char(c) => c.to_string(),
                            CellText::Cluster(s) => s.to_string(),
                        };
                        match runs.last_mut() {
                            Some((style, run)) if *style == cell.style => run.push_str(&text),
                            _ => runs.push((cell.style, text)),
                        }
                    }
                    Value::Array(
                        runs.into_iter()
                            .map(|(s, text)| {
                                let attrs = s.bold as u8
                                    | (s.dim as u8) << 1
                                    | (s.italic as u8) << 2
                                    | (s.underline as u8) << 3
                                    | (s.inverse as u8) << 4
                                    | (s.strikethrough as u8) << 5
                                    | (s.hidden as u8) << 6;
                                json!({ "fg": color(s.fg), "bg": color(s.bg), "attrs": attrs, "text": text })
                            })
                            .collect(),
                    )
                })
                .collect();
            let (row, col) = vt.cursor();
            let mut screen = json!({
                "cursor": [row, col],
                "cursorVisible": vt.cursor_visible,
                "altScreen": vt.alt_screen_active,
                "bellCount": vt.bell_count,
                "applicationCursorKeys": vt.application_cursor_keys,
                "bracketedPaste": vt.bracketed_paste,
                "sgrMouse": vt.sgr_mouse,
                "focusReporting": vt.focus_reporting,
                "lines": lines,
            });
            if let Some(title) = &vt.title {
                screen["title"] = json!(title);
            }
            screen
        },
    );
}

#[test]
fn every_case_has_its_kit_golden() {
    let names: Vec<String> =
        std::fs::read_dir(dir()).expect("goldens").filter_map(|entry| entry.ok()?.file_name().to_str().map(str::to_owned)).collect();
    let missing: Vec<String> = names
        .iter()
        .filter_map(|name| {
            let wanted = match (name.strip_suffix(".events.jsonl"), name.strip_suffix(".vt.json")) {
                (Some(case), _) => format!("{case}.lines.jsonl"),
                (_, Some(case)) => format!("{case}.screen.json"),
                _ => return None,
            };
            (!names.contains(&wanted)).then_some(wanted)
        })
        .collect();
    assert!(missing.is_empty(), "kit goldens missing, run WD_CONFORMANCE_WRITE=1 swift test --filter Conformance: {missing:?}");
}
