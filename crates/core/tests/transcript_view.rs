use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use wd_native::Engine;
use wd_native::book::HeightBook;
use wd_native::controller::transcript::{Effect, Navigation, TranscriptView, Update};
use wd_native::expansion::{ExpansionKey, TermPress};
use wd_native::planner::{Metrics, plan_with};
use wd_native::rows::Row;
use wd_native::transcript::{Item, ShellItem, ToolCallResult};

const METRICS: Metrics = Metrics { cell: 19.8, line: 44.0, width: 1080.0, font_size: 32.0 };
const NOW: f64 = 1_760_000_600_000.0;

fn items(case: &str) -> Vec<Item> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/conformance/{case}.events.jsonl"));
    let mut engine = Engine::default();
    engine.ingest_batch(&std::fs::read(path).expect("events"));
    engine.state.items.clone()
}

fn update(items: &[Item]) -> Update<'_> {
    Update { items, metrics: METRICS, pending_approvals: 0, frame_task: None, hide_thinking: false, now_ms: NOW }
}

fn view(items: &[Item]) -> TranscriptView {
    let mut view = TranscriptView::new(METRICS, None);
    assert!(view.update(update(items)));
    view
}

fn row_of(view: &TranscriptView, key: &str) -> usize {
    view.rows().rows.iter().position(|row| row.key() == key).unwrap_or_else(|| panic!("no row {key}"))
}

fn assert_book_matches(view: &TranscriptView) {
    let cold = HeightBook::with(view.rows(), &METRICS, None, view.expansion(), None);
    assert_eq!(view.book().heights, cold.heights);
    for (index, row) in view.rows().rows.iter().enumerate() {
        assert_eq!(view.plan(index), plan_with(row, &METRICS, &view.expansion().subset(row), None));
    }
}

#[test]
fn unchanged_input_is_not_a_change() {
    let items = items("basic-turn");
    let mut view = view(&items);
    assert!(!view.update(update(&items)));
    assert!(view.update(Update { metrics: Metrics { width: 600.0, ..METRICS }, ..update(&items) }));
    assert!(view.update(update(&items)));
    assert!(view.update(Update { pending_approvals: 1, ..update(&items) }));
}

#[test]
fn toggling_a_call_opens_reveals_and_closes() {
    let items = items("wrapping-wide-text");
    let mut view = view(&items);
    let row = row_of(&view, "run:toolu_long");
    let collapsed = view.book().height(row);
    let press = TermPress::Toggle(ExpansionKey::Call("toolu_long".into()));
    assert!(view.press(&press, row, Navigation::default()).is_empty());
    assert!(view.book().height(row) > collapsed);
    assert_eq!(view.reveal().map(|reveal| reveal.row), Some(row));
    assert_book_matches(&view);
    let reveal = view.reveal();
    view.press(&press, row, Navigation::default());
    assert_eq!(view.book().height(row), collapsed);
    assert_eq!(view.reveal(), reveal);
}

#[test]
fn a_truncated_result_fetches_once_then_lands() {
    let mut items = items("tool-result-truncated-and-images");
    let mut view = view(&items);
    let row = row_of(&view, "run:toolu_big");
    let press = TermPress::ExpandFull("toolu_big".into());
    assert_eq!(view.press(&press, row, Navigation::default()), vec![Effect::FetchResult { call_id: "toolu_big".into() }]);
    assert!(view.expansion().is_fetching("toolu_big"));
    assert!(view.press(&press, row, Navigation::default()).is_empty());
    assert_book_matches(&view);

    for item in &mut items {
        if let Item::ToolCall(call) = item
            && &*call.id == "toolu_big"
        {
            let mut hydrated = (**call).clone();
            hydrated.result = Some(ToolCallResult { truncated: false, text: "the whole log".into(), ..call.result.clone().unwrap() });
            *call = Arc::new(hydrated);
        }
    }
    view.update(update(&items));
    assert!(!view.expansion().is_fetching("toolu_big"));
    assert!(view.expansion().is_full("toolu_big"));
    assert_book_matches(&view);
}

#[test]
fn navigation_presses_become_effects_or_fall_back_to_toggles() {
    let items = items("subagent");
    let mut view = view(&items);
    let row = row_of(&view, "task:toolu_task");
    let press = TermPress::OpenSubagent("toolu_task".into());
    let navigate = Navigation { subagents: true, shells: true };
    assert_eq!(view.press(&press, row, navigate), vec![Effect::OpenSubagent { task_id: "toolu_task".into() }]);
    assert!(view.expansion().is_empty());
    assert!(view.press(&press, row, Navigation::default()).is_empty());
    assert!(view.expansion().is_open(&ExpansionKey::Task("toolu_task".into())));
    assert_book_matches(&view);

    let kill = TermPress::KillShell("sh_abc".into());
    assert_eq!(view.press(&kill, 0, Navigation::default()), vec![Effect::KillShell { shell_id: "sh_abc".into() }]);
    let open = TermPress::OpenShell("sh_abc".into());
    assert_eq!(view.press(&open, 0, navigate), vec![Effect::OpenShell { shell_id: "sh_abc".into() }]);
}

#[test]
fn opening_a_truncated_shell_asks_for_its_output() {
    let shell = |truncated: bool| {
        Item::Shell(Arc::new(ShellItem {
            id: "row-1".into(),
            shell: Arc::new(json!({ "id": "sh_t", "command": "make", "label": "make", "status": "exited", "exitCode": 0 })),
            text: "$ make\nok".into(),
            truncated,
            expanded: None,
            missing: false,
        }))
    };
    let mut view = view(&[shell(true)]);
    let open = TermPress::OpenShell("sh_t".into());
    assert_eq!(view.press(&open, 0, Navigation::default()), vec![Effect::FetchShellOutput { shell_id: "sh_t".into() }]);
    assert!(view.press(&open, 0, Navigation::default()).is_empty());
    let mut plain = view_of(shell(false));
    assert!(plain.press(&open, 0, Navigation::default()).is_empty());
    assert!(plain.expansion().is_open(&ExpansionKey::Shell("sh_t".into())));
}

fn view_of(item: Item) -> TranscriptView {
    view(&[item])
}

#[test]
fn the_recap_row_names_what_happened_and_when() {
    let items = items("tool-runs");
    let mut view = view(&items);
    assert_eq!(view.recap_row(), None);
    view.set_recap(Some(2), Some(NOW - 5.0 * 60_000.0));
    view.update(Update { pending_approvals: 1, ..update(&items) });
    let row = view.recap_row().expect("recap row");
    let Some(Row::Recap { label }) = view.row(row) else { panic!("not a recap row") };
    assert!(label.ends_with(" · last here 5m"), "{label}");
    assert!(label.contains("1 approval waiting"), "{label}");
    view.set_recap(Some(items.len()), None);
    view.update(Update { pending_approvals: 0, ..update(&items) });
    assert_eq!(view.recap_row(), None);
}

#[test]
fn frames_plan_with_their_parent() {
    let items = items("subagent");
    let task = items.iter().find_map(|item| match item {
        Item::ToolCall(call) if &*call.id == "toolu_task" => Some(call.clone()),
        _ => None,
    });
    let frame_items = wd_native::rows::subagent_items(&items, "toolu_task");
    let mut view = TranscriptView::new(METRICS, Some("toolu_task".into()));
    view.update(Update { frame_task: task.as_deref(), ..update(&frame_items) });
    view.expand_everything();
    let cold = HeightBook::with(view.rows(), &METRICS, None, view.expansion(), Some("toolu_task"));
    assert_eq!(view.book().heights, cold.heights);
    assert!(view.plan(0).iter().all(|line| !line.nested));
}
