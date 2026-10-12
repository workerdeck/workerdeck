use crate::rows::{Block, ItemBlock, Leaf, Row, RunBlock, task_brief};
use crate::transcript::{Item, ToolCall};
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ExpansionKey {
    Run(String),
    Task(String),
    Call(String),
    Brief(String),
    Shell(String),
    Thinking(String),
}

impl fmt::Display for ExpansionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, id) = match self {
            ExpansionKey::Run(id) => ("run", id),
            ExpansionKey::Task(id) => ("task", id),
            ExpansionKey::Call(id) => ("call", id),
            ExpansionKey::Brief(id) => ("brief", id),
            ExpansionKey::Shell(id) => ("shell", id),
            ExpansionKey::Thinking(id) => ("thinking", id),
        };
        write!(f, "{kind}:{id}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TermPress {
    Toggle(ExpansionKey),
    ExpandFull(String),
    OpenSubagent(String),
    KillShell(String),
    OpenShell(String),
}

impl fmt::Display for TermPress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TermPress::Toggle(key) => write!(f, "toggle:{key}"),
            TermPress::ExpandFull(id) => write!(f, "expandFull:{id}"),
            TermPress::OpenSubagent(id) => write!(f, "openSubagent:{id}"),
            TermPress::KillShell(id) => write!(f, "killShell:{id}"),
            TermPress::OpenShell(id) => write!(f, "openShell:{id}"),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalExpansion {
    pub open: HashSet<ExpansionKey>,
    pub full: HashSet<String>,
    pub pending: HashSet<String>,
}

impl TerminalExpansion {
    pub fn is_empty(&self) -> bool {
        self.open.is_empty() && self.full.is_empty() && self.pending.is_empty()
    }

    pub fn is_open(&self, key: &ExpansionKey) -> bool {
        self.open.contains(key)
    }

    pub fn is_full(&self, call_id: &str) -> bool {
        self.full.contains(call_id)
    }

    pub fn is_fetching(&self, call_id: &str) -> bool {
        self.pending.contains(call_id)
    }

    pub fn begin_fetch(&mut self, call_id: &str) -> bool {
        if self.full.contains(call_id) {
            return false;
        }
        self.pending.insert(call_id.to_owned())
    }

    pub fn abandon_fetch(&mut self, call_id: &str) -> bool {
        self.pending.remove(call_id)
    }

    pub fn finish_fetch(&mut self, call_id: &str) {
        if self.pending.remove(call_id) {
            self.full.insert(call_id.to_owned());
        }
    }

    pub fn apply(&mut self, press: &TermPress, subtree: &HashSet<ExpansionKey>) -> bool {
        match press {
            TermPress::Toggle(key) => {
                if self.open.contains(key) {
                    self.close(key, subtree);
                    return false;
                }
                self.open.insert(key.clone());
                true
            }
            TermPress::ExpandFull(id) => self.full.insert(id.clone()),
            TermPress::OpenSubagent(_) | TermPress::KillShell(_) | TermPress::OpenShell(_) => false,
        }
    }

    fn close(&mut self, key: &ExpansionKey, subtree: &HashSet<ExpansionKey>) {
        let mut closing: HashSet<ExpansionKey> = HashSet::from([key.clone()]);
        if matches!(key, ExpansionKey::Run(_) | ExpansionKey::Task(_)) {
            closing.extend(subtree.iter().cloned());
        }
        for closed in &closing {
            self.open.remove(closed);
            if let ExpansionKey::Call(id) = closed {
                self.full.remove(id);
                self.pending.remove(id);
            }
        }
    }

    pub fn everything(rows: &[Row]) -> Self {
        let mut expansion = TerminalExpansion::default();
        for row in rows {
            match row {
                Row::Brief { id, .. } => {
                    expansion.open.insert(ExpansionKey::Brief(id.clone()));
                }
                Row::Block(block) => {
                    expansion.open.extend(expansion_keys(block));
                    for drawn in block_calls(block, &TerminalExpansion::default()) {
                        if !drawn.draws_result {
                            continue;
                        }
                        let id = drawn.call.id.to_string();
                        if drawn.call.result.as_ref().is_some_and(|result| result.truncated) {
                            expansion.pending.insert(id);
                        } else {
                            expansion.full.insert(id);
                        }
                    }
                }
                Row::Recap { .. } => {}
            }
        }
        expansion
    }

    pub fn subset(&self, row: &Row) -> Self {
        if self.is_empty() {
            return TerminalExpansion::default();
        }
        let block = match row {
            Row::Brief { id, .. } => {
                let key = ExpansionKey::Brief(id.clone());
                let open = if self.open.contains(&key) { HashSet::from([key]) } else { HashSet::new() };
                return TerminalExpansion { open, ..TerminalExpansion::default() };
            }
            Row::Recap { .. } => return TerminalExpansion::default(),
            Row::Block(block) => block,
        };
        let calls = block_calls(block, &TerminalExpansion::default());
        let ids: HashSet<String> = calls.iter().filter(|drawn| drawn.draws_result).map(|drawn| drawn.call.id.to_string()).collect();
        let keys = expansion_keys_with(block, &calls);
        if keys.is_empty() && ids.is_empty() {
            return TerminalExpansion::default();
        }
        TerminalExpansion {
            open: self.open.intersection(&keys).cloned().collect(),
            full: self.full.intersection(&ids).cloned().collect(),
            pending: self.pending.intersection(&ids).cloned().collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockCall {
    pub call: Arc<ToolCall>,
    pub index: usize,
    pub own_line: bool,
    pub draws_result: bool,
}

fn walk_run(run: &RunBlock, container_drawn: bool, expansion: &TerminalExpansion, out: &mut Vec<BlockCall>) {
    let open = run.expansion_key().is_none_or(|key| expansion.is_open(&key));
    let last = run.run.len().saturating_sub(1);
    for (ordinal, call) in run.run.iter().enumerate() {
        let drawn = open || ordinal == last;
        out.push(BlockCall { call: call.clone(), index: run.indices[ordinal], own_line: drawn && container_drawn, draws_result: true });
    }
}

fn walk_item(item: &ItemBlock, container_drawn: bool, out: &mut Vec<BlockCall>) {
    if let Item::ToolCall(call) = &item.item {
        out.push(BlockCall { call: call.clone(), index: item.index, own_line: container_drawn, draws_result: true });
    }
}

pub fn block_calls(block: &Block, expansion: &TerminalExpansion) -> Vec<BlockCall> {
    let mut out = Vec::new();
    match block {
        Block::Item(item) => walk_item(item, true, &mut out),
        Block::Run(run) => walk_run(run, true, expansion, &mut out),
        Block::Task(task) => {
            out.push(BlockCall { call: task.task.clone(), index: task.index, own_line: true, draws_result: false });
            let open = expansion.is_open(&task.expansion_key());
            for child in &task.children {
                match child {
                    Leaf::Item(item) => walk_item(item, open, &mut out),
                    Leaf::Run(run) => walk_run(run, open, expansion, &mut out),
                }
            }
        }
    }
    out
}

pub fn row_expansion_keys(row: &Row) -> HashSet<ExpansionKey> {
    match row {
        Row::Recap { .. } => HashSet::new(),
        Row::Brief { id, .. } => HashSet::from([ExpansionKey::Brief(id.clone())]),
        Row::Block(block) => expansion_keys(block),
    }
}

pub fn expansion_keys(block: &Block) -> HashSet<ExpansionKey> {
    expansion_keys_with(block, &block_calls(block, &TerminalExpansion::default()))
}

fn thinking_key(item: &Item) -> Option<ExpansionKey> {
    match item {
        Item::Thinking { id, addressed: false, .. } => Some(ExpansionKey::Thinking(id.to_string())),
        _ => None,
    }
}

fn expansion_keys_with(block: &Block, calls: &[BlockCall]) -> HashSet<ExpansionKey> {
    let mut keys = HashSet::new();
    match block {
        Block::Item(leaf) => {
            if let Item::Shell(item) = &leaf.item {
                keys.insert(ExpansionKey::Shell(crate::planner::shell::id(item).to_owned()));
            }
            keys.extend(thinking_key(&leaf.item));
        }
        Block::Run(run) => keys.extend(run.expansion_key()),
        Block::Task(task) => {
            keys.insert(task.expansion_key());
            if task_brief(&task.task).is_some() {
                keys.insert(ExpansionKey::Brief(task.task.id.to_string()));
            }
            for child in &task.children {
                match child {
                    Leaf::Run(run) => keys.extend(run.expansion_key()),
                    Leaf::Item(leaf) => keys.extend(thinking_key(&leaf.item)),
                }
            }
        }
    }
    for drawn in calls.iter().filter(|drawn| drawn.draws_result) {
        keys.insert(ExpansionKey::Call(drawn.call.id.to_string()));
    }
    keys
}
