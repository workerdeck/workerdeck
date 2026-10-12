use std::path::Path;
use wd_native::Engine;
use wd_native::book::{HeightBook, PlanCache};
use wd_native::expansion::{ExpansionKey, TerminalExpansion};
use wd_native::planner::{Metrics, plan_with};
use wd_native::rows::{BuildOptions, TerminalRows, parent_tool_use_id, subagent_items, subagent_task};
use wd_native::transcript::Item;

const METRICS: Metrics = Metrics { cell: 19.8, line: 44.0, width: 1080.0, font_size: 32.0 };

fn cases() -> Vec<(String, Vec<Item>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("goldens")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".events.jsonl").map(str::to_owned))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let mut engine = Engine::default();
            engine.ingest_batch(&std::fs::read(dir.join(format!("{name}.events.jsonl"))).expect("events"));
            (name, engine.state.items.clone())
        })
        .collect()
}

fn options(recap_at: Option<usize>) -> BuildOptions<'static> {
    BuildOptions { recap_at, recap_label: "recap", no_fold: false, frame_task: None, hide_thinking: false }
}

fn assert_book(name: &str, rows: &TerminalRows, expansion: &TerminalExpansion, frame: Option<&str>, cache: &mut PlanCache) {
    let cold = HeightBook::with(rows, &METRICS, None, expansion, frame);
    let warm = HeightBook::with(rows, &METRICS, Some(cache), expansion, frame);
    assert_eq!(cold.heights, warm.heights, "{name}: warm cache disagrees with a cold plan");
    for (index, row) in rows.rows.iter().enumerate() {
        let gap = usize::from(rows.gap_before(index));
        let lines = plan_with(row, &METRICS, expansion, frame).len();
        assert_eq!(cold.height(index), (lines + gap) as f64 * METRICS.line, "{name}: row {index} height");
        assert_eq!(cold.row_index_at_offset(cold.offset(index)), index, "{name}: offset lookup {index}");
    }
}

#[test]
fn book_heights_are_planned_heights_in_every_state() {
    let mut checked = 0;
    for (name, items) in cases() {
        let recap = (items.len() >= 4).then_some(items.len() / 2);
        let rows = TerminalRows::build_with(&items, &options(recap));
        let everything = TerminalExpansion::everything(&rows.rows);
        let open_only = TerminalExpansion { open: everything.open.clone(), ..TerminalExpansion::default() };
        let mut cache = PlanCache::new();
        for expansion in [TerminalExpansion::default(), open_only, everything.clone(), TerminalExpansion::default()] {
            assert_book(&name, &rows, &expansion, None, &mut cache);
        }
        let mut keys: Vec<ExpansionKey> = everything.open.iter().cloned().collect();
        keys.sort();
        let mut growing = TerminalExpansion::default();
        for key in keys {
            growing.open.insert(key);
            assert_book(&name, &rows, &growing, None, &mut cache);
        }
        let mut seen = Vec::new();
        for parent in items.iter().filter_map(parent_tool_use_id) {
            if seen.iter().any(|id: &String| id == parent) {
                continue;
            }
            seen.push(parent.to_owned());
            let task = subagent_task(&items, parent);
            let frame =
                TerminalRows::build_with(&subagent_items(&items, parent), &BuildOptions { frame_task: task.as_deref(), ..options(None) });
            let all = TerminalExpansion::everything(&frame.rows);
            for expansion in [TerminalExpansion::default(), all] {
                assert_book(&name, &frame, &expansion, Some(parent), &mut PlanCache::new());
            }
        }
        checked += 1;
    }
    assert!(checked > 40, "only {checked} cases");
}

#[test]
fn eviction_keeps_only_live_rows() {
    let (_, items) = cases().into_iter().find(|(name, _)| name == "tool-runs").expect("tool-runs");
    let rows = TerminalRows::build_with(&items, &options(None));
    let mut cache = PlanCache::new();
    let full = HeightBook::with(&rows, &METRICS, Some(&mut cache), &TerminalExpansion::default(), None);
    let fewer = TerminalRows::build_with(&items[..items.len() / 2], &options(None));
    cache.evict(&fewer);
    let again = HeightBook::with(&rows, &METRICS, Some(&mut cache), &TerminalExpansion::default(), None);
    assert_eq!(full.heights, again.heights);
    let row = &rows.rows[0];
    assert_eq!(
        cache.line_count(row, &METRICS, &TerminalExpansion::default()),
        plan_with(row, &METRICS, &TerminalExpansion::default(), None).len()
    );
}
