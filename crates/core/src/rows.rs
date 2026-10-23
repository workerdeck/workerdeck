use crate::expansion::ExpansionKey;
use crate::transcript::{Item, ItemKind, Str, ToolCall};
use std::borrow::Cow;
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
pub enum Block {
    Item(ItemBlock),
    Run(RunBlock),
    Task(TaskBlock),
}

impl RunBlock {
    pub fn expansion_key(&self) -> Option<ExpansionKey> {
        if self.run.len() > 1 { self.run.first().map(|call| ExpansionKey::Run(call.id.to_string())) } else { None }
    }
}

impl TaskBlock {
    pub fn expansion_key(&self) -> ExpansionKey {
        ExpansionKey::Task(self.task.id.to_string())
    }
}

impl Leaf {
    fn spacing(&self) -> Option<(ItemKind, bool)> {
        match self {
            Leaf::Item(b) => Some((b.item.kind(), is_peer_send_item(&b.item))),
            Leaf::Run(b) => b.run.first().map(|c| (ItemKind::ToolCall, is_peer_send(c))),
        }
    }
}

impl Block {
    pub fn key(&self) -> &str {
        match self {
            Block::Item(b) => &b.key,
            Block::Run(b) => &b.key,
            Block::Task(b) => &b.key,
        }
    }

    pub fn index(&self) -> usize {
        match self {
            Block::Item(b) => b.index,
            Block::Run(b) => b.index,
            Block::Task(b) => b.index,
        }
    }

    fn spacing(&self) -> Option<(ItemKind, bool)> {
        match self {
            Block::Item(b) => Some((b.item.kind(), is_peer_send_item(&b.item))),
            Block::Run(b) => b.run.first().map(|c| (ItemKind::ToolCall, is_peer_send(c))),
            Block::Task(b) => Some((ItemKind::ToolCall, is_peer_send(&b.task))),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Block(Block),
    Recap { label: String },
    Brief { id: String, text: String },
}

impl Row {
    pub fn key(&self) -> Cow<'_, str> {
        match self {
            Row::Block(block) => Cow::Borrowed(block.key()),
            Row::Recap { .. } => Cow::Borrowed("recap"),
            Row::Brief { id, .. } => Cow::Owned(format!("brief:{id}")),
        }
    }

    pub fn recap_label(&self) -> Option<&str> {
        match self {
            Row::Recap { label } => Some(label),
            _ => None,
        }
    }

    fn spacing(&self) -> Option<(ItemKind, bool)> {
        match self {
            Row::Block(block) => block.spacing(),
            Row::Recap { .. } | Row::Brief { .. } => None,
        }
    }
}

fn needs_blank(before: Option<(ItemKind, bool)>, after: Option<(ItemKind, bool)>) -> bool {
    let (Some((bk, bp)), Some((ak, ap))) = (before, after) else {
        return true;
    };
    if bp || ap {
        return true;
    }
    !(bk == ItemKind::ToolCall && ak == ItemKind::ToolCall)
}

pub fn leaf_needs_blank(previous: &Leaf, next: &Leaf) -> bool {
    needs_blank(previous.spacing(), next.spacing())
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

fn push_leaf(out: &mut Vec<Block>, item: &Item, index: usize) {
    if let Item::ToolCall(call) = item
        && !is_peer_send(call)
    {
        if let Some(Block::Run(previous)) = out.last_mut()
            && folds_together(&previous.run[0], call)
        {
            previous.run.push(call.clone());
            previous.indices.push(index);
            return;
        }
        out.push(Block::Run(RunBlock { key: format!("run:{}", call.id), run: vec![call.clone()], indices: vec![index], index }));
        return;
    }
    out.push(Block::Item(ItemBlock { key: item_key(item), item: item.clone(), index }));
}

pub fn terminal_blocks(items: &[Item], offset: usize, fold: bool) -> Vec<Block> {
    terminal_blocks_skipping(items, offset, fold, |_| false)
}

// `skip` drops an item before grouping, so a run of calls it sat between still folds into one; indices stay the item's own.
pub fn terminal_blocks_skipping(items: &[Item], offset: usize, fold: bool, skip: impl Fn(&Item) -> bool) -> Vec<Block> {
    if !fold {
        return items
            .iter()
            .enumerate()
            .filter(|(_, item)| !skip(item))
            .map(|(position, item)| Block::Item(ItemBlock { key: item_key(item), item: item.clone(), index: offset + position }))
            .collect();
    }
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
        if !top_level.contains(&**parent) || skip(item) {
            continue;
        }
        children_of.entry(parent.clone()).or_default().push((item.clone(), offset + position));
    }

    let mut out: Vec<Block> = Vec::with_capacity(items.len());
    for (position, item) in items.iter().enumerate() {
        let index = offset + position;
        if skip(item) {
            continue;
        }
        if let Some(parent) = item.parent_tool_use_id()
            && children_of.contains_key(parent)
        {
            continue;
        }
        if let Item::ToolCall(call) = item
            && let Some(children) = children_of.get(&call.id)
        {
            let mut nested: Vec<Block> = Vec::new();
            for (child, child_index) in children {
                push_leaf(&mut nested, child, *child_index);
            }
            let leaves = nested
                .into_iter()
                .map(|b| match b {
                    Block::Item(l) => Leaf::Item(l),
                    Block::Run(l) => Leaf::Run(l),
                    Block::Task(l) => Leaf::Item(ItemBlock { key: l.key, item: Item::ToolCall(l.task), index: l.index }),
                })
                .collect();
            out.push(Block::Task(TaskBlock {
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

pub fn task_child_items(block: &TaskBlock) -> Vec<Item> {
    block
        .children
        .iter()
        .flat_map(|leaf| match leaf {
            Leaf::Item(c) => vec![c.item.clone()],
            Leaf::Run(c) => c.run.iter().map(|call| Item::ToolCall(call.clone())).collect(),
        })
        .collect()
}

pub fn task_brief(task: &ToolCall) -> Option<String> {
    let text = task.input.get("prompt")?.as_str()?.trim();
    if text.is_empty() { None } else { Some(text.to_owned()) }
}

pub fn parent_tool_use_id(item: &Item) -> Option<&str> {
    item.parent_tool_use_id().map(|parent| &**parent)
}

pub fn subagent_items(items: &[Item], parent: &str) -> Vec<Item> {
    items.iter().filter(|item| parent_tool_use_id(item) == Some(parent)).cloned().collect()
}

pub fn subagent_task(items: &[Item], id: &str) -> Option<Arc<ToolCall>> {
    items.iter().find_map(|item| match item {
        Item::ToolCall(call) if &*call.id == id => Some(call.clone()),
        _ => None,
    })
}

pub fn tool_call_item_index(items: &[Item], id: &str) -> Option<usize> {
    items.iter().position(|item| matches!(item, Item::ToolCall(call) if &*call.id == id))
}

pub fn is_hidden_thinking(block: &Block) -> bool {
    matches!(block, Block::Item(ItemBlock { item, .. }) if is_hidden_thinking_item(item))
}

pub fn is_hidden_thinking_item(item: &Item) -> bool {
    matches!(item, Item::Thinking { addressed: false, .. })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowPosition {
    pub ordinal: usize,
    pub count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BuildOptions<'a> {
    pub recap_at: Option<usize>,
    pub recap_label: &'a str,
    pub no_fold: bool,
    pub frame_task: Option<&'a ToolCall>,
    pub hide_thinking: bool,
}

pub struct TerminalRows {
    pub rows: Vec<Row>,
    absorbed: HashMap<usize, usize>,
    positions: HashMap<usize, RowPosition>,
    starts: Vec<usize>,
    answerable: Vec<bool>,
}

impl TerminalRows {
    pub fn new(rows: Vec<Row>) -> Self {
        let mut absorbed = HashMap::new();
        let mut positions = HashMap::new();
        for (row_index, row) in rows.iter().enumerate() {
            match row {
                Row::Block(Block::Task(task)) => {
                    for (ordinal, &child) in task.child_indices.iter().enumerate() {
                        absorbed.insert(child, row_index);
                        positions.insert(child, RowPosition { ordinal, count: task.child_indices.len() });
                    }
                }
                Row::Block(Block::Run(run)) if run.run.len() > 1 => {
                    for (ordinal, &member) in run.indices.iter().enumerate() {
                        positions.insert(member, RowPosition { ordinal, count: run.run.len() });
                    }
                }
                _ => {}
            }
        }
        let mut starts = vec![0usize; rows.len()];
        let mut answerable = vec![false; rows.len()];
        let mut successor = usize::MAX;
        for (i, row) in rows.iter().enumerate().rev() {
            if let Row::Block(block) = row {
                starts[i] = block.index();
                answerable[i] = true;
                successor = block.index();
            } else {
                starts[i] = successor;
            }
        }
        TerminalRows { rows, absorbed, positions, starts, answerable }
    }

    pub fn build(items: &[Item]) -> Self {
        Self::build_with(items, &BuildOptions::default())
    }

    pub fn build_with(items: &[Item], options: &BuildOptions) -> Self {
        let blocks = |slice: &[Item], offset: usize| -> Vec<Row> {
            terminal_blocks_skipping(slice, offset, !options.no_fold, |item| options.hide_thinking && is_hidden_thinking_item(item))
                .into_iter()
                .map(Row::Block)
                .collect()
        };
        let stream_has_brief = items.iter().any(|item| matches!(item, Item::User { .. }));
        let mut rows: Vec<Row> = Vec::new();
        if !stream_has_brief
            && let Some(task) = options.frame_task
            && let Some(text) = task_brief(task)
        {
            rows.push(Row::Brief { id: task.id.to_string(), text });
        }
        match options.recap_at {
            Some(boundary) if boundary > 0 && boundary < items.len() => {
                rows.extend(blocks(&items[..boundary], 0));
                rows.push(Row::Recap { label: options.recap_label.to_owned() });
                rows.extend(blocks(&items[boundary..], boundary));
            }
            _ => rows.extend(blocks(items, 0)),
        }
        TerminalRows::new(rows)
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn row_index_for_item(&self, item_index: usize) -> usize {
        if let Some(&row) = self.absorbed.get(&item_index) {
            return row;
        }
        let (mut low, mut high, mut best) = (0isize, self.rows.len() as isize - 1, 0usize);
        while low <= high {
            let mid = ((low + high) / 2) as usize;
            if self.starts[mid] <= item_index {
                if self.answerable[mid] {
                    best = mid;
                }
                low = mid as isize + 1;
            } else {
                high = mid as isize - 1;
            }
        }
        best
    }

    pub fn position(&self, item_index: usize) -> Option<RowPosition> {
        self.positions.get(&item_index).copied()
    }

    pub fn recap_row(&self) -> Option<usize> {
        self.rows.iter().position(|row| matches!(row, Row::Recap { .. }))
    }

    pub fn prompt_rows(&self) -> Vec<usize> {
        let is_prompt = |row: &Row| {
            matches!(
                row,
                Row::Block(Block::Item(block))
                    if matches!(&block.item, Item::User { parent_tool_use_id: None, origin: None, .. })
            )
        };
        self.rows.iter().enumerate().filter(|(_, row)| is_prompt(row)).map(|(index, _)| index).collect()
    }

    pub fn gap_before(&self, index: usize) -> bool {
        if index == 0 || index >= self.rows.len() {
            return false;
        }
        needs_blank(self.rows[index - 1].spacing(), self.rows[index].spacing())
    }
}
