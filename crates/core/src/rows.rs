use crate::transcript::{Item, ItemKind, Str, ToolCall};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct ItemBlock {
    pub key: String,
    pub item: Item,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunBlock {
    pub key: String,
    pub run: Vec<Arc<ToolCall>>,
    pub indices: Vec<usize>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Leaf {
    Item(ItemBlock),
    Run(RunBlock),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskBlock {
    pub key: String,
    pub task: Arc<ToolCall>,
    pub children: Vec<Leaf>,
    pub child_indices: Vec<usize>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Item(ItemBlock),
    Run(RunBlock),
    Task(TaskBlock),
}

impl Row {
    pub fn key(&self) -> &str {
        match self {
            Row::Item(b) => &b.key,
            Row::Run(b) => &b.key,
            Row::Task(b) => &b.key,
        }
    }

    pub fn index(&self) -> usize {
        match self {
            Row::Item(b) => b.index,
            Row::Run(b) => b.index,
            Row::Task(b) => b.index,
        }
    }

    fn spacing(&self) -> (ItemKind, bool) {
        match self {
            Row::Item(b) => (b.item.kind(), is_peer_send_item(&b.item)),
            Row::Run(b) => (ItemKind::ToolCall, b.run.first().is_some_and(|c| is_peer_send(c))),
            Row::Task(b) => (ItemKind::ToolCall, is_peer_send(&b.task)),
        }
    }
}

pub fn is_peer_send(call: &ToolCall) -> bool {
    matches!(&*call.name, "peers_send" | "mcp__workerdeck__peers_send")
}

fn is_peer_send_item(item: &Item) -> bool {
    matches!(item, Item::ToolCall(c) if is_peer_send(c))
}

fn folds_together(a: &ToolCall, b: &ToolCall) -> bool {
    if is_peer_send(a) || is_peer_send(b) {
        return false;
    }
    a.parent_tool_use_id == b.parent_tool_use_id
}

fn item_key(item: &Item) -> String {
    let kind = item.kind().raw();
    let id = item.id();
    let mut key = String::with_capacity(kind.len() + 1 + id.len());
    key.push_str(kind);
    key.push(':');
    key.push_str(id);
    key
}

fn push_leaf(out: &mut Vec<Row>, item: &Item, index: usize) {
    if let Item::ToolCall(call) = item
        && !is_peer_send(call)
    {
        if let Some(Row::Run(previous)) = out.last_mut()
            && folds_together(&previous.run[0], call)
        {
            previous.run.push(call.clone());
            previous.indices.push(index);
            return;
        }
        out.push(Row::Run(RunBlock {
            key: format!("run:{}", call.id),
            run: vec![call.clone()],
            indices: vec![index],
            index,
        }));
        return;
    }
    out.push(Row::Item(ItemBlock {
        key: item_key(item),
        item: item.clone(),
        index,
    }));
}

pub fn terminal_blocks(items: &[Item], offset: usize) -> Vec<Row> {
    let mut top_level: HashSet<&str> = HashSet::new();
    for item in items {
        if let Item::ToolCall(call) = item
            && call.parent_tool_use_id.is_none()
        {
            top_level.insert(&call.id);
        }
    }
    let mut children_of: HashMap<Str, Vec<(Item, usize)>> = HashMap::new();
    for (position, item) in items.iter().enumerate() {
        let Some(parent) = item.parent_tool_use_id() else {
            continue;
        };
        if !top_level.contains(&**parent) {
            continue;
        }
        children_of
            .entry(parent.clone())
            .or_default()
            .push((item.clone(), offset + position));
    }

    let mut out: Vec<Row> = Vec::with_capacity(items.len());
    for (position, item) in items.iter().enumerate() {
        let index = offset + position;
        if let Some(parent) = item.parent_tool_use_id()
            && children_of.contains_key(parent)
        {
            continue;
        }
        if let Item::ToolCall(call) = item
            && let Some(children) = children_of.get(&call.id)
        {
            let mut nested: Vec<Row> = Vec::new();
            for (child, child_index) in children {
                push_leaf(&mut nested, child, *child_index);
            }
            let leaves = nested
                .into_iter()
                .map(|b| match b {
                    Row::Item(l) => Leaf::Item(l),
                    Row::Run(l) => Leaf::Run(l),
                    Row::Task(l) => Leaf::Item(ItemBlock {
                        key: l.key,
                        item: Item::ToolCall(l.task),
                        index: l.index,
                    }),
                })
                .collect();
            out.push(Row::Task(TaskBlock {
                key: format!("task:{}", call.id),
                task: call.clone(),
                children: leaves,
                child_indices: children.iter().map(|c| c.1).collect(),
                index,
            }));
            continue;
        }
        push_leaf(&mut out, item, index);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowPosition {
    pub ordinal: usize,
    pub count: usize,
}

pub struct TerminalRows {
    pub rows: Vec<Row>,
    pub absorbed: HashMap<usize, usize>,
    pub positions: HashMap<usize, RowPosition>,
    pub starts: Vec<usize>,
    pub answerable: Vec<bool>,
}

impl TerminalRows {
    pub fn new(rows: Vec<Row>) -> Self {
        let mut absorbed = HashMap::new();
        let mut positions = HashMap::new();
        for (row_index, row) in rows.iter().enumerate() {
            match row {
                Row::Task(task) => {
                    for (ordinal, &child) in task.child_indices.iter().enumerate() {
                        absorbed.insert(child, row_index);
                        positions.insert(
                            child,
                            RowPosition {
                                ordinal,
                                count: task.child_indices.len(),
                            },
                        );
                    }
                }
                Row::Run(run) if run.run.len() > 1 => {
                    for (ordinal, &member) in run.indices.iter().enumerate() {
                        positions.insert(
                            member,
                            RowPosition {
                                ordinal,
                                count: run.run.len(),
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        let mut starts = vec![0usize; rows.len()];
        let answerable = vec![true; rows.len()];
        for (i, row) in rows.iter().enumerate().rev() {
            starts[i] = row.index();
        }
        TerminalRows {
            rows,
            absorbed,
            positions,
            starts,
            answerable,
        }
    }

    pub fn build(items: &[Item]) -> Self {
        TerminalRows::new(terminal_blocks(items, 0))
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn gap_before(&self, index: usize) -> bool {
        if index == 0 || index >= self.rows.len() {
            return false;
        }
        let (bk, bp) = self.rows[index - 1].spacing();
        let (ak, ap) = self.rows[index].spacing();
        if bp || ap {
            return true;
        }
        !(bk == ItemKind::ToolCall && ak == ItemKind::ToolCall)
    }
}
