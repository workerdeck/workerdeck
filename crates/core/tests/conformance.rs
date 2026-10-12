use serde_json::Value;
use std::path::Path;
use wd_native::Engine;
use wd_native::projection::project;

const PENDING: &[&str] =
    &["checklist", "compaction", "conversation-reset", "peer-message", "permission-round-trip", "session-state", "turn-error"];

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

fn run(case: &str, dir: &Path) -> Vec<String> {
    let events = std::fs::read(dir.join(format!("{case}.events.jsonl"))).expect("events");
    let golden: Value =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{case}.projection.json"))).expect("projection")).expect("json");
    let mut engine = Engine::default();
    engine.ingest_batch(&events);
    let mut out = Vec::new();
    diff("", &golden, &project(&engine.state), &mut out);
    out
}

#[test]
fn reducer_matches_typescript_goldens() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance");
    let mut cases: Vec<String> = std::fs::read_dir(&dir)
        .expect("goldens: run `pnpm fixtures:golden`")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".events.jsonl").map(str::to_owned))
        .collect();
    cases.sort();
    assert!(!cases.is_empty(), "no conformance goldens");
    let mut failures = Vec::new();
    for case in &cases {
        let diffs = run(case, &dir);
        let pending = PENDING.contains(&case.as_str());
        if pending && diffs.is_empty() {
            failures.push(format!("{case}: passes now, remove it from PENDING"));
        } else if !pending && !diffs.is_empty() {
            failures.push(format!("{case}:\n  {}", diffs.join("\n  ")));
        }
    }
    for case in PENDING.iter().filter(|case| !cases.iter().any(|c| c == *case)) {
        failures.push(format!("{case}: in PENDING but has no golden"));
    }
    assert!(failures.is_empty(), "{} of {} cases drift:\n{}", failures.len(), cases.len(), failures.join("\n"));
}
