// A transcript row's long-press menu, the iOS kit's `TranscriptRow.bookmarkItemId` / `copyText` /
// `backgroundableCallId` and the web `ToolRow` copy rule. The row is the unit of address: a folded row bookmarks its
// head item, and a run summary or task header copies nothing rather than a concatenation.
use crate::planner::peer_send_text;
use crate::rows::{Block, Row, is_peer_send};
use crate::transcript::{Item, ToolCall, ToolCallStatus};
use serde_json::Value;

const BACKGROUNDABLE: [&str; 3] = ["Bash", "Task", "Agent"];

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RowMenu {
    pub bookmark_item_id: Option<String>,
    pub copy_text: Option<String>,
    pub background_call_id: Option<String>,
}

impl RowMenu {
    pub fn is_empty(&self) -> bool {
        self.bookmark_item_id.is_none() && self.copy_text.is_none() && self.background_call_id.is_none()
    }
}

// `can_background` is the session's `backgroundTasks` capability; without it the menu never offers the move.
pub fn row_menu(row: &Row, can_background: bool) -> RowMenu {
    RowMenu {
        bookmark_item_id: bookmark_item_id(row),
        copy_text: copy_text(row),
        background_call_id: if can_background { backgroundable_call_id(row) } else { None },
    }
}

pub fn bookmark_item_id(row: &Row) -> Option<String> {
    match row {
        Row::Block(Block::Item(leaf)) => Some(leaf.item.id().to_owned()),
        Row::Block(Block::Run(leaf)) => leaf.run.first().map(|call| call.id.to_string()),
        Row::Block(Block::Task(leaf)) => Some(leaf.task.id.to_string()),
        Row::Recap { .. } | Row::Brief { .. } => None,
    }
}

pub fn copy_text(row: &Row) -> Option<String> {
    match row {
        Row::Brief { text, .. } => Some(text.clone()),
        Row::Recap { .. } => None,
        Row::Block(Block::Item(leaf)) => item_copy_text(&leaf.item),
        Row::Block(Block::Run(leaf)) => match leaf.run.as_slice() {
            [call] => call_copy_text(call),
            _ => None,
        },
        Row::Block(Block::Task(_)) => None,
    }
}

pub fn backgroundable_call_id(row: &Row) -> Option<String> {
    let call = match row {
        Row::Block(Block::Item(leaf)) => match &leaf.item {
            Item::ToolCall(call) => call,
            _ => return None,
        },
        Row::Block(Block::Run(leaf)) => match leaf.run.as_slice() {
            [call] => call,
            _ => return None,
        },
        Row::Block(Block::Task(leaf)) => &leaf.task,
        Row::Recap { .. } | Row::Brief { .. } => return None,
    };
    can_background(call).then(|| call.id.to_string())
}

pub fn can_background(call: &ToolCall) -> bool {
    BACKGROUNDABLE.contains(&&*call.name)
        && call.parent_tool_use_id.is_none()
        && matches!(call.status, ToolCallStatus::Running | ToolCallStatus::Pending)
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

fn item_copy_text(item: &Item) -> Option<String> {
    match item {
        Item::User { text, .. } | Item::Thinking { text, .. } | Item::Notice { text, .. } => non_empty(text),
        Item::AssistantText { text, streaming, .. } => {
            if *streaming {
                None
            } else {
                non_empty(text)
            }
        }
        Item::ToolCall(call) => call_copy_text(call),
        Item::FileDelivered { path, .. } => Some(path.to_string()),
        Item::TurnResult { .. } | Item::Compaction(_) => None,
        Item::Shell(shell) => shell.shell.get("command").and_then(Value::as_str).and_then(non_empty),
    }
}

fn call_copy_text(call: &ToolCall) -> Option<String> {
    if is_peer_send(call) {
        return non_empty(peer_send_text(call));
    }
    if let Some(command) = call.input.get("command").and_then(Value::as_str) {
        return Some(command.to_owned());
    }
    call.result.as_ref().and_then(|result| non_empty(&result.text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rows::{ItemBlock, RunBlock, TaskBlock};
    use crate::transcript::{ShellItem, ToolCallResult};
    use serde_json::json;
    use std::sync::Arc;

    fn call(id: &str, name: &str, input: Value, status: ToolCallStatus) -> Arc<ToolCall> {
        Arc::new(ToolCall {
            id: id.into(),
            name: name.into(),
            title: None,
            input: Arc::new(input),
            parent_tool_use_id: None,
            status,
            result: None,
            ts: None,
            live_tail: None,
            patch: None,
            execution_id: None,
            backend: None,
            logs: None,
        })
    }

    fn item_row(item: Item) -> Row {
        Row::Block(Block::Item(ItemBlock { key: "k".into(), item, index: 0 }))
    }

    fn run_row(calls: Vec<Arc<ToolCall>>) -> Row {
        let indices = (0..calls.len()).collect();
        Row::Block(Block::Run(RunBlock { key: "run".into(), run: calls, indices, index: 0 }))
    }

    #[test]
    fn a_run_bookmarks_its_head_and_copies_only_as_a_single_call() {
        let a = call("a", "Bash", json!({ "command": "ls" }), ToolCallStatus::Settled);
        let b = call("b", "Read", json!({ "file_path": "x" }), ToolCallStatus::Settled);
        let one = run_row(vec![a.clone()]);
        assert_eq!(bookmark_item_id(&one).as_deref(), Some("a"));
        assert_eq!(copy_text(&one).as_deref(), Some("ls"));
        let two = run_row(vec![a, b]);
        assert_eq!(bookmark_item_id(&two).as_deref(), Some("a"));
        assert_eq!(copy_text(&two), None);
    }

    #[test]
    fn copy_takes_the_source_never_the_drawing() {
        let mut settled = (*call("c", "Read", json!({ "file_path": "x" }), ToolCallStatus::Settled)).clone();
        settled.result = Some(ToolCallResult {
            text: "body".into(),
            is_error: false,
            truncated: false,
            total_chars: None,
            source_seq: None,
            images: None,
        });
        assert_eq!(copy_text(&item_row(Item::ToolCall(Arc::new(settled)))).as_deref(), Some("body"));
        let streaming = Item::AssistantText { id: "t".into(), text: "half".into(), streaming: true, parent_tool_use_id: None };
        assert_eq!(copy_text(&item_row(streaming)), None);
        let peer = call("p", "mcp__workerdeck__peers_send", json!({ "to": "x", "text": "hello" }), ToolCallStatus::Settled);
        assert_eq!(copy_text(&run_row(vec![peer])).as_deref(), Some("hello"));
        let shell = Item::Shell(Arc::new(ShellItem {
            id: "s".into(),
            shell: Arc::new(json!({ "command": "make" })),
            text: "out".into(),
            truncated: false,
            expanded: None,
            missing: false,
        }));
        assert_eq!(copy_text(&item_row(shell)).as_deref(), Some("make"));
        assert_eq!(copy_text(&Row::Brief { id: "b".into(), text: "brief".into() }).as_deref(), Some("brief"));
        assert_eq!(bookmark_item_id(&Row::Brief { id: "b".into(), text: "brief".into() }), None);
        assert!(row_menu(&Row::Recap { label: "x".into() }, true).is_empty());
    }

    #[test]
    fn only_a_running_top_level_bash_or_agent_moves_to_the_background() {
        let running = run_row(vec![call("r", "Bash", json!({ "command": "sleep 9" }), ToolCallStatus::Running)]);
        assert_eq!(row_menu(&running, true).background_call_id.as_deref(), Some("r"));
        assert_eq!(row_menu(&running, false).background_call_id, None);
        let done = run_row(vec![call("d", "Bash", json!({}), ToolCallStatus::Settled)]);
        assert_eq!(backgroundable_call_id(&done), None);
        let read = run_row(vec![call("e", "Read", json!({}), ToolCallStatus::Running)]);
        assert_eq!(backgroundable_call_id(&read), None);
        let mut nested = (*call("n", "Bash", json!({}), ToolCallStatus::Running)).clone();
        nested.parent_tool_use_id = Some("t".into());
        assert_eq!(backgroundable_call_id(&run_row(vec![Arc::new(nested)])), None);
        let task = Row::Block(Block::Task(TaskBlock {
            key: "task:t".into(),
            task: call("t", "Agent", json!({}), ToolCallStatus::Running),
            children: vec![],
            child_indices: vec![],
            index: 0,
        }));
        assert_eq!(backgroundable_call_id(&task).as_deref(), Some("t"));
        assert_eq!(copy_text(&task), None);
    }
}
