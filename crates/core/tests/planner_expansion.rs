use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use wd_native::Engine;
use wd_native::expansion::{ExpansionKey, TermPress, TerminalExpansion, block_calls, expansion_keys, row_expansion_keys};
use wd_native::planner::{BRIEF_LINES, Metrics, TermLine, glyph, plan, plan_block, plan_with, subagent_strip_line, task_identity};
use wd_native::rows::{
    Block, BuildOptions, ItemBlock, Row, TerminalRows, subagent_items, subagent_task, terminal_blocks, tool_call_item_index,
};
use wd_native::transcript::{Item, ToolCall, ToolCallResult, ToolCallStatus};

const WIDE: Metrics = Metrics { cell: 8.0, line: 18.0, width: 480.0, font_size: 13.0 };
const NARROW: Metrics = Metrics { cell: 8.0, line: 18.0, width: 400.0, font_size: 13.0 };

fn result(text: &str, is_error: bool) -> ToolCallResult {
    ToolCallResult { text: text.into(), is_error, truncated: false, total_chars: None, source_seq: None, images: None }
}

fn tool(id: &str, name: &str, parent: Option<&str>, input: Value, status: ToolCallStatus, result: Option<ToolCallResult>) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        title: None,
        input: Arc::new(input),
        parent_tool_use_id: parent.map(Into::into),
        status,
        result,
        ts: None,
        live_tail: None,
        patch: None,
        execution_id: None,
        backend: None,
        logs: None,
    }
}

fn call(id: &str, name: &str, parent: Option<&str>, output: Option<&str>) -> Item {
    Item::ToolCall(Arc::new(tool(id, name, parent, json!({}), ToolCallStatus::Settled, output.map(|t| result(t, false)))))
}

fn bash(id: &str, output: Option<&str>) -> Item {
    call(id, "Bash", None, output)
}

fn child(id: &str, parent: &str, output: Option<&str>) -> Item {
    call(id, "Bash", Some(parent), output)
}

fn text(id: &str, body: &str) -> Item {
    Item::AssistantText { id: id.into(), text: body.into(), streaming: false, parent_tool_use_id: None }
}

fn nested_text(id: &str, body: &str, parent: &str) -> Item {
    Item::AssistantText { id: id.into(), text: body.into(), streaming: false, parent_tool_use_id: Some(parent.into()) }
}

fn user(id: &str, body: &str, parent: Option<&str>) -> Item {
    Item::User { id: id.into(), text: body.into(), parent_tool_use_id: parent.map(Into::into), attachments: None, origin: None }
}

fn thinking(id: &str, body: &str, parent: &str) -> Item {
    Item::Thinking { id: id.into(), text: body.into(), parent_tool_use_id: Some(parent.into()), addressed: false }
}

fn lines(row: &Row, expansion: &TerminalExpansion) -> Vec<TermLine> {
    plan_with(row, &WIDE, expansion, None)
}

fn toggle(key: ExpansionKey) -> TermPress {
    TermPress::Toggle(key)
}

fn call_key(id: &str) -> ExpansionKey {
    ExpansionKey::Call(id.into())
}

fn none() -> HashSet<ExpansionKey> {
    HashSet::new()
}

fn open(keys: &[ExpansionKey]) -> TerminalExpansion {
    TerminalExpansion { open: keys.iter().cloned().collect(), ..TerminalExpansion::default() }
}

fn run_key(rows: &TerminalRows, index: usize) -> ExpansionKey {
    match &rows.rows[index] {
        Row::Block(Block::Run(run)) => run.expansion_key().expect("a folded run"),
        other => panic!("expected a run, got {other:?}"),
    }
}

#[test]
fn collapsed_is_unchanged() {
    let rows = TerminalRows::build(&[
        text("intro", "hi"),
        bash("a", Some("one\ntwo\nthree\nfour\nfive")),
        bash("b", None),
        bash("c", None),
        call("t", "Task", None, None),
        child("k1", "t", None),
    ]);
    for row in &rows.rows {
        assert_eq!(plan(row, &WIDE), lines(row, &TerminalExpansion::default()));
    }
}

#[test]
fn run_opens_and_closes() {
    let rows = TerminalRows::build(&[bash("a", Some("alpha")), bash("b", Some("beta")), bash("c", Some("gamma"))]);
    let key = run_key(&rows, 0);
    let collapsed = lines(&rows.rows[0], &TerminalExpansion::default());
    assert_eq!(collapsed.len(), 1);
    assert!(collapsed[0].text.contains("Ran 3 shell commands"));
    assert_eq!(collapsed[0].press, Some(toggle(key.clone())));

    let mut expansion = TerminalExpansion::default();
    assert!(expansion.apply(&toggle(key.clone()), &none()));
    let opened = lines(&rows.rows[0], &expansion);
    assert!(opened.len() > collapsed.len());
    assert!(opened.iter().all(|line| line.in_open));
    assert_eq!(opened.iter().filter(|line| line.text.contains("alpha")).count(), 1);
    assert_eq!(opened.iter().filter(|line| line.text.contains("gamma")).count(), 1);
    assert_eq!(opened[0].press, Some(toggle(key.clone())));
    assert!(opened.iter().any(|line| line.press == Some(toggle(call_key("b")))));

    assert!(!expansion.apply(&toggle(key), &none()));
    assert_eq!(lines(&rows.rows[0], &expansion), collapsed);
}

#[test]
fn run_of_one_has_no_own_key() {
    let rows = TerminalRows::build(&[bash("a", Some("x")), text("after", "hi")]);
    let Row::Block(Block::Run(block)) = &rows.rows[0] else { panic!("expected a run block") };
    assert_eq!(block.expansion_key(), None);
    assert_eq!(row_expansion_keys(&rows.rows[0]), HashSet::from([call_key("a")]));
}

#[test]
fn task_opens() {
    let rows = TerminalRows::build(&[call("t", "Task", None, None), child("k1", "t", Some("found it")), nested_text("say", "report", "t")]);
    assert_eq!(rows.len(), 1);
    let Row::Block(Block::Task(block)) = &rows.rows[0] else { panic!("expected a Task row") };
    assert_eq!(lines(&rows.rows[0], &TerminalExpansion::default()).len(), 1);

    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(block.expansion_key()), &none());
    let opened = lines(&rows.rows[0], &expansion);
    assert!(opened.iter().any(|line| line.text.contains("report")));
    assert!(opened[1..].iter().all(|line| line.nested));
    assert!(opened.iter().all(|line| line.in_open));
}

#[test]
fn result_has_three_states() {
    let long: Vec<String> = (1..=400).map(|n| format!("line {n} of the output")).collect();
    let rows = TerminalRows::build(&[bash("a", Some(&long.join("\n"))), text("after", "hi")]);
    let collapsed = lines(&rows.rows[0], &TerminalExpansion::default());
    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(call_key("a")), &none());
    let opened = lines(&rows.rows[0], &expansion);
    expansion.apply(&TermPress::ExpandFull("a".into()), &none());
    let full = lines(&rows.rows[0], &expansion);

    assert!(collapsed.len() < opened.len());
    assert!(opened.len() < full.len());
    assert!(opened.iter().any(|line| line.text.contains("show all")));
    assert_eq!(opened.last().unwrap().press, Some(TermPress::ExpandFull("a".into())));
    assert!(!full.iter().any(|line| line.text.contains("show all")));
    assert!(full.len() >= 400);
}

#[test]
fn closing_forgets_full() {
    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(call_key("a")), &none());
    expansion.apply(&TermPress::ExpandFull("a".into()), &none());
    expansion.apply(&toggle(call_key("a")), &none());
    assert!(expansion.is_empty());
}

#[test]
fn expansion_is_scoped_to_its_row() {
    let rows = TerminalRows::build(&[
        bash("a", Some("alpha")),
        bash("b", Some("beta")),
        text("prose", "hi"),
        bash("c", Some("gamma")),
        bash("d", Some("delta")),
    ]);
    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(run_key(&rows, 0)), &none());
    assert!(!expansion.subset(&rows.rows[0]).is_empty());
    for row in &rows.rows[1..] {
        assert!(expansion.subset(row).is_empty());
    }
    assert!(lines(&rows.rows[0], &expansion).len() > lines(&rows.rows[0], &TerminalExpansion::default()).len());
}

#[test]
fn empty_calls_are_not_pressable() {
    let rows = TerminalRows::build(&[bash("a", None), text("after", "hi")]);
    assert!(lines(&rows.rows[0], &TerminalExpansion::default()).iter().all(|line| line.press.is_none()));
    let with_result = TerminalRows::build(&[bash("b", Some("out")), text("x", "hi")]);
    assert!(lines(&with_result.rows[0], &TerminalExpansion::default()).iter().any(|line| line.press.is_some()));
}

#[test]
fn patch_without_text_never_hides_its_diff() {
    let mut edit = tool("e", "Edit", None, json!({}), ToolCallStatus::Settled, None);
    edit.patch = Some(Arc::new(json!({
        "path": "a.swift",
        "hunks": [{ "oldStart": 0, "oldLines": 1, "newStart": 0, "newLines": 1, "lines": ["-old", "+new"] }],
    })));
    let rows = TerminalRows::build(&[Item::ToolCall(Arc::new(edit)), text("after", "hi")]);
    let collapsed = lines(&rows.rows[0], &TerminalExpansion::default());
    assert_eq!(lines(&rows.rows[0], &TerminalExpansion::everything(&rows.rows)), collapsed);
    assert!(collapsed.iter().any(|line| line.text.contains("new")));
}

fn owned(items: &[Item], expansion: &TerminalExpansion) -> Vec<String> {
    TerminalRows::build(items)
        .rows
        .iter()
        .flat_map(|row| match row {
            Row::Block(block) => block_calls(block, expansion).into_iter().filter(|c| c.own_line).map(|c| c.call.id.to_string()).collect(),
            _ => Vec::new(),
        })
        .collect()
}

#[test]
fn own_line_for_singles() {
    assert_eq!(owned(&[bash("a", Some("x")), text("t", "hi")], &TerminalExpansion::default()), ["a"]);
}

#[test]
fn own_line_for_collapsed_and_open_runs() {
    let run: Vec<Item> = (0..4).map(|n| bash(&format!("c{n}"), Some("x"))).collect();
    assert_eq!(owned(&run, &TerminalExpansion::default()), ["c3"]);
    assert_eq!(owned(&run, &open(&[ExpansionKey::Run("c0".into())])), ["c0", "c1", "c2", "c3"]);
}

#[test]
fn own_line_for_task() {
    let items = [call("T", "Task", None, Some("report")), child("k0", "T", Some("x")), child("k1", "T", Some("x")), text("after", "hi")];
    assert_eq!(owned(&items, &TerminalExpansion::default()), ["T"]);
    assert_eq!(owned(&items, &open(&[ExpansionKey::Task("T".into())])), ["T", "k1"]);
    assert_eq!(owned(&items, &open(&[ExpansionKey::Task("T".into()), ExpansionKey::Run("k0".into())])), ["T", "k0", "k1"]);
}

#[test]
fn own_line_for_orphan() {
    assert_eq!(owned(&[child("k0", "gone", Some("x")), text("t", "hi")], &TerminalExpansion::default()), ["k0"]);
}

#[test]
fn task_header_offers_no_call_key() {
    let rows = TerminalRows::build(&[call("T", "Task", None, Some("report")), child("k0", "T", Some("x")), text("after", "hi")]);
    let Row::Block(block) = &rows.rows[0] else { panic!("expected a task block") };
    let keys = row_expansion_keys(&rows.rows[0]);
    assert!(!keys.contains(&call_key("T")));
    assert!(keys.contains(&ExpansionKey::Task("T".into())));
    assert!(keys.contains(&call_key("k0")));
    assert!(!block_calls(block, &TerminalExpansion::default()).iter().find(|c| &*c.call.id == "T").unwrap().draws_result);
}

#[test]
fn subset_for_a_task_row() {
    let rows = TerminalRows::build(&[call("T", "Task", None, Some("report")), child("k0", "T", Some("x")), text("after", "hi")]);
    let mut expansion = open(&[ExpansionKey::Task("T".into())]);
    expansion.begin_fetch("k0");
    expansion.full.insert("nothing-to-do-with-this-row".into());
    let subset = expansion.subset(&rows.rows[0]);
    assert_eq!(subset.open, HashSet::from([ExpansionKey::Task("T".into())]));
    assert_eq!(subset.pending, HashSet::from(["k0".to_owned()]));
    assert!(subset.full.is_empty());
    assert!(expansion.subset(&rows.rows[1]).is_empty());
}

fn head(id: &str) -> Item {
    let text = "found/a/path\n".repeat(615);
    let result = ToolCallResult { truncated: true, total_chars: Some(641_003), source_seq: Some(2), ..result(&text, false) };
    Item::ToolCall(Arc::new(tool(id, "Bash", None, Value::Null, ToolCallStatus::Settled, Some(result))))
}

#[test]
fn press_enters_pending_and_draws_it() {
    let mut expansion = TerminalExpansion::default();
    assert!(expansion.begin_fetch("t1"));
    assert!(!expansion.begin_fetch("t1"));
    assert!(expansion.is_fetching("t1"));
    assert!(!expansion.is_full("t1"));

    let rows = TerminalRows::build(&[head("t1")]);
    expansion.open.insert(call_key("t1"));
    let planned = lines(&rows.rows[0], &expansion);
    let fetching: Vec<&TermLine> = planned.iter().filter(|line| line.text.contains("fetching")).collect();
    assert!(!fetching.is_empty());
    assert!(fetching.iter().all(|line| line.press.is_none()));
    assert!(fetching.iter().any(|line| line.text.contains("641,003")));
}

#[test]
fn open_offers_the_fetch() {
    let rows = TerminalRows::build(&[head("t1")]);
    let planned = lines(&rows.rows[0], &open(&[call_key("t1")]));
    let offer: Vec<&TermLine> = planned.iter().filter(|line| line.text.contains("fetch the rest")).collect();
    assert!(!offer.is_empty());
    assert!(offer.iter().all(|line| line.press == Some(TermPress::ExpandFull("t1".into()))));
}

#[test]
fn close_forgets_and_arrival_promotes() {
    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(call_key("t1")), &none());
    expansion.begin_fetch("t1");
    expansion.apply(&toggle(call_key("t1")), &none());
    assert!(!expansion.is_fetching("t1"));
    expansion.finish_fetch("t1");
    assert!(!expansion.is_full("t1"));

    let mut waiting = TerminalExpansion::default();
    waiting.begin_fetch("t1");
    waiting.finish_fetch("t1");
    assert!(waiting.is_full("t1"));
    assert!(!waiting.is_fetching("t1"));
}

#[test]
fn everything_puts_heads_in_pending() {
    let whole = Item::ToolCall(Arc::new(tool("t2", "Bash", None, Value::Null, ToolCallStatus::Settled, Some(result("whole", false)))));
    let rows = TerminalRows::build(&[head("t1"), whole]);
    let everything = TerminalExpansion::everything(&rows.rows);
    assert!(everything.pending.contains("t1"));
    assert!(!everything.full.contains("t1"));
    assert!(everything.full.contains("t2"));
}

#[test]
fn subset_carries_pending() {
    let rows = TerminalRows::build(&[head("t1"), text("a", "and then"), head("t2")]);
    let mut expansion = TerminalExpansion::default();
    expansion.begin_fetch("t1");
    assert_eq!(expansion.subset(&rows.rows[0]).pending.len(), 1);
    assert!(expansion.subset(&rows.rows[2]).pending.is_empty());
}

fn run_subtree() -> HashSet<ExpansionKey> {
    HashSet::from([call_key("t1"), call_key("t2"), call_key("t3"), ExpansionKey::Run("t1".into())])
}

fn open_run() -> TerminalExpansion {
    TerminalExpansion {
        open: HashSet::from([ExpansionKey::Run("t1".into()), call_key("t1"), call_key("t2")]),
        full: HashSet::from(["t2".to_owned()]),
        pending: HashSet::from(["t3".to_owned()]),
    }
}

#[test]
fn closing_a_run_closes_its_subtree() {
    let mut expansion = open_run();
    expansion.apply(&toggle(ExpansionKey::Run("t1".into())), &run_subtree());
    assert!(expansion.is_empty());
}

#[test]
fn reopening_a_run_is_clean() {
    let mut expansion = open_run();
    let run = ExpansionKey::Run("t1".into());
    expansion.apply(&toggle(run.clone()), &run_subtree());
    expansion.apply(&toggle(run.clone()), &run_subtree());
    assert!(expansion.is_open(&run));
    assert!(!expansion.is_open(&call_key("t1")));
    assert!(!expansion.is_open(&call_key("t2")));
    assert!(!expansion.is_full("t2"));
    assert!(!expansion.is_fetching("t3"));
}

#[test]
fn closing_one_call_keeps_its_siblings() {
    let mut expansion = open_run();
    expansion.apply(&toggle(call_key("t1")), &run_subtree());
    assert!(expansion.is_open(&ExpansionKey::Run("t1".into())));
    assert!(!expansion.is_open(&call_key("t1")));
    assert!(expansion.is_open(&call_key("t2")));
    assert!(expansion.is_full("t2"));
}

#[test]
fn opening_takes_nothing_with_it() {
    let mut expansion = TerminalExpansion::default();
    let run = ExpansionKey::Run("t1".into());
    assert!(expansion.apply(&toggle(run.clone()), &run_subtree()));
    assert_eq!(expansion.open, HashSet::from([run]));
}

fn task_call(id: &str, agent: Option<&str>, description: Option<&str>, status: ToolCallStatus) -> ToolCall {
    let mut input = serde_json::Map::new();
    if let Some(agent) = agent {
        input.insert("subagent_type".into(), json!(agent));
    }
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    tool(id, "Task", None, Value::Object(input), status, None)
}

fn explore(id: &str) -> Item {
    Item::ToolCall(Arc::new(task_call(id, Some("Explore"), Some("find the tests"), ToolCallStatus::Settled)))
}

fn ids(items: &[Item]) -> Vec<&str> {
    items.iter().map(Item::id).collect()
}

#[test]
fn frame_membership() {
    let items = [
        user("u1", "go", None),
        explore("T1"),
        explore("T2"),
        user("b1", "brief for one", Some("T1")),
        user("b2", "brief for two", Some("T2")),
        thinking("th1", "hm", "T1"),
        child("c1", "T1", Some("")),
        child("c2", "T2", Some("")),
        nested_text("r1", "report", "T1"),
        text("main", "meanwhile"),
    ];
    assert_eq!(ids(&subagent_items(&items, "T1")), ["b1", "th1", "c1", "r1"]);
}

#[test]
fn streaming_item_is_frame_member() {
    let mut engine = Engine::default();
    engine.ingest_line(br#"{"type":"event","event":{"type":"stream_delta","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Half a "}},"parentToolUseId":"T1","uuid":"s1","seq":1,"ts":0}}"#);
    let frame = subagent_items(&engine.state.items, "T1");
    assert_eq!(frame.len(), 1);
    let Item::AssistantText { id, text, streaming, parent_tool_use_id } = &frame[0] else { panic!("expected the in-flight text") };
    assert_eq!(&**id, "streaming:T1");
    assert_eq!(&**text, "Half a ");
    assert!(*streaming);
    assert_eq!(parent_tool_use_id.as_deref(), Some("T1"));
    assert!(subagent_items(&engine.state.items, "T2").is_empty());
}

#[test]
fn frame_slice_folds() {
    let frame =
        [user("b1", "brief", Some("T1")), child("c1", "T1", Some("")), child("c2", "T1", Some("")), nested_text("r1", "report", "T1")];
    let blocks = terminal_blocks(&frame, 0, true);
    assert_eq!(blocks.len(), 3);
    let Block::Run(run) = &blocks[1] else { panic!("expected a run") };
    assert_eq!(run.run.iter().map(|c| &*c.id).collect::<Vec<_>>(), ["c1", "c2"]);
}

#[test]
fn task_identity_names_and_falls_back() {
    let settled = ToolCallStatus::Settled;
    assert_eq!(task_identity(&task_call("T1", Some("Explore"), Some("find the tests"), settled)), "Explore · find the tests");
    assert_eq!(task_identity(&task_call("T1", Some("Explore"), None, settled)), "Explore");
    assert_eq!(task_identity(&task_call("T1", None, Some("find the tests"), settled)), "find the tests");
    assert_eq!(task_identity(&task_call("T1", Some("  "), Some("find the tests"), settled)), "find the tests");
    assert_eq!(task_identity(&task_call("T1", Some("Explore"), Some("  \n"), settled)), "Explore");
    let long = "x".repeat(120);
    assert_eq!(task_identity(&task_call("T1", Some("Explore"), Some(&long), settled)), format!("Explore · {}…", "x".repeat(79)));
}

fn first_task(items: &[Item]) -> Block {
    let block = terminal_blocks(items, 0, true).into_iter().next().unwrap();
    assert!(matches!(block, Block::Task(_)), "expected a task");
    block
}

#[test]
fn collapsed_task_press_opens_subagent() {
    let block = first_task(&[explore("T1"), user("b1", "brief", Some("T1")), child("c1", "T1", Some(""))]);
    let lines = plan_block(&block, &NARROW, &TerminalExpansion::default(), false, None);
    assert!(!lines.is_empty());
    assert!(lines.iter().all(|line| line.press == Some(TermPress::OpenSubagent("T1".into()))));
}

#[test]
fn open_task_header_press() {
    let block = first_task(&[explore("T1"), child("c1", "T1", Some("output"))]);
    let lines = plan_block(&block, &NARROW, &open(&[ExpansionKey::Task("T1".into())]), false, None);
    assert_eq!(lines[0].press, Some(TermPress::OpenSubagent("T1".into())));
    assert!(lines.iter().any(|line| line.press == Some(toggle(call_key("c1")))));
}

#[test]
fn frame_nesting() {
    let own = Row::Block(Block::Item(ItemBlock { key: "assistantText:r1".into(), item: nested_text("r1", "report", "T1"), index: 0 }));
    let other = Row::Block(Block::Item(ItemBlock { key: "assistantText:r2".into(), item: nested_text("r2", "aside", "T9"), index: 1 }));
    let none = TerminalExpansion::default();
    assert!(plan_with(&own, &NARROW, &none, Some("T1")).iter().all(|line| !line.nested));
    assert!(plan_with(&other, &NARROW, &none, Some("T1")).iter().all(|line| line.nested));
    assert!(plan(&own, &NARROW).iter().all(|line| line.nested));
}

#[test]
fn strip_claims_what_the_task_row_claims() {
    let running = task_call("T1", Some("Explore"), Some("find the tests"), ToolCallStatus::Running);
    let children = [
        child("c1", "T1", Some("")),
        Item::ToolCall(Arc::new(tool("c2", "Bash", Some("T1"), json!({}), ToolCallStatus::Running, Some(result("", false))))),
    ];
    let live = subagent_strip_line(Some(&running), &children, "Sub-agent");
    assert_eq!(live.name, "Explore · find the tests");
    assert_eq!(live.status, Some("working…"));
    assert!(live.busy);
    assert_eq!(live.tool_count, 2);
    assert_eq!(live.text().as_deref(), Some("working… · 2 tools"));

    let settled_task = task_call("T1", Some("Explore"), Some("find the tests"), ToolCallStatus::Settled);
    let settled = subagent_strip_line(Some(&settled_task), &[child("c1", "T1", Some(""))], "Sub-agent");
    assert_eq!(settled.status, Some("done"));
    assert!(!settled.busy);

    let mut failed_task = settled_task.clone();
    failed_task.result = Some(result("boom", true));
    let failed = subagent_strip_line(Some(&failed_task), &[], "Sub-agent");
    assert_eq!(failed.status, Some("failed"));
    assert_eq!(failed.text().as_deref(), Some("failed"));
    assert!(failed.failed);

    let fallback = subagent_strip_line(None, &[], "Explore");
    assert_eq!(fallback.name, "Explore");
    assert_eq!(fallback.status, None);
    assert_eq!(fallback.text(), None);
    assert!(!fallback.busy && !fallback.failed);
}

#[test]
fn reveal_finds_the_call() {
    let items = [user("u1", "go", None), explore("T1"), child("c1", "T1", Some("")), bash("c2", Some(""))];
    assert_eq!(tool_call_item_index(&items, "T1"), Some(1));
    assert_eq!(tool_call_item_index(&items, "c1"), Some(2));
    assert_eq!(tool_call_item_index(&items, "c2"), Some(3));
    assert_eq!(tool_call_item_index(&items, "nope"), None);
    assert_eq!(tool_call_item_index(&[], "c1"), None);
}

fn prompted(id: &str, prompt: Option<&str>) -> ToolCall {
    let mut input = json!({ "subagent_type": "Explore", "description": "find the tests" });
    if let Some(prompt) = prompt {
        input["prompt"] = json!(prompt);
    }
    tool(id, "Task", None, input, ToolCallStatus::Running, None)
}

fn frame_items() -> Vec<Item> {
    vec![thinking("th1", "hm", "T1"), child("c1", "T1", Some("")), nested_text("r1", "report", "T1")]
}

fn framed(items: &[Item], task: &ToolCall) -> TerminalRows {
    TerminalRows::build_with(items, &BuildOptions { frame_task: Some(task), ..BuildOptions::default() })
}

fn brief(text: &str) -> Row {
    Row::Brief { id: "T1".into(), text: text.into() }
}

fn has_brief(rows: &TerminalRows) -> bool {
    rows.rows.iter().any(|row| matches!(row, Row::Brief { .. }))
}

#[test]
fn brief_leads_frame() {
    let rows = framed(&frame_items(), &prompted("T1", Some("dig in")));
    assert_eq!(rows.len(), 4);
    assert_eq!(rows.rows[0], brief("dig in"));
    assert_eq!(rows.rows[0].key(), "brief:T1");
    assert!(rows.gap_before(1));
}

#[test]
fn stream_brief_wins() {
    let forwarded = [user("b1", "dig in", Some("T1")), child("c1", "T1", Some(""))];
    let rows = framed(&forwarded, &prompted("T1", Some("dig in")));
    assert!(!has_brief(&rows));
    assert_eq!(rows.len(), 2);
    assert_eq!(framed(&frame_items(), &prompted("T1", Some("dig in"))).rows[0], brief("dig in"));
}

#[test]
fn no_prompt_no_row() {
    let bare = framed(&frame_items(), &prompted("T1", None));
    assert_eq!(bare.len(), 3);
    assert!(!has_brief(&bare));
    assert_eq!(framed(&frame_items(), &prompted("T1", Some("  \n "))).len(), 3);
}

#[test]
fn brief_leads_inline_expansion() {
    let block = first_task(&[Item::ToolCall(Arc::new(prompted("T1", Some("dig in")))), child("c1", "T1", Some(""))]);
    let collapsed = plan_block(&block, &NARROW, &TerminalExpansion::default(), false, None);
    assert!(!collapsed.iter().any(|line| line.gutter == glyph::PROMPT));

    let opened = plan_block(&block, &NARROW, &open(&[ExpansionKey::Task("T1".into())]), false, None);
    assert_eq!(opened[0].press, Some(TermPress::OpenSubagent("T1".into())));
    assert_eq!(opened[1].gutter, glyph::PROMPT);
    assert_eq!(opened[1].text, "dig in");
    assert!(opened[1].nested);
    assert!(opened.len() > 2);

    let bare = first_task(&[Item::ToolCall(Arc::new(prompted("T2", None))), child("c2", "T2", Some(""))]);
    let bare_open = plan_block(&bare, &NARROW, &open(&[ExpansionKey::Task("T2".into())]), false, None);
    assert!(!bare_open.iter().any(|line| line.gutter == glyph::PROMPT));
}

#[test]
fn brief_clip_boundary() {
    let cols = 48;
    let fits = plan(&brief(&"x".repeat(BRIEF_LINES * cols)), &NARROW);
    assert_eq!(fits.len(), BRIEF_LINES);
    assert!(fits.iter().all(|line| line.press.is_none()));

    let over = plan(&brief(&"x".repeat(BRIEF_LINES * cols + 1)), &NARROW);
    assert_eq!(over.len(), BRIEF_LINES + 1);
    assert_eq!(over.last().unwrap().text, "… +1 line");
    assert!(over.iter().all(|line| line.press == Some(toggle(ExpansionKey::Brief("T1".into())))));
}

#[test]
fn brief_affordance_counts_hidden_lines() {
    let lines = plan(&brief(&"x".repeat(300)), &NARROW);
    assert_eq!(lines.len(), BRIEF_LINES + 1);
    assert_eq!(lines.last().unwrap().text, "… +3 lines");
    assert_eq!(lines[0].gutter, glyph::PROMPT);
    assert!(lines[1].gutter.is_empty());
}

#[test]
fn open_brief_shows_everything() {
    let key = ExpansionKey::Brief("T1".into());
    let lines = plan_with(&brief(&"x".repeat(300)), &NARROW, &open(std::slice::from_ref(&key)), None);
    assert_eq!(lines.len(), 7);
    assert!(!lines.iter().any(|line| line.text.starts_with('…')));
    assert!(lines.iter().all(|line| line.press == Some(toggle(key.clone())) && line.in_open));
}

#[test]
fn brief_interior_blank_lines() {
    let lines = plan(&brief("first\n\nsecond"), &NARROW);
    assert_eq!(lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>(), ["first", " ", "second"]);
}

#[test]
fn brief_toggle_subset_is_its_row() {
    let rows = framed(&frame_items(), &prompted("T1", Some(&"x".repeat(300))));
    let mut expansion = TerminalExpansion::default();
    let key = ExpansionKey::Brief("T1".into());
    expansion.apply(&toggle(key.clone()), &HashSet::from([key.clone()]));
    assert_eq!(expansion.subset(&rows.rows[0]), open(&[key]));
    for row in &rows.rows[1..] {
        assert!(expansion.subset(row).is_empty());
    }
}

#[test]
fn inline_brief_toggle_scoped() {
    let rows = TerminalRows::build(&[
        user("u1", "go", None),
        Item::ToolCall(Arc::new(prompted("T1", Some(&"x".repeat(300))))),
        child("c1", "T1", Some("")),
        text("a1", "done"),
    ]);
    assert_eq!(rows.len(), 3);
    let mut expansion = open(&[ExpansionKey::Task("T1".into())]);
    let task_row = rows.rows.iter().position(|row| row.key() == "task:T1").unwrap();
    let row = &rows.rows[task_row];
    let collapsed_brief = plan_with(row, &NARROW, &expansion.subset(row), None);
    expansion.apply(&toggle(ExpansionKey::Brief("T1".into())), &row_expansion_keys(row));
    let open_brief = plan_with(row, &NARROW, &expansion.subset(row), None);
    assert_eq!(open_brief.len() - collapsed_brief.len(), 7 - (BRIEF_LINES + 1));
    assert!(expansion.subset(&rows.rows[0]).is_empty());
    assert!(expansion.subset(&rows.rows[2]).is_empty());
}

#[test]
fn brief_close_semantics() {
    let block = first_task(&[Item::ToolCall(Arc::new(prompted("T1", Some(&"x".repeat(300))))), child("c1", "T1", Some("out"))]);
    let subtree = expansion_keys(&block);
    let brief = ExpansionKey::Brief("T1".into());
    let task = ExpansionKey::Task("T1".into());
    assert!(subtree.contains(&brief));

    let mut expansion = TerminalExpansion::default();
    expansion.apply(&toggle(task.clone()), &subtree);
    expansion.apply(&toggle(brief.clone()), &subtree);
    expansion.apply(&toggle(call_key("c1")), &subtree);
    expansion.apply(&toggle(brief.clone()), &subtree);
    assert!(!expansion.is_open(&brief));
    assert!(expansion.is_open(&call_key("c1")));
    expansion.apply(&toggle(brief.clone()), &subtree);
    expansion.apply(&toggle(task), &subtree);
    assert!(!expansion.is_open(&brief));
    assert!(!expansion.is_open(&call_key("c1")));
}

#[test]
fn everything_opens_brief() {
    let frame = framed(&frame_items(), &prompted("T1", Some(&"x".repeat(300))));
    assert!(TerminalExpansion::everything(&frame.rows).is_open(&ExpansionKey::Brief("T1".into())));
    let inline = TerminalRows::build(&[Item::ToolCall(Arc::new(prompted("T2", Some("dig in")))), child("c1", "T2", Some(""))]);
    assert!(TerminalExpansion::everything(&inline.rows).is_open(&ExpansionKey::Brief("T2".into())));
    let bare = TerminalRows::build(&[Item::ToolCall(Arc::new(prompted("T3", None))), child("c2", "T3", Some(""))]);
    assert!(!TerminalExpansion::everything(&bare.rows).open.contains(&ExpansionKey::Brief("T3".into())));
}

#[test]
fn subagent_task_finds_the_spawning_call() {
    let spawning = prompted("T1", Some("dig in"));
    let mut items = vec![Item::ToolCall(Arc::new(spawning.clone()))];
    items.extend(frame_items());
    assert_eq!(subagent_task(&items, "T1").as_deref(), Some(&spawning));
    assert_eq!(subagent_task(&items, "T9"), None);
    assert!(subagent_items(&items, "T1").iter().all(|item| item.id() != "T1"));
}
